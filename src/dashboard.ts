import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";
import * as vscode from "vscode";
import {
  archiveClaudeTranscript,
  deleteClaudeTranscript,
  findClaudeUsageProbeSessionId,
  findLatestClaudeUsageSnapshot,
  parseClaudeUsageText,
  scanClaudeSessions,
  unarchiveClaudeTranscript,
  type ClaudeSession,
  type ClaudeSessionStatus
} from "./claudeScanner";
import { fetchCodexUsage, type CodexManualUsage } from "./codexUsage";
import { updateAgentMonitorOptions, type AgentMonitorConfig } from "./config";
import { ReviewState } from "./reviewState";
import { archiveTranscript, deleteArchivedTranscript, scanAgents, unarchiveTranscript } from "./scanner";
import type { AgentScan, AgentSession, AgentStatus } from "./types";

export const dashboardViewType = "agentMonitor.dashboard";

const execFileAsync = promisify(execFile);

type DashboardMessage = {
  command?: string;
  sessionId?: string;
  sessionIds?: string[];
  path?: string;
  setting?: "autoCompactOnReview";
  value?: boolean;
};

type ClaudeUsageSummary = {
  sessionPercent?: number;
  sessionResets?: string;
  weekPercent?: number;
  weekResets?: string;
  checkedAtMs?: number;
};

type CodexUsageSummary = CodexManualUsage & { checkedAtMs: number };

