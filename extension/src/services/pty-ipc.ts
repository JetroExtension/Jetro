/**
 * IPC protocol types for communication between PtyManager (parent)
 * and pty-server.js (child process).
 */

// ── Parent → Child ──

export interface PtyInputMessage { type: "input"; data: string }
export interface PtyResizeMessage { type: "resize"; cols: number; rows: number }
export interface PtyKillMessage { type: "kill" }

export type PtyParentMessage = PtyInputMessage | PtyResizeMessage | PtyKillMessage;

// ── Child → Parent ──

export interface PtyOutputMessage { type: "output"; data: string }
export interface PtyReadyMessage { type: "ready"; pid: number }
export interface PtyExitMessage { type: "exit"; code: number }
export interface PtyErrorMessage { type: "error"; message: string }

export type PtyChildMessage = PtyOutputMessage | PtyReadyMessage | PtyExitMessage | PtyErrorMessage;
