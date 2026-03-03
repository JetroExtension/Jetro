#!/usr/bin/env node
/**
 * Jetro Daemon — keeps refresh bindings alive when VS Code is closed.
 *
 * Usage:
 *   node daemon.js start   # Start daemon (detaches from terminal)
 *   node daemon.js stop    # Stop running daemon
 *   node daemon.js status  # Check daemon status
 *
 * Environment:
 *   JET_WORKSPACE — workspace root (default: cwd)
 *   JET_JWT       — auth token for backend API calls
 */

import * as fs from "fs";
import * as path from "path";
import { BindingRunner } from "./bindingRunner";
import { ShareUploader } from "./shareUploader";

const API_URL = process.env.JET_API_URL || "http://localhost:8787";
const WORKSPACE = process.env.JET_WORKSPACE || process.cwd();
const JWT = process.env.JET_JWT || "";
const DAEMON_DIR = path.join(WORKSPACE, ".jetro", "daemon");
const PID_FILE = path.join(DAEMON_DIR, "daemon.pid");
const LOG_FILE = path.join(DAEMON_DIR, "daemon.log");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* log file may not exist yet */ }
}

async function start(): Promise<void> {
  ensureDir(DAEMON_DIR);

  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8"));
      process.kill(pid, 0); // Check if alive
      console.log(`Daemon already running (PID: ${pid})`);
      process.exit(0);
    } catch {
      // PID file exists but process is dead — clean up
      fs.unlinkSync(PID_FILE);
    }
  }

  if (!JWT) {
    console.error("Error: JET_JWT environment variable is required");
    process.exit(1);
  }

  // Write PID file
  fs.writeFileSync(PID_FILE, String(process.pid));
  log(`Daemon started (PID: ${process.pid}, workspace: ${WORKSPACE})`);

  // Initialize components
  const uploader = new ShareUploader(WORKSPACE, API_URL, JWT);
  const runner = new BindingRunner(WORKSPACE, uploader, JWT, API_URL);

  // Start
  await uploader.start();
  await runner.scanAndStart();
  runner.watchForChanges();

  log(`Running with ${runner.getActiveCount()} active bindings`);

  // Graceful shutdown
  const shutdown = () => {
    log("Shutting down...");
    runner.shutdown();
    uploader.shutdown();
    try {
      fs.unlinkSync(PID_FILE);
    } catch { /* already cleaned up */ }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep alive — the setIntervals in runner/uploader keep the event loop active
}

function stop(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.log("Daemon is not running");
    process.exit(0);
  }

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8"));
    process.kill(pid, "SIGTERM");
    console.log(`Stopped daemon (PID: ${pid})`);
  } catch (err) {
    console.log("Daemon is not running (stale PID file)");
    try {
      fs.unlinkSync(PID_FILE);
    } catch { /* already cleaned up */ }
  }
}

function status(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.log(JSON.stringify({ running: false }));
    process.exit(0);
  }

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8"));
    process.kill(pid, 0); // Check if alive

    // Read last few log lines
    let lastLog = "";
    if (fs.existsSync(LOG_FILE)) {
      const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n");
      lastLog = lines.slice(-3).join("\n");
    }

    console.log(
      JSON.stringify({
        running: true,
        pid,
        workspace: WORKSPACE,
        lastLog,
      })
    );
  } catch {
    console.log(JSON.stringify({ running: false, stale: true }));
    try {
      fs.unlinkSync(PID_FILE);
    } catch { /* already cleaned up */ }
  }
}

// ── CLI ──

const command = process.argv[2];

switch (command) {
  case "start":
    start().catch((err) => {
      console.error(`Daemon failed to start: ${err}`);
      process.exit(1);
    });
    break;
  case "stop":
    stop();
    break;
  case "status":
    status();
    break;
  default:
    console.log("Usage: node daemon.js start|stop|status");
    process.exit(1);
}