export class Dashboard {
  private panel: vscode.WebviewPanel | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastScan: AgentScan | undefined;
  private lastClaudeSessions: ClaudeSession[] = [];
  private refreshPromise: Promise<AgentScan> | undefined;
  private codexTerminals = new Map<string, vscode.Terminal>();
  private claudeTerminals = new Map<string, vscode.Terminal>();
  // Sessions whose "running" status right now is our own auto-compact-on-review sendCompact call,
  // not new user activity - guards against doRefresh's "unreview if running again" heuristic
  // immediately undoing the review it was just given. Cleared once the session is observed no
  // longer running (the compact finished), so genuinely new activity afterwards still unreviews it.
  private pendingReviewCompactCodexIds = new Set<string>();
  private pendingReviewCompactClaudeIds = new Set<string>();
  private claudeUsage: ClaudeUsageSummary | undefined;
  private claudeUsageFetching = false;
  private codexUsage: CodexUsageSummary | undefined;
  private codexUsageFetching = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly reviewState: ReviewState,
    private getConfig: () => AgentMonitorConfig,
    private readonly output: vscode.OutputChannel
  ) {
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        deleteByValue(this.codexTerminals, terminal);
        deleteByValue(this.claudeTerminals, terminal);
      })
    );
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(dashboardViewType, "Agent Monitor", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true
    });

    this.attachPanel(panel);
  }

  async focus(): Promise<void> {
    this.open();
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }

  restore(panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true
    };
    this.attachPanel(panel);
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    if (this.panel && this.panel !== panel) {
      panel.dispose();
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.panel = panel;

    panel.onDidDispose(
      () => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
        this.stopTimer();
      },
      undefined,
      this.context.subscriptions
    );

    panel.webview.onDidReceiveMessage(
      (message: DashboardMessage) => {
        void this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions
    );

    this.startTimer();
    void this.refresh();
  }

  async refresh(options?: { force?: boolean }): Promise<AgentScan> {
    if (this.refreshPromise && !options?.force) {
      return this.refreshPromise;
    }

    if (this.refreshPromise) {
      // An in-flight scan may have started before a mutation (archive/delete/etc.) landed on
      // disk, so it can't be reused here - wait for it to settle, then run a fresh one.
      await this.refreshPromise.catch(() => undefined);
    }

    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async doRefresh(): Promise<AgentScan> {
    let scan = await scanAgents(this.getConfig(), this.reviewState.getReviewed());
    this.logDiagnostics(scan);
    for (const id of [...this.pendingReviewCompactCodexIds]) {
      if (!scan.sessions.some((session) => session.id === id && session.status === "running")) {
        this.pendingReviewCompactCodexIds.delete(id);
      }
    }
    const runningReviewedIds = scan.sessions
      .filter((session) => session.status === "running" && session.reviewedAt && !this.pendingReviewCompactCodexIds.has(session.id))
      .map((session) => session.id);
    if (runningReviewedIds.length > 0) {
      await this.reviewState.markUnreviewed(runningReviewedIds);
      scan = await scanAgents(this.getConfig(), this.reviewState.getReviewed());
      this.logDiagnostics(scan);
    }
    this.lastScan = scan;
    let claudeSessions = await scanClaudeSessions(this.getConfig().claudeHome, this.reviewState.getReviewed());
    for (const id of [...this.pendingReviewCompactClaudeIds]) {
      if (!claudeSessions.some((session) => session.id === id && (session.status === "running" || session.status === "needs-input"))) {
        this.pendingReviewCompactClaudeIds.delete(id);
      }
    }
    const runningReviewedClaudeIds = claudeSessions
      .filter(
        (session) =>
          (session.status === "running" || session.status === "needs-input") &&
          session.reviewedAt &&
          !this.pendingReviewCompactClaudeIds.has(session.id)
      )
      .map((session) => session.id);
    if (runningReviewedClaudeIds.length > 0) {
      await this.reviewState.markUnreviewed(runningReviewedClaudeIds);
      claudeSessions = await scanClaudeSessions(this.getConfig().claudeHome, this.reviewState.getReviewed());
    }
    this.lastClaudeSessions = claudeSessions;

    // Cheap, local-file-only check: if the user (or our own probe session) ran /usage more
    // recently than our last known reading, adopt it - no CLI spawn needed for this to stay fresh.
    const passiveUsage = await findLatestClaudeUsageSnapshot(this.getConfig().claudeHome);
    if (passiveUsage && (!this.claudeUsage?.checkedAtMs || passiveUsage.checkedAtMs > this.claudeUsage.checkedAtMs)) {
      this.claudeUsage = passiveUsage;
    }

    if (this.panel) {
      this.renderCurrent();
    }
    return scan;
  }

  private renderCurrent(): void {
    if (!this.panel || !this.lastScan) {
      return;
    }

    this.panel.webview.html = renderDashboard(
      this.lastScan,
      this.getConfig(),
      this.lastClaudeSessions,
      this.getOpenTerminalSessionIds(),
      this.claudeUsage,
      this.claudeUsageFetching,
      this.codexUsage,
      this.codexUsageFetching
    );
  }

  private getOpenTerminalSessionIds(): { codex: Set<string>; claude: Set<string> } {
    const codex = new Set(this.codexTerminals.keys());
    for (const session of this.lastScan?.sessions ?? []) {
      const terminal = findTerminalByExpectedName(terminalNameForSession(session.name));
      if (terminal) {
        this.codexTerminals.set(session.id, terminal);
        codex.add(session.id);
      }
    }

    const claude = new Set(this.claudeTerminals.keys());
    for (const session of this.lastClaudeSessions) {
      const terminal = findTerminalByExpectedName(claudeTerminalNameForSession(session.name));
      if (terminal) {
        this.claudeTerminals.set(session.id, terminal);
        claude.add(session.id);
      }
    }

    return { codex, claude };
  }

  restartTimer(): void {
    if (this.panel) {
      this.startTimer();
    }
  }

  dispose(): void {
    this.stopTimer();
    this.panel?.dispose();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => void this.refresh(), this.getConfig().refreshIntervalMs);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async handleMessage(message: DashboardMessage): Promise<void> {
    try {
      if (message.command === "refresh") {
        await this.refresh();
        return;
      }

      if (message.command === "openAgent" && message.sessionId) {
        this.openAgent(message.sessionId);
        return;
      }

      if (message.command === "openClaudeAgent" && message.sessionId) {
        this.openClaudeAgent(message.sessionId);
        return;
      }

      if (message.command === "approveSession" && message.sessionId) {
        this.sendApproval(message.sessionId, "y");
        return;
      }

      if (message.command === "alwaysApproveSession" && message.sessionId) {
        this.sendApproval(message.sessionId, "p");
        return;
      }

      if (message.command === "approveClaudeSession" && message.sessionId) {
        await this.approveClaudeSession(message.sessionId);
        return;
      }

      if (message.command === "alwaysApproveClaudeSession" && message.sessionId) {
        await this.alwaysApproveClaudeSession(message.sessionId);
        return;
      }

      if (message.command === "compactSession" && message.sessionId) {
        await this.sendCompact(message.sessionId);
        return;
      }

      if (message.command === "compactClaudeSession" && message.sessionId) {
        await this.sendClaudeCompact(message.sessionId);
        return;
      }

      if (message.command === "refreshClaudeUsage") {
        await this.refreshClaudeUsage();
        return;
      }

      if (message.command === "refreshCodexUsage") {
        await this.refreshCodexUsage();
        return;
      }

      if (message.command === "openTranscript" && message.path) {
        await vscode.window.showTextDocument(vscode.Uri.file(message.path), { preview: false });
        return;
      }

      if (message.command === "updateStartupSetting" && message.setting) {
        await updateAgentMonitorOptions({ [message.setting]: message.value === true });
        return;
      }

      if (message.command === "markReviewed" && message.sessionId) {
        await this.markReviewed(message.sessionId);
        return;
      }

      if (message.command === "markUnreviewed" && message.sessionId) {
        await this.reviewState.markUnreviewed([message.sessionId]);
        await this.refresh({ force: true });
        return;
      }

      if (message.command === "markClaudeReviewed" && message.sessionId) {
        await this.markClaudeReviewed(message.sessionId);
        return;
      }

      if (message.command === "markClaudeUnreviewed" && message.sessionId) {
        await this.reviewState.markUnreviewed([message.sessionId]);
        await this.refresh({ force: true });
        return;
      }

      if (message.command === "archiveSession" && message.sessionId) {
        await this.archiveSession(message.sessionId);
        return;
      }

      if (message.command === "unarchiveSession" && message.sessionId) {
        await this.unarchiveSession(message.sessionId);
        return;
      }

      if (message.command === "deleteSession" && message.sessionId) {
        await this.deleteSession(message.sessionId);
        return;
      }

      if (message.command === "archiveClaudeSession" && message.sessionId) {
        await this.archiveClaudeSession(message.sessionId);
        return;
      }

      if (message.command === "unarchiveClaudeSession" && message.sessionId) {
        await this.unarchiveClaudeSession(message.sessionId);
        return;
      }

      if (message.command === "deleteClaudeSession" && message.sessionId) {
        await this.deleteClaudeSession(message.sessionId);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[${new Date().toISOString()}] Error handling webview message "${message.command ?? "unknown"}": ${messageText}`);
      this.panel?.webview.postMessage({ command: "refreshFailed", message: messageText });
      void vscode.window.showErrorMessage(`Agent Monitor: ${messageText}`);
    }
  }

  // Looks a session's terminal up primarily by its expected tab name (matching how the user
  // thinks about their terminals), falling back to the session-id map only when the name isn't
  // found - which means the tab title has drifted (e.g. the shell or CLI rewrote it via an OSC
  // escape sequence). When that happens, rename the tab back to its canonical name so future
  // by-name lookups work again; every caller already calls `.show()` on the result right after,
  // so this doesn't steal focus beyond what the caller was already about to do.
  private resolveTerminal(map: Map<string, vscode.Terminal>, sessionId: string, expectedName: string): vscode.Terminal | undefined {
    const byName = findTerminalByExpectedName(expectedName);
    if (byName) {
      map.set(sessionId, byName);
      return byName;
    }

    const byMap = map.get(sessionId);
    if (byMap) {
      byMap.show();
      void vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name: expectedName });
    }

    return byMap;
  }

  openAgent(sessionId: string): void {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    const expectedName = terminalNameForSession(session?.name);
    const existingTerminal = this.resolveTerminal(this.codexTerminals, sessionId, expectedName);
    if (existingTerminal) {
      existingTerminal.show();
      return;
    }

    const terminal = vscode.window.createTerminal({
      cwd: os.homedir(),
      name: expectedName
    });
    this.codexTerminals.set(sessionId, terminal);
    terminal.show();
    terminal.sendText(`codex resume ${sessionId}`);
  }

  openClaudeAgent(sessionId: string): void {
    const session = this.lastClaudeSessions.find((session) => session.id === sessionId);
    const expectedName = claudeTerminalNameForSession(session?.name);
    const existingTerminal = this.resolveTerminal(this.claudeTerminals, sessionId, expectedName);
    if (existingTerminal) {
      existingTerminal.show();
      return;
    }

    const terminal = vscode.window.createTerminal({
      cwd: os.homedir(),
      name: expectedName
    });
    this.claudeTerminals.set(sessionId, terminal);
    terminal.show();
    terminal.sendText(`claude --resume ${sessionId}`);
  }

  sendApproval(sessionId: string, approval: "y" | "p"): void {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    const expectedName = terminalNameForSession(session?.name);
    const existingTerminal = this.resolveTerminal(this.codexTerminals, sessionId, expectedName);
    if (!existingTerminal) {
      this.openAgent(sessionId);
      void vscode.window.showWarningMessage(`Agent Monitor opened ${expectedName}. Send approval again once the prompt is visible.`);
      return;
    }

    existingTerminal.show();
    existingTerminal.sendText(approval);
  }

  async approveClaudeSession(sessionId: string): Promise<void> {
    const session = this.lastClaudeSessions.find((session) => session.id === sessionId);
    const expectedName = claudeTerminalNameForSession(session?.name);
    const existingTerminal = this.resolveTerminal(this.claudeTerminals, sessionId, expectedName);
    if (!existingTerminal) {
      this.openClaudeAgent(sessionId);
      void vscode.window.showWarningMessage(`Agent Monitor opened ${expectedName}. Send approval again once the prompt is visible.`);
      return;
    }

    existingTerminal.show();
    await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: "\r" });
  }

  async alwaysApproveClaudeSession(sessionId: string): Promise<void> {
    const session = this.lastClaudeSessions.find((session) => session.id === sessionId);
    const expectedName = claudeTerminalNameForSession(session?.name);
    const existingTerminal = this.resolveTerminal(this.claudeTerminals, sessionId, expectedName);
    if (!existingTerminal) {
      this.openClaudeAgent(sessionId);
      void vscode.window.showWarningMessage(`Agent Monitor opened ${expectedName}. Send approval again once the prompt is visible.`);
      return;
    }

    existingTerminal.show();
    await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: "\x1b[B" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: "\r" });
  }

  async markReviewed(sessionId: string): Promise<void> {
    await this.reviewState.markReviewed([sessionId]);
    if (this.getConfig().autoCompactOnReview) {
      const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
      const contextPercent = computeContextPercent(session?.usage?.lastTokenUsage?.inputTokens);
      if (contextPercent === undefined || contextPercent > 0) {
        const sent = await this.sendCompactIfTerminalOpen(sessionId);
        if (sent) {
          this.pendingReviewCompactCodexIds.add(sessionId);
        }
      }
    }
    await this.refresh({ force: true });
  }

  async markClaudeReviewed(sessionId: string): Promise<void> {
    await this.reviewState.markReviewed([sessionId]);
    if (this.getConfig().autoCompactOnReview) {
      const session = this.lastClaudeSessions.find((session) => session.id === sessionId);
      const contextPercent = computeContextPercent(session?.usage?.contextTokens);
      if (contextPercent === undefined || contextPercent > 0) {
        const sent = await this.sendClaudeCompactIfTerminalOpen(sessionId);
        if (sent) {
          this.pendingReviewCompactClaudeIds.add(sessionId);
        }
      }
    }
    await this.refresh({ force: true });
  }

  async sendCompact(sessionId: string): Promise<void> {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    const terminalName = terminalNameForSession(session?.name);
    const existingTerminal = this.resolveTerminal(this.codexTerminals, sessionId, terminalName);
    await this.sendCompactToTerminal(existingTerminal, terminalName, () => this.openAgent(sessionId));
  }

  async sendCompactIfTerminalOpen(sessionId: string): Promise<boolean> {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    const terminalName = terminalNameForSession(session?.name);
    const existingTerminal = this.resolveTerminal(this.codexTerminals, sessionId, terminalName);
    if (!existingTerminal) {
      return false;
    }

    await this.sendCompactToTerminal(existingTerminal, terminalName);
    return true;
  }

  async sendClaudeCompact(sessionId: string): Promise<void> {
    const session = this.lastClaudeSessions.find((session) => session.id === sessionId);
    const terminalName = claudeTerminalNameForSession(session?.name);
    const existingTerminal = this.resolveTerminal(this.claudeTerminals, sessionId, terminalName);
    await this.sendCompactToTerminal(existingTerminal, terminalName, () => this.openClaudeAgent(sessionId));
  }

  async sendClaudeCompactIfTerminalOpen(sessionId: string): Promise<boolean> {
    const session = this.lastClaudeSessions.find((session) => session.id === sessionId);
    const terminalName = claudeTerminalNameForSession(session?.name);
    const existingTerminal = this.resolveTerminal(this.claudeTerminals, sessionId, terminalName);
    if (!existingTerminal) {
      return false;
    }

    await this.sendCompactToTerminal(existingTerminal, terminalName);
    return true;
  }

  async refreshClaudeUsage(): Promise<void> {
    if (this.claudeUsageFetching) {
      return;
    }

    this.claudeUsageFetching = true;
    // Reflect the "Checking..." state right away - the CLI call below can take far longer than
    // a normal refresh cycle, so it must not block the periodic scan/render loop while it runs.
    await this.refresh({ force: true });

    try {
      const claudeHome = this.getConfig().claudeHome;
      const existingSessionId = await findClaudeUsageProbeSessionId(claudeHome);
      const args = existingSessionId ? ["-p", "--resume", existingSessionId, "/usage"] : ["-p", "/usage"];
      const { stdout } = await execFileAsync("claude", args, {
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024
      });
      const usage = parseClaudeUsageText(stdout);
      if (usage) {
        this.claudeUsage = { ...usage, checkedAtMs: Date.now() };
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[${new Date().toISOString()}] ERROR fetching claude usage: ${messageText}`);
      void vscode.window.showErrorMessage(`Agent Monitor: could not fetch Claude usage (${messageText}).`);
    } finally {
      this.claudeUsageFetching = false;
    }

    await this.refresh({ force: true });
  }

  async refreshCodexUsage(): Promise<void> {
    if (this.codexUsageFetching) {
      return;
    }

    this.codexUsageFetching = true;
    this.renderCurrent();

    try {
      const usage = await fetchCodexUsage(this.getConfig().codexHome);
      this.codexUsage = { ...usage, checkedAtMs: Date.now() };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[${new Date().toISOString()}] ERROR fetching codex usage: ${messageText}`);
      void vscode.window.showErrorMessage(`Agent Monitor: could not fetch Codex usage (${messageText}).`);
    } finally {
      this.codexUsageFetching = false;
    }

    this.renderCurrent();
  }

  private async sendCompactToTerminal(
    existingTerminal: vscode.Terminal | undefined,
    terminalName: string,
    openIfMissing?: () => void
  ): Promise<void> {
    if (existingTerminal) {
      existingTerminal.show();
      await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: "/compact" });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text: "\r" });
      return;
    }

    if (openIfMissing) {
      openIfMissing();
    }
    await vscode.env.clipboard.writeText("/compact");
    void vscode.window.showWarningMessage(`Auto compact failed for ${terminalName}. Paste /compact into the terminal manually.`);
  }

  private async confirmCloseTerminalIfOpen(terminalName: string, terminal: vscode.Terminal | undefined): Promise<boolean> {
    if (!terminal) {
      return true;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `"${terminalName}" is currently open in a terminal. Archiving will close it. Continue?`,
      { modal: true },
      "Archive and Close Terminal"
    );
    if (confirmation !== "Archive and Close Terminal") {
      return false;
    }

    terminal.dispose();
    return true;
  }

  async archiveSession(sessionId: string): Promise<void> {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    if (!session?.transcriptPath) {
      void vscode.window.showWarningMessage(`Agent Monitor: no transcript file found for ${sessionId}.`);
      return;
    }

    const shouldProceed = await this.confirmCloseTerminalIfOpen(
      terminalNameForSession(session.name),
      this.codexTerminals.get(sessionId)
    );
    if (!shouldProceed) {
      return;
    }
    this.codexTerminals.delete(sessionId);

    await archiveTranscript(this.getConfig().codexHome, session.transcriptPath);
    await this.refresh({ force: true });
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    if (!session?.transcriptPath) {
      void vscode.window.showWarningMessage(`Agent Monitor: no transcript file found for ${sessionId}.`);
      return;
    }

    await unarchiveTranscript(this.getConfig().codexHome, session.transcriptPath);
    await this.refresh({ force: true });
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    if (session?.status !== "archived" || !session.transcriptPath) {
      void vscode.window.showWarningMessage(`Agent Monitor: only archived chats can be deleted.`);
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Permanently delete "${session.name}"? This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (confirmation !== "Delete") {
      return;
    }

    await deleteArchivedTranscript(this.getConfig().codexHome, sessionId, session.transcriptPath);
    await this.reviewState.markUnreviewed([sessionId]);
    await this.refresh({ force: true });
  }

  async archiveClaudeSession(sessionId: string): Promise<void> {
    const session = this.lastClaudeSessions.find((session) => session.id === sessionId);
    if (!session) {
      void vscode.window.showWarningMessage(`Agent Monitor: no Claude session found for ${sessionId}.`);
      return;
    }

    const shouldProceed = await this.confirmCloseTerminalIfOpen(
      claudeTerminalNameForSession(session.name),
      this.claudeTerminals.get(sessionId)
    );
    if (!shouldProceed) {
      return;
    }
    this.claudeTerminals.delete(sessionId);

    await archiveClaudeTranscript(this.getConfig().claudeHome, session.transcriptPath);
    await this.refresh({ force: true });
  }

  async unarchiveClaudeSession(sessionId: string): Promise<void> {
    const session = this.lastClaudeSessions.find((session) => session.id === sessionId);
    if (!session) {
      void vscode.window.showWarningMessage(`Agent Monitor: no Claude session found for ${sessionId}.`);
      return;
    }

    await unarchiveClaudeTranscript(this.getConfig().claudeHome, session.transcriptPath);
    await this.refresh({ force: true });
  }

  async deleteClaudeSession(sessionId: string): Promise<void> {
    const session = this.lastClaudeSessions.find((session) => session.id === sessionId);
    if (session?.status !== "archived") {
      void vscode.window.showWarningMessage(`Agent Monitor: only archived chats can be deleted.`);
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Permanently delete "${session.name}"? This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (confirmation !== "Delete") {
      return;
    }

    await deleteClaudeTranscript(session.transcriptPath);
    await this.refresh({ force: true });
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

function renderDashboard(
  scan: AgentScan,
  config: AgentMonitorConfig,
  claudeSessions: ClaudeSession[],
  openSessionIds: { codex: Set<string>; claude: Set<string> },
  claudeUsage: ClaudeUsageSummary | undefined,
  claudeUsageFetching: boolean,
  codexUsage: CodexUsageSummary | undefined,
  codexUsageFetching: boolean
): string {
  const sessions = scan.sessions.map((session) => ({
    ...session,
    isOpenInTerminal: openSessionIds.codex.has(session.id)
  }));
  const claudeSessionsWithTerminal = claudeSessions.map((session) => ({
    ...session,
    isOpenInTerminal: openSessionIds.claude.has(session.id)
  }));
  const rows = sessions.map(renderSessionRow).join("");
  const combinedCards = [
    ...sessions.map((session) => ({ name: session.name, html: renderSessionCard(session) })),
    ...claudeSessionsWithTerminal.map((session) => ({ name: session.name, html: renderClaudeSessionCard(session) }))
  ].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const cards = combinedCards.map((card) => card.html).join("");
  const empty = combinedCards.length === 0 ? `<div class="empty">No Codex or Claude chats found.</div>` : "";
  const combinedSummary = combineSummaries(scan.summary, claudeSessions);
  const summaryTitle = summaryTooltip(combinedSummary, scan.timings);
  const refreshSeconds = Math.round(config.refreshIntervalMs / 1000);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Monitor</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --button: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --secondary-button: var(--vscode-button-secondaryBackground);
      --secondary-button-fg: var(--vscode-button-secondaryForeground);
      --card: var(--vscode-sideBar-background);
      --running: #2ea043;
      --approval: #f85149;
      --done: #d29922;
      --reviewed: #58a6ff;
      --archived: #a371f7;
      --unknown: #8b949e;
      --claude-accent: #f0883e;
      --overflow: #e3b341;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .shell {
      width: min(1180px, calc(100vw - 40px));
      margin: 0 auto;
      padding: 0 0 32px;
    }

    header {
      align-items: flex-end;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 16px;
      justify-content: space-between;
      margin-bottom: 16px;
      padding: 24px 0 18px;
      position: sticky;
      top: 0;
      z-index: 2;
    }

    h1 {
      font-size: 24px;
      letter-spacing: 0;
      line-height: 1.2;
      margin: 0 0 6px;
    }

    .summary {
      color: var(--muted);
      line-height: 1.5;
    }

    .header-actions,
    .actions,
    .stats,
    .toolbar {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    button {
      appearance: none;
      background: var(--button);
      border: 0;
      border-radius: 4px;
      color: var(--button-fg);
      cursor: pointer;
      font: inherit;
      min-height: 30px;
      padding: 5px 10px;
    }

    button.secondary {
      background: var(--secondary-button);
      color: var(--secondary-button-fg);
    }

    .checkbox-control {
      align-items: center;
      color: var(--muted);
      display: inline-flex;
      gap: 6px;
      min-height: 30px;
      white-space: nowrap;
    }

    .view-mode {
      background: var(--secondary-button);
      color: var(--secondary-button-fg);
    }

    .view-mode.active {
      background: var(--button);
      color: var(--button-fg);
    }

    .stats {
      margin: 0 0 14px;
    }

    .stat {
      background: var(--secondary-button);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--secondary-button-fg);
      cursor: pointer;
      min-width: 112px;
      padding: 9px 10px;
      text-align: left;
    }

    .stat.active {
      background: var(--button);
      color: var(--button-fg);
    }

    .stat.active span {
      color: var(--button-fg);
    }

    .stat strong {
      display: block;
      font-size: 18px;
      line-height: 1.1;
    }

    .stat span {
      color: var(--muted);
      display: block;
      font-size: 12px;
      margin-top: 4px;
    }

    .toolbar {
      justify-content: space-between;
      margin: 0 0 12px;
    }

    .usage {
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 0 0 14px;
      padding: 10px;
    }

    .usage.empty {
      display: block;
      text-align: left;
    }

    .usage-window {
      flex: 1 1 220px;
    }

    .usage-actions {
      align-items: center;
      display: flex;
      flex: 0 0 auto;
      justify-content: flex-end;
      margin-left: auto;
    }

    button.claude-usage-button {
      background: var(--claude-accent);
      color: #1a1a1a;
    }

    button.claude-usage-button:hover {
      background: color-mix(in srgb, var(--claude-accent) 85%, white);
    }

    .usage-label {
      align-items: baseline;
      display: flex;
      gap: 8px;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .usage-label strong {
      font-size: 13px;
    }

    .usage-label span {
      color: var(--muted);
      font-size: 12px;
    }

    .usage-track {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--border);
      border-radius: 999px;
      height: 8px;
      overflow: hidden;
    }

    .usage-fill {
      background: var(--button);
      height: 100%;
    }

    .mode-view.hidden {
      display: none;
    }

    [data-session-status].filtered {
      display: none;
    }

    .grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }

    .card-top {
      align-items: flex-start;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    h2 {
      font-size: 15px;
      line-height: 1.25;
      margin: 0 0 4px;
      overflow-wrap: anywhere;
    }

    dl {
      display: grid;
      gap: 8px 12px;
      grid-template-columns: max-content minmax(0, 1fr);
      margin: 0;
    }

    dt {
      color: var(--muted);
      font-size: 12px;
    }

    dd {
      margin: 0;
      min-width: 0;
    }

    .table-wrap {
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: auto;
    }

    table {
      border-collapse: collapse;
      min-width: 980px;
      width: 100%;
    }

    th,
    td {
      border-bottom: 1px solid var(--border);
      padding: 9px 10px;
      text-align: left;
      vertical-align: top;
    }

    th {
      background: var(--card);
      color: var(--muted);
      font-weight: 600;
      position: sticky;
      top: 0;
      z-index: 1;
    }

    tr:last-child td {
      border-bottom: 0;
    }

    .name {
      font-weight: 600;
      margin-bottom: 4px;
      overflow-wrap: anywhere;
    }

    .meta,
    .message {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .session-id {
      color: color-mix(in srgb, var(--muted) 75%, transparent);
    }

    .inline-action {
      appearance: none;
      background: transparent;
      border: 0;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      display: inline;
      font: inherit;
      min-height: 0;
      padding: 0;
      text-align: left;
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 2px;
    }

    .inline-action:hover {
      color: var(--vscode-textLink-activeForeground);
    }

    .inline-action.message {
      color: var(--fg);
      text-decoration: none;
    }

    .inline-action.message:hover {
      color: var(--fg);
      text-decoration: underline;
    }

    .message {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      max-width: 360px;
      overflow: hidden;
    }

    .session-usage {
      display: grid;
      gap: 5px;
      min-width: 150px;
    }

    .session-usage .usage-track {
      height: 6px;
    }

    .badge {
      border: 1px solid var(--border);
      border-radius: 999px;
      display: inline-flex;
      font-size: 12px;
      padding: 3px 8px;
      white-space: nowrap;
    }

    .badge.running {
      border-color: color-mix(in srgb, var(--running) 55%, var(--border));
      color: var(--running);
    }

    .badge.needs-approval {
      border-color: color-mix(in srgb, var(--approval) 60%, var(--border));
      color: var(--approval);
    }

    .badge.done-review {
      border-color: color-mix(in srgb, var(--done) 60%, var(--border));
      color: var(--done);
    }

    .badge.reviewed {
      border-color: color-mix(in srgb, var(--reviewed) 60%, var(--border));
      color: var(--reviewed);
    }

    .badge.archived {
      border-color: color-mix(in srgb, var(--archived) 60%, var(--border));
      color: var(--archived);
    }

    .badge.unknown {
      color: var(--unknown);
    }

    .empty {
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
      padding: 24px;
      text-align: center;
    }

    .actions {
      min-width: 150px;
    }

    .claude-usage .usage-fill {
      background: var(--claude-accent);
    }

    .card.claude .session-id,
    .card.claude .session-id .inline-action {
      color: var(--claude-accent);
    }

    .card.claude .session-id .inline-action:hover {
      color: color-mix(in srgb, var(--claude-accent) 80%, white);
    }

    .name-fallback-codex {
      color: var(--reviewed);
    }

    .name-fallback-claude {
      color: var(--claude-accent);
    }

    .card.claude .usage-fill {
      background: var(--claude-accent);
    }

    .card.claude button:not(.secondary):not(.inline-action) {
      background: var(--claude-accent);
      color: #1a1a1a;
    }

    .card.claude button:not(.secondary):not(.inline-action):hover {
      background: color-mix(in srgb, var(--claude-accent) 85%, white);
    }

    .usage-fill.over-limit {
      background: var(--overflow);
    }

    .card.claude .usage-fill.over-limit {
      background: var(--overflow);
    }

    .inline-action.static {
      cursor: default;
      text-decoration: none;
    }

    .inline-action.static:hover {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .card.claude .inline-action.static:hover {
      color: var(--claude-accent);
    }

    @media (max-width: 760px) {
      .shell {
        width: min(100vw - 24px, 1180px);
      }

      header {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div>
        <h1>Agent Monitor</h1>
        <div class="summary" title="${escapeAttr(summaryTitle)}">${combinedSummary.total} sessions · <span id="refresh-status">Refreshing in <span id="refresh-countdown">${refreshSeconds}</span>s</span></div>
      </div>
      <div class="header-actions">
        <label class="checkbox-control"><input type="checkbox" data-setting="autoCompactOnReview" ${config.autoCompactOnReview ? "checked" : ""}> Auto compact on review</label>
        <button type="button" data-command="refresh">Refresh</button>
      </div>
    </header>

    <section class="stats" aria-label="Agent chat summary">
      ${renderStat("Running", combinedSummary.running, "running")}
      ${renderStat("Needs Approval", combinedSummary.needsApproval, "needs-approval")}
      ${renderStat("Done", combinedSummary.doneReview, "done-review")}
      ${renderStat("Reviewed", combinedSummary.reviewed, "reviewed")}
      ${renderStat("Archived", combinedSummary.archived, "archived")}
      ${renderStat("Unknown", combinedSummary.unknown, "unknown")}
    </section>

    ${renderUsage(scan, codexUsage, codexUsageFetching)}
    ${renderClaudeUsageSection(claudeUsage, claudeUsageFetching)}

    <section class="toolbar">
      <div class="toolbar-group" role="group" aria-label="Agent view">
        <button class="view-mode active" data-view-mode="cards">Cards</button>
        <button class="view-mode" data-view-mode="table">Table</button>
      </div>
    </section>

    ${empty || `<section class="grid mode-view" data-mode-panel="cards">${cards}</section>
    <section class="table-wrap mode-view hidden" data-mode-panel="table">
      <table>
        <thead>
          <tr>
            <th>Chat</th>
            <th>Status</th>
            <th>Updated</th>
            <th>Usage</th>
            <th>Last User</th>
            <th>Last Message</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`}
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const persistedState = vscode.getState() || {};
    const allStatuses = [...document.querySelectorAll("[data-stat-status]")]
      .map((element) => element.dataset.statStatus)
      .filter((status) => status !== "all");
    const selectedStatuses = new Set(persistedState.selectedStatuses ?? allStatuses);
    const refreshSeconds = ${refreshSeconds};
    let countdown = refreshSeconds;
    let refreshing = false;
    let refreshTimeout;

    function persistState(extra = {}) {
      vscode.setState({
        viewMode: document.querySelector(".view-mode.active")?.dataset.viewMode || "cards",
        selectedStatuses: [...selectedStatuses],
        ...extra
      });
    }

    function showMode(mode) {
      for (const button of document.querySelectorAll("[data-view-mode]")) {
        button.classList.toggle("active", button.dataset.viewMode === mode);
      }
      for (const panel of document.querySelectorAll("[data-mode-panel]")) {
        panel.classList.toggle("hidden", panel.dataset.modePanel !== mode);
      }
      persistState({ viewMode: mode });
    }

    function applyStatusFilter() {
      for (const stat of document.querySelectorAll("[data-stat-status]")) {
        const status = stat.dataset.statStatus;
        stat.classList.toggle("active", status !== "all" && selectedStatuses.has(status));
      }

      for (const session of document.querySelectorAll("[data-session-status]")) {
        session.classList.toggle("filtered", selectedStatuses.size > 0 && !selectedStatuses.has(session.dataset.sessionStatus));
      }

      persistState();
    }

    function setRefreshStatus() {
      const status = document.getElementById("refresh-status");
      const countdownElement = document.getElementById("refresh-countdown");
      if (!status) {
        return;
      }
      if (refreshing) {
        status.textContent = "Refreshing...";
        return;
      }
      status.innerHTML = 'Refreshing in <span id="refresh-countdown">' + countdown + '</span>s';
      const nextCountdownElement = document.getElementById("refresh-countdown") || countdownElement;
      if (nextCountdownElement) {
        nextCountdownElement.textContent = String(countdown);
      }
    }

    function setManualRefreshButtonBusy(busy) {
      const button = document.querySelector('[data-command="refresh"]');
      if (!button) {
        return;
      }
      if (busy) {
        button.dataset.originalLabel = button.textContent;
        button.textContent = "Refreshing...";
        button.classList.add("secondary");
        button.disabled = true;
      } else {
        button.textContent = button.dataset.originalLabel || "Refresh";
        button.classList.remove("secondary");
        button.disabled = false;
        delete button.dataset.originalLabel;
      }
    }

    function requestRefresh(options = {}) {
      if (refreshing) {
        return;
      }
      refreshing = true;
      setRefreshStatus();
      if (options.manual) {
        setManualRefreshButtonBusy(true);
      }
      vscode.postMessage({ command: "refresh" });
      clearTimeout(refreshTimeout);
      refreshTimeout = setTimeout(() => {
        refreshing = false;
        countdown = refreshSeconds;
        setRefreshStatus();
        setManualRefreshButtonBusy(false);
      }, Math.max(10000, refreshSeconds * 3000));
    }

    window.addEventListener("message", (event) => {
      if (event.data?.command === "refreshFailed") {
        clearTimeout(refreshTimeout);
        refreshing = false;
        countdown = refreshSeconds;
        setRefreshStatus();
        setManualRefreshButtonBusy(false);
      }
    });

    showMode(persistedState.viewMode || "cards");
    applyStatusFilter();

    setInterval(() => {
      if (refreshing) {
        return;
      }
      countdown = Math.max(0, countdown - 1);
      if (countdown === 0) {
        requestRefresh();
      } else {
        setRefreshStatus();
      }
    }, 1000);

    document.addEventListener("click", (event) => {
      const viewModeButton = event.target.closest("button[data-view-mode]");
      if (viewModeButton) {
        showMode(viewModeButton.dataset.viewMode);
        return;
      }

      const statButton = event.target.closest("[data-stat-status]");
      if (statButton) {
        const status = statButton.dataset.statStatus;
        if (status === "all") {
          selectedStatuses.clear();
        } else if (selectedStatuses.has(status)) {
          selectedStatuses.delete(status);
        } else {
          selectedStatuses.add(status);
        }
        applyStatusFilter();
        return;
      }

      const commandElement = event.target.closest("[data-command]");
      if (!commandElement) {
        return;
      }

      if (commandElement.dataset.command === "refresh") {
        requestRefresh({ manual: true });
        return;
      }

      vscode.postMessage({
        command: commandElement.dataset.command,
        sessionId: commandElement.dataset.sessionId,
        path: commandElement.dataset.path
      });
    });

    document.addEventListener("change", (event) => {
      if (event.target.dataset?.setting) {
        vscode.postMessage({
          command: "updateStartupSetting",
          setting: event.target.dataset.setting,
          value: event.target.checked
        });
      }
    });
  </script>
</body>
</html>`;
}

function deleteByValue<K>(map: Map<K, vscode.Terminal>, value: vscode.Terminal): void {
  for (const [key, terminal] of map) {
    if (terminal === value) {
      map.delete(key);
    }
  }
}

function terminalNameForSession(sessionName: string | undefined): string {
  return `${sessionName?.trim() || "Agent"} | Codex`;
}

function claudeTerminalNameForSession(sessionName: string | undefined): string {
  return `${sessionName?.trim() || "Agent"} | Claude`;
}

function findTerminalByExpectedName(expectedName: string): vscode.Terminal | undefined {
  return vscode.window.terminals.find(
    (terminal) => terminal.name === expectedName || terminal.name.startsWith(`${expectedName} `)
  );
}

function combineSummaries(summary: AgentScan["summary"], claudeSessions: ClaudeSession[]): AgentScan["summary"] {
  const running = claudeSessions.filter((session) => session.status === "running").length;
  const needsApproval = claudeSessions.filter((session) => session.status === "needs-input").length;
  const done = claudeSessions.filter((session) => session.status === "idle").length;
  const reviewed = claudeSessions.filter((session) => session.status === "reviewed").length;
  const archived = claudeSessions.filter((session) => session.status === "archived").length;

  return {
    total: summary.total + claudeSessions.length,
    running: summary.running + running,
    needsApproval: summary.needsApproval + needsApproval,
    doneReview: summary.doneReview + done,
    reviewed: summary.reviewed + reviewed,
    archived: summary.archived + archived,
    unknown: summary.unknown
  };
}

const CONTEXT_WINDOW_TOKENS = 200_000;

function computeContextPercent(contextTokens: number | undefined): number | undefined {
  if (contextTokens === undefined) {
    return undefined;
  }

  return Math.max(0, (contextTokens / CONTEXT_WINDOW_TOKENS) * 100);
}

function renderSessionCard(session: AgentSession): string {
  return `<article class="card" data-session-status="${escapeAttr(session.status)}">
    <div class="card-top">
      <div>
        <h2 class="${session.nameIsFallback ? "name-fallback-codex" : ""}">${escapeHtml(session.name)}</h2>
        <div class="meta session-id">${renderOpenSessionLink(session)}</div>
      </div>
      ${renderStatus(session.status)}
    </div>
    <dl>
      <dt>Updated</dt>
      <dd>
        <div>${escapeHtml(formatDate(session.updatedAtMs || session.updatedAt))}</div>
        ${session.lastCompletionAt ? `<div class="meta">completed ${escapeHtml(formatDate(session.lastCompletionAt))}</div>` : ""}
        ${session.reviewedAt ? `<div class="meta">reviewed ${escapeHtml(formatDate(session.reviewedAt))}</div>` : ""}
      </dd>
      <dt>User</dt>
      <dd><div class="message" title="${escapeAttr(session.lastUserMessage || "")}">${escapeHtml(truncateLines(session.lastUserMessage || "No user message found."))}</div></dd>
      <dt>Agent</dt>
      <dd>${renderAgentMessage(session)}</dd>
      <dt>Usage</dt>
      <dd>${renderSessionUsage(session)}</dd>
      <dt>Actions</dt>
      <dd><div class="actions">${renderActions(session)}</div></dd>
    </dl>
  </article>`;
}

function renderSessionRow(session: AgentSession): string {
  return `<tr data-session-status="${escapeAttr(session.status)}">
    <td>
      <div class="name">${escapeHtml(session.name)}</div>
      <div class="meta session-id">${renderOpenSessionLink(session)}</div>
    </td>
    <td>${renderStatus(session.status)}</td>
    <td>
      <div>${escapeHtml(formatDate(session.updatedAtMs || session.updatedAt))}</div>
      ${session.lastCompletionAt ? `<div class="meta">completed ${escapeHtml(formatDate(session.lastCompletionAt))}</div>` : ""}
      ${session.reviewedAt ? `<div class="meta">reviewed ${escapeHtml(formatDate(session.reviewedAt))}</div>` : ""}
    </td>
    <td>${renderSessionUsage(session)}</td>
    <td><div class="message" title="${escapeAttr(session.lastUserMessage || "")}">${escapeHtml(truncateLines(session.lastUserMessage || "No user message found."))}</div></td>
    <td>${renderAgentMessage(session)}</td>
    <td><div class="actions">${renderActions(session)}</div></td>
  </tr>`;
}

function renderOpenSessionLink(session: AgentSession): string {
  if (session.status === "archived") {
    return `<span class="inline-action static" title="Archived chats can't be opened">${escapeHtml(session.id)}</span>`;
  }

  return `<button class="inline-action" type="button" data-command="openAgent" data-session-id="${escapeAttr(session.id)}" title="Open agent terminal">${escapeHtml(session.id)}</button>`;
}

function renderAgentMessage(session: AgentSession): string {
  const message = session.lastMessage || "No agent message found.";
  const content = escapeHtml(truncateLines(message));
  const title = escapeAttr(session.transcriptPath ? `Open transcript\n\n${session.lastMessage || ""}` : session.lastMessage || "");
  if (!session.transcriptPath) {
    return `<div class="message" title="${title}">${content}</div>`;
  }

  return `<button class="inline-action message" type="button" data-command="openTranscript" data-path="${escapeAttr(session.transcriptPath)}" title="${title}">${content}</button>`;
}

function renderSessionUsage(session: AgentSession): string {
  const usage = session.usage;
  if (!usage) {
    return `<div class="meta">No usage data</div>`;
  }

  const totalTokens = usage.totalTokenUsage?.totalTokens;
  const lastTokens = usage.lastUserTurnTokenUsage?.totalTokens ?? usage.lastTokenUsage?.totalTokens;
  const contextTokens = usage.lastTokenUsage?.inputTokens;
  const contextPercent = computeContextPercent(contextTokens);
  const overLimit = contextPercent !== undefined && contextPercent > 100;
  const contextTitle =
    contextTokens !== undefined
      ? `${formatNumber(contextTokens)} / ${formatNumber(CONTEXT_WINDOW_TOKENS)} tokens (assumed)`
      : "Context window unavailable";
  const totalTitle = totalTokens !== undefined ? `${formatNumber(totalTokens)} total tokens` : "Total tokens unavailable";
  const lastTitle =
    usage.lastUserTurnTokenUsage?.totalTokens !== undefined
      ? `${formatNumber(usage.lastUserTurnTokenUsage.totalTokens)} tokens since latest user message`
      : lastTokens !== undefined
      ? `${formatNumber(lastTokens)} tokens in latest Codex-reported action`
      : "Latest turn tokens unavailable";
  const primaryDelta = usage.lastPrimaryDeltaPercent !== undefined ? `5h +${formatPercent(usage.lastPrimaryDeltaPercent)}` : "";
  const secondaryDelta = usage.lastSecondaryDeltaPercent !== undefined ? `7d +${formatPercent(usage.lastSecondaryDeltaPercent)}` : "";
  const durationText = session.lastRunDurationMs !== undefined ? formatDuration(session.lastRunDurationMs) : "";
  const deltaText = [primaryDelta, secondaryDelta, durationText].filter(Boolean).join(" · ");

  return `<div class="session-usage">
    <div class="meta" title="${escapeAttr(totalTitle)}">Total ${totalTokens !== undefined ? escapeHtml(formatCompactNumber(totalTokens)) : "unknown"} tokens</div>
    <div class="meta" title="${escapeAttr(lastTitle)}">Last run ${lastTokens !== undefined ? escapeHtml(formatCompactNumber(lastTokens)) : "unknown"} tokens${deltaText ? ` · ${escapeHtml(deltaText)}` : ""}</div>
    <div class="meta" title="${escapeAttr(contextTitle)}">Context ${contextPercent !== undefined ? `${Math.round(contextPercent)}%` : "unknown"}</div>
    <div class="usage-track" title="${escapeAttr(contextTitle)}"><div class="usage-fill${overLimit ? " over-limit" : ""}" style="width: ${Math.min(100, contextPercent ?? 0)}%"></div></div>
  </div>`;
}

function renderActions(session: AgentSession): string {
  const reviewButton =
    session.status === "needs-approval"
      ? `<button type="button" data-command="approveSession" data-session-id="${escapeAttr(session.id)}">Approve</button><button type="button" data-command="alwaysApproveSession" data-session-id="${escapeAttr(session.id)}">Always Approve</button>`
      : session.status === "archived" || session.status === "running"
      ? ""
      : session.status === "reviewed"
      ? `<button class="secondary" type="button" data-command="markUnreviewed" data-session-id="${escapeAttr(session.id)}">Unreview</button>`
      : `<button type="button" data-command="markReviewed" data-session-id="${escapeAttr(session.id)}">Reviewed</button>`;
  const compactButton = session.isOpenInTerminal
    ? `<button class="secondary" type="button" data-command="compactSession" data-session-id="${escapeAttr(session.id)}">Compact</button>`
    : "";
  const archiveButton =
    session.status !== "archived" && session.transcriptPath
      ? `<button class="secondary" type="button" data-command="archiveSession" data-session-id="${escapeAttr(session.id)}">Archive</button>`
      : "";
  const archivedActions =
    session.status === "archived"
      ? `<button class="secondary" type="button" data-command="unarchiveSession" data-session-id="${escapeAttr(session.id)}">Unarchive</button><button class="secondary" type="button" data-command="deleteSession" data-session-id="${escapeAttr(session.id)}">Delete</button>`
      : "";

  return `${compactButton}${archiveButton}${archivedActions}${reviewButton}`;
}

function renderStatus(status: AgentStatus): string {
  return `<span class="badge ${status}">${escapeHtml(statusLabel(status))}</span>`;
}

function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "needs-approval":
      return "needs approval";
    case "done-review":
      return "done";
    case "reviewed":
      return "reviewed";
    case "archived":
      return "archived";
    case "unknown":
      return "unknown";
  }
}

