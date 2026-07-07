import * as os from "os";
import * as vscode from "vscode";
import { updateAgentMonitorOptions, type AgentMonitorConfig } from "./config";
import { ReviewState } from "./reviewState";
import { scanAgents } from "./scanner";
import type { AgentScan, AgentSession, AgentStatus } from "./types";

export const dashboardViewType = "agentMonitor.dashboard";

type DashboardMessage = {
  command?: string;
  sessionId?: string;
  sessionIds?: string[];
  path?: string;
  setting?: "openOnStartup" | "pinOnStartup" | "autoCompactOnReview";
  value?: boolean;
};

export class Dashboard {
  private panel: vscode.WebviewPanel | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastScan: AgentScan | undefined;
  private refreshPromise: Promise<AgentScan> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly reviewState: ReviewState,
    private getConfig: () => AgentMonitorConfig
  ) {}

  open(pin = false): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      if (pin) {
        void this.pinPanel();
      }
      void this.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(dashboardViewType, "Agent Monitor", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true
    });

    this.attachPanel(panel);
    if (pin) {
      void this.pinPanel();
    }
  }

  restore(panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true
    };
    this.attachPanel(panel);
  }

  hasPanel(): boolean {
    return this.panel !== undefined;
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
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

  async refresh(): Promise<AgentScan> {
    if (this.refreshPromise) {
      return this.refreshPromise;
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
    const runningReviewedIds = scan.sessions
      .filter((session) => session.status === "running" && session.reviewedAt)
      .map((session) => session.id);
    if (runningReviewedIds.length > 0) {
      await this.reviewState.markUnreviewed(runningReviewedIds);
      scan = await scanAgents(this.getConfig(), this.reviewState.getReviewed());
    }
    this.lastScan = scan;
    if (this.panel) {
      this.panel.webview.html = renderDashboard(scan, this.getConfig());
    }
    return scan;
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

      if (message.command === "approveSession" && message.sessionId) {
        this.sendApproval(message.sessionId, "y");
        return;
      }

      if (message.command === "alwaysApproveSession" && message.sessionId) {
        this.sendApproval(message.sessionId, "p");
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
        await this.refresh();
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Agent Monitor: ${messageText}`);
    }
  }

  openAgent(sessionId: string): void {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    const terminalName = terminalNameForSession(session?.name);
    const existingTerminal = vscode.window.terminals.find((terminal) => terminal.name === terminalName);
    if (existingTerminal) {
      existingTerminal.show();
      return;
    }

    const terminal = vscode.window.createTerminal({
      cwd: os.homedir(),
      name: terminalName
    });
    terminal.show();
    terminal.sendText(`codex resume ${sessionId}`);
  }

  sendApproval(sessionId: string, approval: "y" | "p"): void {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    const terminalName = terminalNameForSession(session?.name);
    const existingTerminal = vscode.window.terminals.find((terminal) => terminal.name === terminalName);
    if (!existingTerminal) {
      this.openAgent(sessionId);
      void vscode.window.showWarningMessage(`Agent Monitor opened ${terminalName}. Send approval again once the prompt is visible.`);
      return;
    }

    existingTerminal.show();
    existingTerminal.sendText(approval);
  }

  async markReviewed(sessionId: string): Promise<void> {
    await this.reviewState.markReviewed([sessionId]);
    if (this.getConfig().autoCompactOnReview) {
      await this.sendCompact(sessionId);
    }
    await this.refresh();
  }

  private async sendCompact(sessionId: string): Promise<void> {
    const session = this.lastScan?.sessions.find((session) => session.id === sessionId);
    const terminalName = terminalNameForSession(session?.name);
    const existingTerminal = vscode.window.terminals.find((terminal) => terminal.name === terminalName);
    if (existingTerminal) {
      existingTerminal.show();
      existingTerminal.sendText("/compact");
      return;
    }

    this.openAgent(sessionId);
    await vscode.env.clipboard.writeText("/compact");
    void vscode.window.showWarningMessage(`Auto compact failed for ${terminalName}. Paste /compact into the terminal manually.`);
  }

  private async pinPanel(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await vscode.commands.executeCommand("workbench.action.pinEditor");
  }
}

function renderDashboard(scan: AgentScan, config: AgentMonitorConfig): string {
  const cards = scan.sessions.map(renderSessionCard).join("");
  const rows = scan.sessions.map(renderSessionRow).join("");
  const empty = scan.sessions.length === 0 ? `<div class="empty">No Codex chats found in ${escapeHtml(scan.codexHome)}.</div>` : "";
  const summaryTitle = summaryTooltip(scan.summary);
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
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      margin: 0 0 14px;
      padding: 10px;
    }

    .usage.empty {
      display: block;
      text-align: left;
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
        <div class="summary" title="${escapeAttr(summaryTitle)}">${scan.summary.total} sessions · <span id="refresh-status">Refreshing in <span id="refresh-countdown">${refreshSeconds}</span>s</span></div>
      </div>
      <div class="header-actions">
        <label class="checkbox-control"><input type="checkbox" data-setting="openOnStartup" ${config.openOnStartup ? "checked" : ""}> Open on startup</label>
        <label class="checkbox-control"><input type="checkbox" data-setting="pinOnStartup" ${config.pinOnStartup ? "checked" : ""}> Pin on startup</label>
        <label class="checkbox-control"><input type="checkbox" data-setting="autoCompactOnReview" ${config.autoCompactOnReview ? "checked" : ""}> Auto compact on review</label>
        <button type="button" data-command="refresh">Refresh</button>
      </div>
    </header>

    <section class="stats" aria-label="Agent chat summary">
      ${renderStat("Running", scan.summary.running, "running")}
      ${renderStat("Needs Approval", scan.summary.needsApproval, "needs-approval")}
      ${renderStat("Done", scan.summary.doneReview, "done-review")}
      ${renderStat("Reviewed", scan.summary.reviewed, "reviewed")}
      ${renderStat("Archived", scan.summary.archived, "archived")}
      ${renderStat("Unknown", scan.summary.unknown, "unknown")}
    </section>

    ${renderUsage(scan)}

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
    const selectedStatuses = new Set(persistedState.selectedStatuses || []);
    const refreshSeconds = ${refreshSeconds};
    let countdown = refreshSeconds;
    let refreshing = false;

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

    function requestRefresh() {
      if (refreshing) {
        return;
      }
      refreshing = true;
      setRefreshStatus();
      vscode.postMessage({ command: "refresh" });
    }

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

      const button = event.target.closest("button[data-command]");
      if (!button) {
        return;
      }

      if (button.dataset.command === "refresh") {
        requestRefresh();
        return;
      }

      vscode.postMessage({
        command: button.dataset.command,
        sessionId: button.dataset.sessionId,
        path: button.dataset.path
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

function terminalNameForSession(sessionName: string | undefined): string {
  return `${sessionName?.trim() || "Agent"} | Codex`;
}

function renderSessionCard(session: AgentSession): string {
  return `<article class="card" data-session-status="${escapeAttr(session.status)}">
    <div class="card-top">
      <div>
        <h2>${escapeHtml(session.name)}</h2>
        <div class="meta session-id">${escapeHtml(session.id)}</div>
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
      <dd><div class="message" title="${escapeAttr(session.lastMessage || "")}">${escapeHtml(truncateLines(session.lastMessage || "No agent message found."))}</div></dd>
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
      <div class="meta session-id">${escapeHtml(session.id)}</div>
    </td>
    <td>${renderStatus(session.status)}</td>
    <td>
      <div>${escapeHtml(formatDate(session.updatedAtMs || session.updatedAt))}</div>
      ${session.lastCompletionAt ? `<div class="meta">completed ${escapeHtml(formatDate(session.lastCompletionAt))}</div>` : ""}
      ${session.reviewedAt ? `<div class="meta">reviewed ${escapeHtml(formatDate(session.reviewedAt))}</div>` : ""}
    </td>
    <td>${renderSessionUsage(session)}</td>
    <td><div class="message" title="${escapeAttr(session.lastUserMessage || "")}">${escapeHtml(truncateLines(session.lastUserMessage || "No user message found."))}</div></td>
    <td><div class="message" title="${escapeAttr(session.lastMessage || "")}">${escapeHtml(truncateLines(session.lastMessage || "No agent message found."))}</div></td>
    <td><div class="actions">${renderActions(session)}</div></td>
  </tr>`;
}

function renderSessionUsage(session: AgentSession): string {
  const usage = session.usage;
  if (!usage) {
    return `<div class="meta">No usage data</div>`;
  }

  const totalTokens = usage.totalTokenUsage?.totalTokens;
  const contextTokens = usage.lastTokenUsage?.inputTokens;
  const contextWindow = usage.modelContextWindow;
  const contextPercent =
    contextTokens !== undefined && contextWindow !== undefined && contextWindow > 0
      ? Math.max(0, Math.min(100, (contextTokens / contextWindow) * 100))
      : undefined;
  const contextTitle =
    contextTokens !== undefined && contextWindow !== undefined
      ? `${formatNumber(contextTokens)} / ${formatNumber(contextWindow)} tokens`
      : "Context window unavailable";

  return `<div class="session-usage">
    <div class="meta">Total ${totalTokens !== undefined ? escapeHtml(formatNumber(totalTokens)) : "unknown"} tokens</div>
    <div class="meta" title="${escapeAttr(contextTitle)}">Context ${contextPercent !== undefined ? `${Math.round(contextPercent)}%` : "unknown"}</div>
    <div class="usage-track" title="${escapeAttr(contextTitle)}"><div class="usage-fill" style="width: ${contextPercent ?? 0}%"></div></div>
  </div>`;
}

function renderActions(session: AgentSession): string {
  const transcriptButton = session.transcriptPath
    ? `<button class="secondary" type="button" data-command="openTranscript" data-path="${escapeAttr(session.transcriptPath)}">Transcript</button>`
    : "";
  const reviewButton =
    session.status === "needs-approval"
      ? `<button type="button" data-command="approveSession" data-session-id="${escapeAttr(session.id)}">Approve</button><button type="button" data-command="alwaysApproveSession" data-session-id="${escapeAttr(session.id)}">Always Approve</button>`
      : session.status === "archived" || session.status === "running"
      ? ""
      : session.status === "reviewed"
      ? `<button class="secondary" type="button" data-command="markUnreviewed" data-session-id="${escapeAttr(session.id)}">Unreview</button>`
      : `<button type="button" data-command="markReviewed" data-session-id="${escapeAttr(session.id)}">Reviewed</button>`;

  return `<button class="secondary" type="button" data-command="openAgent" data-session-id="${escapeAttr(session.id)}">Open</button>${transcriptButton}${reviewButton}`;
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

function renderUsage(scan: AgentScan): string {
  if (!scan.usage) {
    return `<section class="usage empty">No usage data found in Codex transcripts.</section>`;
  }

  return `<section class="usage" title="Usage captured ${escapeAttr(formatDate(scan.usage.capturedAt))}">
    ${scan.usage.primary ? renderUsageWindow("5h usage", scan.usage.primary) : ""}
    ${scan.usage.secondary ? renderUsageWindow("7d usage", scan.usage.secondary) : ""}
  </section>`;
}

function renderUsageWindow(label: string, usage: NonNullable<AgentScan["usage"]>["primary"]): string {
  if (!usage) {
    return "";
  }

  return `<div class="usage-window">
    <div class="usage-label"><strong>${escapeHtml(label)}</strong><span>${Math.round(usage.usedPercent)}% · resets ${escapeHtml(formatUnixSeconds(usage.resetsAt))}</span></div>
    <div class="usage-track"><div class="usage-fill" style="width: ${usage.usedPercent}%"></div></div>
  </div>`;
}

function summaryTooltip(summary: AgentScan["summary"]): string {
  return [
    `Running: ${summary.running}`,
    `Needs approval: ${summary.needsApproval}`,
    `Done: ${summary.doneReview}`,
    `Reviewed: ${summary.reviewed}`,
    `Archived: ${summary.archived}`,
    `Unknown: ${summary.unknown}`
  ].join("\n");
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

function formatUnixSeconds(value: number | undefined): string {
  return value ? formatDate(value * 1000) : "unknown";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
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
