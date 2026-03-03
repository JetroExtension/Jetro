import * as vscode from "vscode";

export class StatusBar {
  private brandItem: vscode.StatusBarItem;
  private connectionItem: vscode.StatusBarItem;
  private modeItem: vscode.StatusBarItem;
  private canvasItem: vscode.StatusBarItem;
  private liveServerItem: vscode.StatusBarItem;
  private daemonItem: vscode.StatusBarItem;
  private c2Item: vscode.StatusBarItem;

  constructor() {
    // Left side items
    this.brandItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.connectionItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99
    );
    this.daemonItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      98
    );
    this.daemonItem.command = "jetro.toggleGlobalPause";
    this.modeItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      97
    );

    // Right side
    this.c2Item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      -99
    );
    this.canvasItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      -100
    );
    this.liveServerItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      -101
    );
  }

  show(): void {
    this.brandItem.text = "$(symbol-misc) Jetro";
    this.brandItem.tooltip = "Jetro";
    this.brandItem.show();

    this.connectionItem.text = "$(sync~spin) Connecting...";
    this.connectionItem.tooltip = "Jetro connection status";
    this.connectionItem.show();

    this.canvasItem.hide();
    this.liveServerItem.hide();
  }

  setConnected(): void {
    this.connectionItem.text = "$(check) Connected";
  }

  setDisconnected(): void {
    this.connectionItem.text = "$(error) Disconnected";
  }

  setFinanceEnabled(_enabled: boolean): void {
    this.modeItem.hide(); // mode item no longer used
  }

  setCanvasInfo(name: string, elementCount: number): void {
    this.canvasItem.text = `${name} · ${elementCount} elements`;
    this.canvasItem.show();
  }

  hideCanvas(): void {
    this.canvasItem.hide();
  }

  setLiveServer(port: number): void {
    this.liveServerItem.text = `$(broadcast) Live: localhost:${port}`;
    this.liveServerItem.tooltip = "Jetro Live Preview Server running";
    this.liveServerItem.show();
  }

  hideLiveServer(): void {
    this.liveServerItem.hide();
  }

  setC2Info(wireCount: number, connectedFrames: number): void {
    this.c2Item.text = `$(radio-tower) C2: ${wireCount} wire${wireCount === 1 ? "" : "s"} | ${connectedFrames} frames`;
    this.c2Item.tooltip = `C2 Mode Active — ${wireCount} wire${wireCount === 1 ? "" : "s"}, ${connectedFrames} connected frame${connectedFrames === 1 ? "" : "s"}`;
    this.c2Item.show();
  }

  hideC2(): void {
    this.c2Item.hide();
  }

  setDaemonStatus(activeCount: number, paused: boolean): void {
    if (paused) {
      this.daemonItem.text = "$(debug-pause) Paused";
      this.daemonItem.tooltip = "All refresh bindings paused — click to resume";
      this.daemonItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else if (activeCount > 0) {
      this.daemonItem.text = `$(sync~spin) ${activeCount} binding${activeCount === 1 ? "" : "s"}`;
      this.daemonItem.tooltip = `${activeCount} active refresh binding${activeCount === 1 ? "" : "s"} — click to pause all`;
      this.daemonItem.backgroundColor = undefined;
    } else {
      this.daemonItem.text = "$(sync) Idle";
      this.daemonItem.tooltip = "No active refresh bindings";
      this.daemonItem.backgroundColor = undefined;
    }
    this.daemonItem.show();
  }

  dispose(): void {
    this.brandItem.dispose();
    this.connectionItem.dispose();
    this.modeItem.dispose();
    this.canvasItem.dispose();
    this.liveServerItem.dispose();
    this.daemonItem.dispose();
    this.c2Item.dispose();
  }
}