function renderStat(label: string, value: number, status: string): string {
  return `<button type="button" class="stat" data-stat-status="${escapeAttr(status)}"><strong>${value}</strong><span>${escapeHtml(label)}</span></button>`;
}

function renderClaudeSessionCard(session: ClaudeSession & { isOpenInTerminal: boolean }): string {
  return `<article class="card claude" data-session-status="${escapeAttr(claudeStatusInfo(session.status).badgeClass)}">
    <div class="card-top">
      <div>
        <h2 class="${session.nameIsAiGenerated ? "name-fallback-claude" : ""}">${escapeHtml(session.name)}</h2>
        <div class="meta session-id">${renderOpenClaudeSessionLink(session)}</div>
      </div>
      ${renderClaudeStatus(session.status)}
    </div>
    <dl>
      <dt>Updated</dt>
      <dd>
        <div>${escapeHtml(formatDate(session.updatedAtMs))}</div>
        ${session.reviewedAt ? `<div class="meta">reviewed ${escapeHtml(formatDate(session.reviewedAt))}</div>` : ""}
      </dd>
      <dt>User</dt>
      <dd><div class="message" title="${escapeAttr(session.lastUserMessage || "")}">${escapeHtml(truncateLines(session.lastUserMessage || "No user message found."))}</div></dd>
      <dt>Agent</dt>
      <dd>${renderClaudeAgentMessage(session)}</dd>
      <dt>Usage</dt>
      <dd>${renderClaudeSessionUsage(session)}</dd>
      <dt>Actions</dt>
      <dd><div class="actions">${renderClaudeActions(session)}</div></dd>
    </dl>
  </article>`;
}

