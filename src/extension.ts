import * as vscode from "vscode";
import { scanClaudeSessions, type ClaudeSession } from "./claudeScanner";
import { readConfig, type AgentMonitorConfig } from "./config";
import { Dashboard, dashboardViewType } from "./dashboard";
import { ReviewState } from "./reviewState";
import { scanAgents } from "./scanner";
import type { AgentScan, AgentSession } from "./types";

let config: AgentMonitorConfig;

export function activate(context: vscode.ExtensionContext): void {
  config = readConfig();
  const output = vscode.window.createOutputChannel("Agent Monitor");
  const reviewState = new ReviewState(context);
  const dashboard = new Dashboard(context, reviewState, () => config, output);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
  statusBarItem.command = "agentMonitor.openDashboard";
  const notifier = new DoneNotifier(reviewState, () => config, dashboard, statusBarItem, output);

  context.subscriptions.push(
    output,
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
  private claudeInitialized = false;
  private lastStatusById = new Map<string, string>();
  private lastClaudeStatusById = new Map<string, string>();
  private polling = false;

  constructor(
    private readonly reviewState: ReviewState,
    private readonly getConfig: () => AgentMonitorConfig,
    private readonly dashboard: Dashboard,
    private readonly statusBarItem: vscode.StatusBarItem,
    private readonly output: vscode.OutputChannel
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
      let scan = await scanAgents(cfg, this.reviewState.getReviewed());
      this.logDiagnostics(scan);
      const runningReviewedIds = scan.sessions
        .filter((session) => session.status === "running" && session.reviewedAt)
        .map((session) => session.id);
      if (runningReviewedIds.length > 0) {
        await this.reviewState.markUnreviewed(runningReviewedIds);
        scan = await scanAgents(cfg, this.reviewState.getReviewed());
        this.logDiagnostics(scan);
      }
      const claudeSessions = await scanClaudeSessions(cfg.claudeHome, this.reviewState.getReviewed());
      this.updateStatusBar(scan.sessions, claudeSessions);
      if (cfg.notifyOnDone) {
        await this.notifyTransitions(scan.sessions);
        await this.notifyClaudeTransitions(claudeSessions);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[${new Date().toISOString()}] ERROR notifier poll failed: ${messageText}`);
    } finally {
      this.polling = false;
    }
  }

  private updateStatusBar(sessions: AgentSession[], claudeSessions: ClaudeSession[]): void {
    const total = sessions.length + claudeSessions.length;
    const counts = {
      running:
        sessions.filter((session) => session.status === "running").length +
        claudeSessions.filter((session) => session.status === "running").length,
      needsApproval:
        sessions.filter((session) => session.status === "needs-approval").length +
        claudeSessions.filter((session) => session.status === "needs-input").length,
      done:
        sessions.filter((session) => session.status === "done-review").length +
        claudeSessions.filter((session) => session.status === "idle").length,
      reviewed:
        sessions.filter((session) => session.status === "reviewed").length +
        claudeSessions.filter((session) => session.status === "reviewed").length,
      archived:
        sessions.filter((session) => session.status === "archived").length +
        claudeSessions.filter((session) => session.status === "archived").length,
      unknown: sessions.filter((session) => session.status === "unknown").length
    };
    this.statusBarItem.text =
      counts.needsApproval > 0
        ? `$(alert) ${counts.needsApproval} · $(hubot) ${counts.done}/${total}`
        : `$(hubot) ${counts.done}/${total}`;
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
        doneNotificationText(session),
        "Open Monitor",
        "Open Agent"
      );

      if (choice === "Open Monitor") {
        this.dashboard.open();
      }

      if (choice === "Open Agent") {
        this.dashboard.openAgent(session.id);
      }
    }
  }

  private async notifyClaudeTransitions(sessions: ClaudeSession[]): Promise<void> {
    const nextStatusById = new Map<string, string>();

    for (const session of sessions) {
      nextStatusById.set(session.id, session.status);
      const previousStatus = this.lastClaudeStatusById.get(session.id);
      if (this.claudeInitialized && previousStatus !== "needs-input" && session.status === "needs-input") {
        const choice = await vscode.window.showWarningMessage(
          `Approval needed: ${session.name}`,
          "Open Monitor",
          "Open Agent",
          "Approve",
          "Always Approve"
        );

        if (choice === "Open Monitor") {
          this.dashboard.open();
        }

        if (choice === "Open Agent") {
          this.dashboard.openClaudeAgent(session.id);
        }

        if (choice === "Approve") {
          await this.dashboard.approveClaudeSession(session.id);
        }

        if (choice === "Always Approve") {
          await this.dashboard.alwaysApproveClaudeSession(session.id);
        }
      }
    }

    this.lastClaudeStatusById = nextStatusById;
    this.claudeInitialized = true;
  }

  private logDiagnostics(scan: AgentScan): void {
    if (scan.diagnostics.length === 0) {
      return;
    }

    const stamp = new Date().toISOString();
    for (const item of scan.diagnostics) {
      this.output.appendLine(`[${stamp}] ${item.level.toUpperCase()} ${item.source}: ${item.message}`);
    }
  }
}

function approvalNotificationText(session: AgentSession): string {
  const lines = [`Approval needed: ${session.name}`];
  if (session.approvalReason) {
    lines.push(`Reason: ${truncate(session.approvalReason, 160)}`);
  }
  if (session.approvalCommand) {
    lines.push(`Command: ${truncate(session.approvalCommand, 220)}`);
  }
  return lines.join("\n");
}

function doneNotificationText(session: AgentSession): string {
  const lines = [`Agent finished: ${session.name}`];
  if (session.lastMessage) {
    lines.push(truncate(session.lastMessage, 180));
  }
  const usage = formatRunUsage(session);
  if (usage) {
    lines.push(`Run usage: ${usage}`);
  }
  return lines.join("\n");
}

function formatRunUsage(session: AgentSession): string | undefined {
  const usage = session.usage;
  const tokens = usage?.lastUserTurnTokenUsage?.totalTokens ?? usage?.lastTokenUsage?.totalTokens;
  const primary = usage?.lastPrimaryDeltaPercent;
  const secondary = usage?.lastSecondaryDeltaPercent;
  const parts = [
    tokens !== undefined ? `${formatCompactNumber(tokens)} tokens` : "",
    primary !== undefined ? `5h +${formatPercent(primary)}` : "",
    secondary !== undefined ? `7d +${formatPercent(secondary)}` : ""
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  const units = [
    { suffix: "g", value: 1_000_000_000 },
    { suffix: "m", value: 1_000_000 },
    { suffix: "k", value: 1_000 }
  ];
  const unit = units.find((item) => abs >= item.value);
  if (!unit) {
    return String(value);
  }

  const compact = value / unit.value;
  const formatted = compact >= 100 ? compact.toFixed(0) : compact >= 10 ? compact.toFixed(1) : compact.toFixed(2);
  return `${formatted.replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")}${unit.suffix}`;
}

function formatPercent(value: number): string {
  return value < 1 && value > 0 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}
