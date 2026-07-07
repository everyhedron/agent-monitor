import * as vscode from "vscode";
import { readConfig, type AgentMonitorConfig } from "./config";
import { Dashboard, dashboardViewType } from "./dashboard";
import { ReviewState } from "./reviewState";
import { scanAgents } from "./scanner";
import type { AgentSession } from "./types";

let config: AgentMonitorConfig;

export function activate(context: vscode.ExtensionContext): void {
  config = readConfig();
  const reviewState = new ReviewState(context);
  const dashboard = new Dashboard(context, reviewState, () => config);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
  statusBarItem.command = "agentMonitor.openDashboard";
  const notifier = new DoneNotifier(reviewState, () => config, dashboard, statusBarItem);

  context.subscriptions.push(
    dashboard,
    notifier,
    statusBarItem,
    vscode.window.registerWebviewPanelSerializer(dashboardViewType, {
      async deserializeWebviewPanel(panel) {
        dashboard.restore(panel);
      }
    }),
    vscode.commands.registerCommand("agentMonitor.openDashboard", () => dashboard.open()),
    vscode.commands.registerCommand("agentMonitor.refresh", () => {
      void dashboard.refresh();
      void notifier.poll();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agentMonitor")) {
        config = readConfig();
        dashboard.restartTimer();
        notifier.restart();
        void dashboard.refresh();
      }
    })
  );

  if (config.openOnStartup) {
    setTimeout(() => {
      if (!dashboard.hasPanel()) {
        dashboard.open(config.pinOnStartup);
      }
    }, 1000);
  }

  notifier.start();
}

export function deactivate(): void {}

class DoneNotifier {
  private timer: NodeJS.Timeout | undefined;
  private initialized = false;
  private lastStatusById = new Map<string, string>();
  private polling = false;

  constructor(
    private readonly reviewState: ReviewState,
    private readonly getConfig: () => AgentMonitorConfig,
    private readonly dashboard: Dashboard,
    private readonly statusBarItem: vscode.StatusBarItem
  ) {}

  start(): void {
    this.restart();
    void this.poll();
  }

  restart(): void {
    this.stop();
    this.timer = setInterval(() => void this.poll(), this.getConfig().refreshIntervalMs);
  }

  dispose(): void {
    this.stop();
  }

  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }

    this.polling = true;
    try {
      const cfg = this.getConfig();
      const scan = await scanAgents(cfg, this.reviewState.getReviewed());
      this.updateStatusBar(scan.sessions);
      if (cfg.notifyOnDone) {
        await this.notifyTransitions(scan.sessions);
      }
    } finally {
      this.polling = false;
    }
  }

  private updateStatusBar(sessions: AgentSession[]): void {
    const total = sessions.length;
    const counts = {
      running: sessions.filter((session) => session.status === "running").length,
      needsApproval: sessions.filter((session) => session.status === "needs-approval").length,
      done: sessions.filter((session) => session.status === "done-review").length,
      reviewed: sessions.filter((session) => session.status === "reviewed").length,
      archived: sessions.filter((session) => session.status === "archived").length,
      unknown: sessions.filter((session) => session.status === "unknown").length
    };
    const needsAttention = counts.needsApproval + counts.done;

    this.statusBarItem.text = `$(hubot) ${needsAttention}/${total}`;
    this.statusBarItem.tooltip = [
      "Agent Monitor",
      `Needs approval: ${counts.needsApproval}`,
      `Needs review: ${counts.done}`,
      `Running: ${counts.running}`,
      `Reviewed: ${counts.reviewed}`,
      `Archived: ${counts.archived}`,
      `Unknown: ${counts.unknown}`
    ].join("\n");
    this.statusBarItem.show();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async notifyTransitions(sessions: AgentSession[]): Promise<void> {
    const nextStatusById = new Map<string, string>();
    const completed: AgentSession[] = [];

    for (const session of sessions) {
      nextStatusById.set(session.id, session.status);
      const previousStatus = this.lastStatusById.get(session.id);
      if (this.initialized && previousStatus === "running" && session.status === "done-review") {
        completed.push(session);
      }
      if (this.initialized && previousStatus !== "needs-approval" && session.status === "needs-approval") {
        const choice = await vscode.window.showWarningMessage(
          approvalNotificationText(session),
          "Open Monitor",
          "Open Agent",
          "Approve",
          "Always Approve"
        );

        if (choice === "Open Monitor") {
          this.dashboard.open();
        }

        if (choice === "Open Agent") {
          this.dashboard.openAgent(session.id);
        }

        if (choice === "Approve") {
          this.dashboard.sendApproval(session.id, "y");
        }

        if (choice === "Always Approve") {
          this.dashboard.sendApproval(session.id, "p");
        }
      }
    }

    this.lastStatusById = nextStatusById;
    this.initialized = true;

    for (const session of completed) {
      const choice = await vscode.window.showInformationMessage(
        `Agent finished: ${session.name}`,
        "Open Monitor",
        "Mark Reviewed"
      );

      if (choice === "Open Monitor") {
        this.dashboard.open();
      }

      if (choice === "Mark Reviewed") {
        await this.reviewState.markReviewed([session.id]);
        await this.dashboard.refresh();
      }
    }
  }
}

function approvalNotificationText(session: AgentSession): string {
  const reason = session.approvalReason ? `\n\nReason: ${session.approvalReason}` : "";
  const command = session.approvalCommand ? `\n\n$ ${session.approvalCommand}` : "";
  return `Agent needs approval: ${session.name}${reason}${command}`;
}