function renderOpenClaudeSessionLink(session: ClaudeSession): string {
  if (session.status === "archived") {
    return `<span class="inline-action static" title="Archived chats can't be opened">${escapeHtml(session.id)}</span>`;
  }

  return `<button class="inline-action" type="button" data-command="openClaudeAgent" data-session-id="${escapeAttr(session.id)}" title="Resume Claude session">${escapeHtml(session.id)}</button>`;
}

function renderClaudeAgentMessage(session: ClaudeSession): string {
  const message = session.lastMessage || "No agent message found.";
  const content = escapeHtml(truncateLines(message));
  const title = escapeAttr(`Open transcript\n\n${session.lastMessage || ""}`);
  return `<button class="inline-action message" type="button" data-command="openTranscript" data-path="${escapeAttr(session.transcriptPath)}" title="${title}">${content}</button>`;
}

function renderClaudeSessionUsage(session: ClaudeSession): string {
  const usage = session.usage;
  if (!usage) {
    return `<div class="meta">No usage data</div>`;
  }

  const contextPercent = computeContextPercent(usage.contextTokens);
  const overLimit = contextPercent !== undefined && contextPercent > 100;
  const contextTitle = `${formatNumber(usage.contextTokens)} / ${formatNumber(CONTEXT_WINDOW_TOKENS)} tokens (assumed)`;
  const durationText = session.lastRunDurationMs !== undefined ? formatDuration(session.lastRunDurationMs) : "";

  return `<div class="session-usage">
    <div class="meta">Total ${escapeHtml(formatCompactNumber(usage.totalTokens))} tokens</div>
    <div class="meta">Last run ${escapeHtml(formatCompactNumber(usage.lastRunTokens))} tokens${durationText ? ` · ${escapeHtml(durationText)}` : ""}</div>
    <div class="meta" title="${escapeAttr(contextTitle)}">Context ${contextPercent !== undefined ? `${Math.round(contextPercent)}%` : "unknown"}</div>
    <div class="usage-track" title="${escapeAttr(contextTitle)}"><div class="usage-fill${overLimit ? " over-limit" : ""}" style="width: ${Math.min(100, contextPercent ?? 0)}%"></div></div>
  </div>`;
}

function renderClaudeActions(session: ClaudeSession & { isOpenInTerminal: boolean }): string {
  const reviewButton =
    session.status === "needs-input"
      ? `<button type="button" data-command="approveClaudeSession" data-session-id="${escapeAttr(session.id)}">Approve</button><button type="button" data-command="alwaysApproveClaudeSession" data-session-id="${escapeAttr(session.id)}">Always Approve</button>`
      : session.status === "archived" || session.status === "running"
      ? ""
      : session.status === "reviewed"
      ? `<button class="secondary" type="button" data-command="markClaudeUnreviewed" data-session-id="${escapeAttr(session.id)}">Unreview</button>`
      : `<button type="button" data-command="markClaudeReviewed" data-session-id="${escapeAttr(session.id)}">Reviewed</button>`;
  const compactButton = session.isOpenInTerminal
    ? `<button class="secondary" type="button" data-command="compactClaudeSession" data-session-id="${escapeAttr(session.id)}">Compact</button>`
    : "";
  const archiveButton =
    session.status !== "archived"
      ? `<button class="secondary" type="button" data-command="archiveClaudeSession" data-session-id="${escapeAttr(session.id)}">Archive</button>`
      : "";
  const archivedActions =
    session.status === "archived"
      ? `<button class="secondary" type="button" data-command="unarchiveClaudeSession" data-session-id="${escapeAttr(session.id)}">Unarchive</button><button class="secondary" type="button" data-command="deleteClaudeSession" data-session-id="${escapeAttr(session.id)}">Delete</button>`
      : "";

  return `${compactButton}${archiveButton}${archivedActions}${reviewButton}`;
}

function claudeStatusInfo(status: ClaudeSessionStatus): { badgeClass: string; label: string } {
  switch (status) {
    case "running":
      return { badgeClass: "running", label: "running" };
    case "needs-input":
      return { badgeClass: "needs-approval", label: "needs input" };
    case "archived":
      return { badgeClass: "archived", label: "archived" };
    case "reviewed":
      return { badgeClass: "reviewed", label: "reviewed" };
    case "idle":
    default:
      return { badgeClass: "done-review", label: "done" };
  }
}

function renderClaudeStatus(status: ClaudeSessionStatus): string {
  const info = claudeStatusInfo(status);
  return `<span class="badge ${info.badgeClass}">${escapeHtml(info.label)}</span>`;
}

function renderClaudeUsageSection(usage: ClaudeUsageSummary | undefined, fetching: boolean): string {
  const refreshButton = `<button class="${fetching ? "secondary" : "claude-usage-button"}" type="button" data-command="refreshClaudeUsage" ${
    fetching ? "disabled" : ""
  }>${fetching ? "Checking..." : "Check usage"}</button>`;
  const titleAttr = usage?.checkedAtMs ? ` title="${escapeAttr(`Usage captured ${formatDate(usage.checkedAtMs)}`)}"` : "";
  const referenceMs = usage?.checkedAtMs ?? Date.now();

  return `<section class="usage claude-usage"${titleAttr}>
    ${renderClaudeUsageWindow("Session usage", usage?.sessionPercent, normalizeClaudeResetLabel(usage?.sessionResets, referenceMs))}
    ${renderClaudeUsageWindow("Week usage", usage?.weekPercent, normalizeClaudeResetLabel(usage?.weekResets, referenceMs))}
    <div class="usage-actions">${refreshButton}</div>
  </section>`;
}

function renderClaudeUsageWindow(label: string, percent: number | undefined, resets: string | undefined): string {
  if (percent === undefined) {
    return `<div class="usage-window">
      <div class="usage-label"><strong>${escapeHtml(label)}</strong><span>not checked yet</span></div>
      <div class="usage-track"><div class="usage-fill" style="width: 0%"></div></div>
    </div>`;
  }

  return `<div class="usage-window">
    <div class="usage-label"><strong>${escapeHtml(label)}</strong><span>${percent}% used${
    resets ? ` · resets ${escapeHtml(resets)}` : ""
  }</span></div>
    <div class="usage-track"><div class="usage-fill" style="width: ${Math.min(100, percent)}%"></div></div>
  </div>`;
}

function renderUsage(scan: AgentScan, manualUsage: CodexUsageSummary | undefined, fetching: boolean): string {
  const primary = combineCodexUsageWindow(
    manualUsage ? { percent: manualUsage.primaryPercent, resetsAt: manualUsage.primaryResetsAt, capturedAtMs: manualUsage.checkedAtMs } : undefined,
    scan.usage?.primary
      ? { ...scan.usage.primary, capturedAtMs: Date.parse(scan.usage.capturedAt) }
      : undefined
  );
  const secondary = combineCodexUsageWindow(
    manualUsage ? { percent: manualUsage.secondaryPercent, resetsAt: manualUsage.secondaryResetsAt, capturedAtMs: manualUsage.checkedAtMs } : undefined,
    scan.usage?.secondary
      ? { ...scan.usage.secondary, capturedAtMs: Date.parse(scan.usage.capturedAt) }
      : undefined
  );

  const checkButton = `<button class="${fetching ? "secondary" : ""}" type="button" data-command="refreshCodexUsage" ${
    fetching ? "disabled" : ""
  }>${fetching ? "Checking..." : "Check usage"}</button>`;
  const transcriptCapturedAtMs = scan.usage ? Date.parse(scan.usage.capturedAt) : undefined;
  const capturedAtMs = latestTimestamp(manualUsage?.checkedAtMs, transcriptCapturedAtMs);
  const capturedText = capturedAtMs !== undefined ? formatFriendlyDateTime(capturedAtMs) : undefined;
  const titleAttr = capturedText !== undefined ? ` title="${escapeAttr(`Usage captured ${capturedText}`)}"` : "";
  const checkedText = capturedText ? `<span class="meta">reported ${escapeHtml(capturedText)}</span>` : "";
  const emptyClass = !primary && !secondary ? " empty" : "";

  return `<section class="usage${emptyClass}"${titleAttr}>
    ${renderUsageWindow("5h usage", primary)}
    ${renderUsageWindow("7d usage", secondary)}
    <div class="usage-actions">${checkButton}${checkedText}</div>
  </section>`;
}

type CombinedUsageWindow = { usedPercent: number; resetsAt?: number };

function combineCodexUsageWindow(
  manual: { percent: number | undefined; resetsAt: number | undefined; capturedAtMs: number } | undefined,
  transcript: { usedPercent: number; resetsAt?: number; capturedAtMs: number } | undefined
): CombinedUsageWindow | undefined {
  const manualWindow =
    manual?.percent !== undefined && Number.isFinite(manual.capturedAtMs)
      ? { usedPercent: manual.percent, resetsAt: manual.resetsAt, capturedAtMs: manual.capturedAtMs }
      : undefined;
  const transcriptWindow =
    transcript && Number.isFinite(transcript.capturedAtMs)
      ? { usedPercent: transcript.usedPercent, resetsAt: transcript.resetsAt, capturedAtMs: transcript.capturedAtMs }
      : undefined;
  const latest =
    manualWindow && transcriptWindow
      ? manualWindow.capturedAtMs >= transcriptWindow.capturedAtMs
        ? manualWindow
        : transcriptWindow
      : manualWindow ?? transcriptWindow;

  return latest ? { usedPercent: latest.usedPercent, resetsAt: latest.resetsAt } : undefined;
}

function renderUsageWindow(label: string, usage: CombinedUsageWindow | undefined): string {
  if (!usage) {
    return `<div class="usage-window">
      <div class="usage-label"><strong>${escapeHtml(label)}</strong><span>unavailable</span></div>
      <div class="usage-track"><div class="usage-fill" style="width: 0%"></div></div>
    </div>`;
  }

  return `<div class="usage-window">
    <div class="usage-label"><strong>${escapeHtml(label)}</strong><span>${Math.round(usage.usedPercent)}% · resets ${escapeHtml(usage.resetsAt ? formatFriendlyDateTime(usage.resetsAt * 1000) : "unknown")}</span></div>
    <div class="usage-track"><div class="usage-fill" style="width: ${usage.usedPercent}%"></div></div>
  </div>`;
}

function latestTimestamp(...timestamps: Array<number | undefined>): number | undefined {
  const finiteTimestamps = timestamps.filter((timestamp): timestamp is number => timestamp !== undefined && Number.isFinite(timestamp));
  if (finiteTimestamps.length === 0) {
    return undefined;
  }

  return Math.max(...finiteTimestamps);
}

// Both cards render their "resets" date through this same formatter so that the two usage
// sections read as one design language instead of Codex showing a locale date string
// ("7/8/2026, 2:18:35 PM") next to Claude's raw CLI phrasing ("Jul 8, 6:39pm").
function formatFriendlyDateTime(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) {
    return "unknown";
  }

  const month = date.toLocaleString(undefined, { month: "short" });
  const day = date.getDate();
  const year = date.getFullYear();
  const hours24 = date.getHours();
  const minutes = date.getMinutes();
  const meridiem = hours24 >= 12 ? "PM" : "AM";
  const hours = hours24 % 12 || 12;
  return `${month} ${day}, ${year}, ${hours}:${String(minutes).padStart(2, "0")} ${meridiem}`;
}

const MONTH_ABBREVIATIONS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Claude's "/usage" CLI output gives resets as free text like "Jul 11, 8:59pm (America/New_York)"
// with no year and no seconds. Reparsing that into a real Date would require assuming a timezone,
// which risks silently shifting the displayed time - so instead this only reformats the pieces the
// CLI already gave us (adding the year for context, dropping the parenthetical zone name) to match
// formatFriendlyDateTime's shape. Falls back to the raw string if the CLI's phrasing ever changes.
function normalizeClaudeResetLabel(raw: string | undefined, referenceMs: number): string | undefined {
  if (!raw) {
    return undefined;
  }

  const match = raw.match(/^([A-Za-z]{3})\w*\s+(\d{1,2}),?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) {
    return raw;
  }

  const [, month, day, hour, minute = "00", meridiem] = match;
  const referenceDate = new Date(referenceMs);
  const resetMonthIndex = MONTH_ABBREVIATIONS.indexOf(month.toLowerCase());
  // Session/week windows only ever reset a few hours or days out, so the only way the reset's
  // month can appear "earlier" than the reference month is a wrap into next year (e.g. checking
  // on Dec 30 with a reset on Jan 2) - never a same-year rollback.
  const year =
    resetMonthIndex !== -1 && resetMonthIndex < referenceDate.getMonth()
      ? referenceDate.getFullYear() + 1
      : referenceDate.getFullYear();
  return `${month} ${day}, ${year}, ${hour}:${minute} ${meridiem.toUpperCase()}`;
}

function summaryTooltip(summary: AgentScan["summary"], timings?: AgentScan["timings"]): string {
  return [
    `Running: ${summary.running}`,
    `Needs approval: ${summary.needsApproval}`,
    `Done: ${summary.doneReview}`,
    `Reviewed: ${summary.reviewed}`,
    `Archived: ${summary.archived}`,
    `Unknown: ${summary.unknown}`,
    timings
      ? `Scan: ${timings.totalMs}ms (index ${timings.indexMs}ms, transcripts ${timings.transcriptsMs}ms, processes ${timings.processMs}ms)`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function truncateLines(value: string): string {
  return truncate(value, 220);
}

function formatDate(value: string | number | undefined): string {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "unknown";
  }

  return date.toLocaleString();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
