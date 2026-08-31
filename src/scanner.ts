import { execFile } from "child_process";
import { createReadStream } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import { promisify } from "util";
import type { AgentMonitorConfig } from "./config";
import type { ReviewMap } from "./reviewState";
import type {
  AgentScan,
  AgentScanDiagnostic,
  AgentSession,
  AgentStatus,
  AgentSummary,
  AgentTokenUsage,
  AgentUsage
} from "./types";

const execFileAsync = promisify(execFile);

type IndexedSession = {
  id: string;
  thread_name?: string;
  updated_at?: string;
};

type TranscriptInfo = {
  sessionId: string;
  path: string;
  mtimeMs: number;
  archived: boolean;
  title?: string;
  firstUserMessage?: string;
  lastUserMessage?: string;
  lastMessage?: string;
  approvalReason?: string;
  approvalCommand?: string;
  lastCompletionAt?: string;
  lastRunDurationMs?: number;
  pendingApprovalAt?: string;
  hasCompletion: boolean;
  hasPendingApproval: boolean;
  usage?: AgentUsage;
  latestUserAt?: string;
  latestAbortAt?: string;
};

type CachedTranscriptInfo = TranscriptInfo & {
  size: number;
  processedBytes: number;
  lastCompletionMs: number;
  latestUserMs: number;
  latestAbortMs: number;
  previousUsage?: AgentUsage;
  userTurnBaselineUsage?: AgentUsage;
  pendingApprovalCalls: Map<string, number>;
  pendingApprovalAt?: string;
  approvalReasonCandidate?: string;
  approvalCommandCandidate?: string;
};

type CodexTranscriptLine = {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    session_id?: string;
    thread_name?: string;
    type?: string;
    role?: string;
    message?: string;
    content?: Array<{ type?: string; text?: string }>;
    last_agent_message?: string;
    completed_at?: number;
    name?: string;
    arguments?: string;
    call_id?: string;
    rate_limits?: unknown;
    info?: unknown;
  };
};

const transcriptCache = new Map<string, CachedTranscriptInfo>();

export async function scanAgents(config: AgentMonitorConfig, reviewed: ReviewMap): Promise<AgentScan> {
  const diagnostics: AgentScanDiagnostic[] = [];
  const scanStartedAt = Date.now();
  const indexStartedAt = Date.now();
  const index = await readSessionIndex(config.codexHome, diagnostics);
  const indexMs = Date.now() - indexStartedAt;
  const processStartedAt = Date.now();
  const activeProcessCount = await countActiveCodexProcesses(diagnostics);
  const processMs = Date.now() - processStartedAt;
  const transcriptStartedAt = Date.now();
  const transcripts = await readAllTranscripts(config.codexHome, diagnostics);
  const transcriptsMs = Date.now() - transcriptStartedAt;
  const indexedIds = new Set(index.map((session) => session.id));
  const unindexedEntries: IndexedSession[] = [...transcripts.keys()]
    .filter((sessionId) => !indexedIds.has(sessionId))
    .map((sessionId) => ({ id: sessionId }));
  const sessions = [...index, ...unindexedEntries].map((session) =>
    buildAgentSession(session, config, reviewed, activeProcessCount, transcripts)
  );
  const sortedSessions = sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    codexHome: config.codexHome,
    scannedAt: new Date().toISOString(),
    sessions: sortedSessions,
    summary: summarize(sortedSessions),
    usage: latestUsage(transcripts),
    timings: {
      totalMs: Date.now() - scanStartedAt,
      indexMs,
      transcriptsMs,
      processMs
    },
    diagnostics
  };
}

function buildAgentSession(
  session: IndexedSession,
  config: AgentMonitorConfig,
  reviewed: ReviewMap,
  activeProcessCount: number,
  transcripts: Map<string, TranscriptInfo>
): AgentSession {
  const transcript = transcripts.get(session.id);
  const updatedAtMs = parseTime(session.updated_at) ?? transcript?.mtimeMs ?? 0;
  const reviewedAt = reviewed[session.id];
  const status = deriveStatus(transcript, reviewedAt, config.runningActivitySeconds, activeProcessCount);
  const fallbackName = transcript?.firstUserMessage ? truncate(transcript.firstUserMessage, 60) : session.id;
  const name = session.thread_name?.trim() || transcript?.title || fallbackName;
  const nameIsFallback = !session.thread_name?.trim() && !transcript?.title;

  return {
    id: session.id,
    name,
    nameIsFallback,
    status,
    updatedAt: session.updated_at,
    updatedAtMs,
    transcriptPath: transcript?.path,
    transcriptMtimeMs: transcript?.mtimeMs,
    lastUserMessage: transcript?.lastUserMessage,
    lastMessage: transcript?.lastMessage,
    approvalReason: transcript?.approvalReason,
    approvalCommand: transcript?.approvalCommand,
    lastCompletionAt: transcript?.lastCompletionAt,
    lastRunDurationMs: transcript?.lastRunDurationMs,
    reviewedAt,
    usage: transcript?.usage
  };
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function deriveStatus(
  transcript: TranscriptInfo | undefined,
  reviewedAt: string | undefined,
  runningActivitySeconds: number,
  activeProcessCount: number
): AgentStatus {
  if (transcript?.archived) {
    return "archived";
  }

  if (!transcript) {
    return reviewedAt ? "reviewed" : "done-review";
  }

  if (transcript.hasPendingApproval) {
    return "needs-approval";
  }

  if (!transcript.hasCompletion && isRecent(transcript.mtimeMs, runningActivitySeconds)) {
    return "running";
  }

  if (!transcript.hasCompletion && activeProcessCount > 0 && isRecent(transcript.mtimeMs, runningActivitySeconds * 3)) {
    return "running";
  }

  return reviewedAt ? "reviewed" : "done-review";
}

async function readSessionIndex(codexHome: string, diagnostics: AgentScanDiagnostic[]): Promise<IndexedSession[]> {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  let content = "";
  try {
    content = await fs.readFile(indexPath, "utf8");
  } catch (error) {
    diagnostics.push(diagnostic("warning", indexPath, `Could not read session index: ${errorMessage(error)}`));
    return [];
  }

  const sessions = new Map<string, IndexedSession>();
  let invalidLines = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as IndexedSession;
      if (parsed.id) {
        sessions.set(parsed.id, parsed);
      }
    } catch {
      invalidLines += 1;
      continue;
    }
  }
  if (invalidLines > 0) {
    diagnostics.push(diagnostic("warning", indexPath, `Skipped ${invalidLines} invalid session index line(s).`));
  }

  return [...sessions.values()];
}

async function readAllTranscripts(codexHome: string, diagnostics: AgentScanDiagnostic[]): Promise<Map<string, TranscriptInfo>> {
  const activeFiles = await walkJsonl(path.join(codexHome, "sessions"), diagnostics);
  const archivedFiles = await walkJsonl(path.join(codexHome, "archived_sessions"), diagnostics);
  const activeInfos = await Promise.all(activeFiles.map((file) => readTranscriptInfo(file, false, diagnostics)));
  const archivedInfos = await Promise.all(archivedFiles.map((file) => readTranscriptInfo(file, true, diagnostics)));
  const transcripts = new Map<string, TranscriptInfo>();

  for (const info of activeInfos) {
    transcripts.set(info.sessionId, info);
  }

  for (const info of archivedInfos) {
    if (!transcripts.has(info.sessionId)) {
      transcripts.set(info.sessionId, info);
    }
  }

  return transcripts;
}

async function walkJsonl(root: string, diagnostics: AgentScanDiagnostic[]): Promise<string[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (!isMissingPathError(error)) {
      diagnostics.push(diagnostic("warning", root, `Could not read transcript folder: ${errorMessage(error)}`));
    }
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return walkJsonl(fullPath, diagnostics);
      }
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
    })
  );

  return nested.flat();
}

async function readTranscriptInfo(
  transcriptPath: string,
  archived: boolean,
  diagnostics: AgentScanDiagnostic[]
): Promise<TranscriptInfo> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(transcriptPath);
  } catch (error) {
    diagnostics.push(diagnostic("error", transcriptPath, `Could not read transcript: ${errorMessage(error)}`));
    return {
      sessionId: parseSessionIdFromPath(transcriptPath),
      path: transcriptPath,
      mtimeMs: 0,
      archived,
      hasCompletion: false,
      hasPendingApproval: false
    };
  }

  const cached = transcriptCache.get(transcriptPath);
  const size = Number(stat.size);
  const mtimeMs = Number(stat.mtimeMs);
  const shouldReuse =
    cached && cached.archived === archived && cached.size === size && cached.mtimeMs === mtimeMs;
  if (shouldReuse) {
    return finalizeTranscriptInfo(cached, stat, archived);
  }

  const canAppend = cached && cached.archived === archived && size >= cached.processedBytes;
  const state = canAppend ? cached : createTranscriptCacheEntry(transcriptPath, archived);
  const startOffset = canAppend ? state.processedBytes : 0;
  let malformedLines = 0;

  try {
    state.processedBytes = await processNewCompleteLines(transcriptPath, startOffset, size, (line) => {
      try {
        applyTranscriptLine(state, JSON.parse(line) as CodexTranscriptLine);
      } catch {
        malformedLines += 1;
      }
    });
  } catch (error) {
    diagnostics.push(diagnostic("error", transcriptPath, `Could not read transcript: ${errorMessage(error)}`));
    return finalizeTranscriptInfo(state, stat, archived);
  }

  if (malformedLines > 0) {
    diagnostics.push(diagnostic("warning", transcriptPath, `Skipped ${malformedLines} malformed transcript line(s).`));
  }

  transcriptCache.set(transcriptPath, state);
  return finalizeTranscriptInfo(state, stat, archived);
}

function createTranscriptCacheEntry(transcriptPath: string, archived: boolean): CachedTranscriptInfo {
  return {
    sessionId: parseSessionIdFromPath(transcriptPath),
    path: transcriptPath,
    mtimeMs: 0,
    size: 0,
    processedBytes: 0,
    archived,
    hasCompletion: false,
    hasPendingApproval: false,
    lastCompletionMs: 0,
    latestUserMs: 0,
    latestAbortMs: 0,
    pendingApprovalCalls: new Map<string, number>()
  };
}

function finalizeTranscriptInfo(
  state: CachedTranscriptInfo,
  stat: Awaited<ReturnType<typeof fs.stat>>,
  archived: boolean
): TranscriptInfo {
  const hasCompletion =
    state.lastCompletionMs > 0 && state.lastCompletionMs >= state.latestUserMs && state.lastCompletionMs >= state.latestAbortMs;
  const lastRunDurationMs = hasCompletion && state.latestUserMs > 0 ? state.lastCompletionMs - state.latestUserMs : undefined;
  const latestPendingApprovalMs = Math.max(0, ...state.pendingApprovalCalls.values());
  const hasPendingApproval =
    latestPendingApprovalMs > 0 &&
    latestPendingApprovalMs >= state.latestUserMs &&
    latestPendingApprovalMs >= state.lastCompletionMs &&
    latestPendingApprovalMs >= state.latestAbortMs;

  state.mtimeMs = Number(stat.mtimeMs);
  state.size = Number(stat.size);
  state.archived = archived;
  state.hasCompletion = hasCompletion;
  state.hasPendingApproval = hasPendingApproval;
  state.lastRunDurationMs = lastRunDurationMs;
  state.approvalReason = hasPendingApproval ? state.approvalReasonCandidate : undefined;
  state.approvalCommand = hasPendingApproval ? state.approvalCommandCandidate : undefined;
  state.lastCompletionAt = hasCompletion ? state.lastCompletionAt : undefined;
  state.pendingApprovalAt = hasPendingApproval ? state.pendingApprovalAt : undefined;

  return {
    sessionId: state.sessionId,
    path: state.path,
    mtimeMs: Number(stat.mtimeMs),
    archived,
    title: state.title,
    firstUserMessage: state.firstUserMessage,
    lastUserMessage: state.lastUserMessage,
    lastMessage: state.lastMessage,
    approvalReason: state.approvalReason,
    approvalCommand: state.approvalCommand,
    lastCompletionAt: state.lastCompletionAt,
    lastRunDurationMs,
    pendingApprovalAt: state.pendingApprovalAt,
    hasCompletion,
    hasPendingApproval,
    usage: state.usage,
    latestUserAt: state.latestUserAt,
    latestAbortAt: state.latestAbortAt
  };
}

function applyTranscriptLine(state: CachedTranscriptInfo, parsed: CodexTranscriptLine): void {
  const timestampMs = parseTime(parsed.timestamp) ?? 0;

  if (parsed.type === "session_meta") {
    state.sessionId = parsed.payload?.id || parsed.payload?.session_id || state.sessionId;
    state.title = parsed.payload?.thread_name || state.title;
  }

  if (
    (parsed.type === "event_msg" && parsed.payload?.type === "user_message") ||
    (parsed.type === "response_item" && parsed.payload?.type === "message" && parsed.payload.role === "user")
  ) {
    const userMessage = extractUserMessage(parsed.payload);
    if (userMessage) {
      state.latestUserAt = parsed.timestamp;
      state.latestUserMs = timestampMs;
      state.userTurnBaselineUsage = state.previousUsage;
      state.lastUserMessage = userMessage;
      if (state.firstUserMessage === undefined) {
        state.firstUserMessage = userMessage;
      }
    }
  }

  if (parsed.type === "event_msg" && parsed.payload?.type === "agent_message" && parsed.payload.message) {
    state.lastMessage = parsed.payload.message;
  }

  if (parsed.type === "event_msg" && parsed.payload?.type === "task_complete") {
    state.lastCompletionAt = parsed.timestamp;
    state.lastCompletionMs = timestampMs;
    if (parsed.payload.last_agent_message) {
      state.lastMessage = parsed.payload.last_agent_message;
    }
  }

  if (parsed.type === "event_msg" && parsed.payload?.type === "turn_aborted") {
    state.latestAbortAt = parsed.timestamp;
    state.latestAbortMs = timestampMs;
  }

  if (parsed.type === "response_item" && parsed.payload?.type === "function_call" && parsed.payload.name === "exec_command") {
    const permissionRequest = parsePermissionRequest(parsed.payload.arguments);
    if (permissionRequest && parsed.payload.call_id) {
      state.pendingApprovalCalls.set(parsed.payload.call_id, timestampMs);
      state.pendingApprovalAt = parsed.timestamp;
      state.approvalReasonCandidate = permissionRequest.reason;
      state.approvalCommandCandidate = permissionRequest.command;
      state.lastMessage = formatPermissionMessage(permissionRequest);
    }
  }

  if (parsed.type === "response_item" && parsed.payload?.type === "function_call_output" && parsed.payload.call_id) {
    state.pendingApprovalCalls.delete(parsed.payload.call_id);
  }

  if (parsed.type === "event_msg" && parsed.payload?.type === "token_count") {
    const usage = parseUsage(parsed.timestamp, parsed.payload);
    if (usage) {
      usage.lastUserTurnTokenUsage =
        diffTokenUsage(usage.totalTokenUsage, state.userTurnBaselineUsage?.totalTokenUsage) ?? usage.lastTokenUsage;
      usage.lastPrimaryDeltaPercent = usageDelta(usage.primary?.usedPercent, state.userTurnBaselineUsage?.primary?.usedPercent);
      usage.lastSecondaryDeltaPercent = usageDelta(usage.secondary?.usedPercent, state.userTurnBaselineUsage?.secondary?.usedPercent);
      state.previousUsage = usage;
      state.usage = usage;
    }
  }
}

async function processNewCompleteLines(
  filePath: string,
  startOffset: number,
  fileSize: number,
  onLine: (line: string) => void
): Promise<number> {
  if (startOffset >= fileSize) {
    return startOffset;
  }

  let processedBytes = startOffset;
  const stream = createReadStream(filePath, { encoding: "utf8", start: startOffset, end: fileSize - 1 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    onLine(line);
    processedBytes += Buffer.byteLength(line) + 1;
  }

  return Math.min(processedBytes, fileSize);
}

function usageDelta(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined) {
    return undefined;
  }

  return Math.max(0, current - previous);
}

function diffTokenUsage(current: AgentTokenUsage | undefined, previous: AgentTokenUsage | undefined): AgentTokenUsage | undefined {
  if (!current || !previous) {
    return undefined;
  }

  const diff = {
    inputTokens: tokenDelta(current.inputTokens, previous.inputTokens),
    cachedInputTokens: tokenDelta(current.cachedInputTokens, previous.cachedInputTokens),
    outputTokens: tokenDelta(current.outputTokens, previous.outputTokens),
    reasoningOutputTokens: tokenDelta(current.reasoningOutputTokens, previous.reasoningOutputTokens),
    totalTokens: tokenDelta(current.totalTokens, previous.totalTokens)
  };

  return Object.values(diff).some((item) => item !== undefined) ? diff : undefined;
}

function tokenDelta(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined) {
    return undefined;
  }

  return Math.max(0, current - previous);
}

function parseUsage(timestamp: string | undefined, payload: { rate_limits?: unknown; info?: unknown }): AgentUsage | undefined {
  if (!timestamp) {
    return undefined;
  }

  const rateLimits =
    typeof payload.rate_limits === "object" && payload.rate_limits !== null
      ? (payload.rate_limits as {
    primary?: unknown;
    secondary?: unknown;
    plan_type?: unknown;
        })
      : {};
  const info =
    typeof payload.info === "object" && payload.info !== null
      ? (payload.info as {
          total_token_usage?: unknown;
          last_token_usage?: unknown;
          model_context_window?: unknown;
        })
      : {};

  const primary = parseUsageWindow(rateLimits.primary);
  const secondary = parseUsageWindow(rateLimits.secondary);
  const totalTokenUsage = parseTokenUsage(info.total_token_usage);
  const lastTokenUsage = parseTokenUsage(info.last_token_usage);
  const modelContextWindow = typeof info.model_context_window === "number" ? info.model_context_window : undefined;
  if (!primary && !secondary && !totalTokenUsage && !lastTokenUsage && modelContextWindow === undefined) {
    return undefined;
  }

  return {
    capturedAt: timestamp,
    primary,
    secondary,
    planType: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : undefined,
    totalTokenUsage,
    lastTokenUsage,
    modelContextWindow
  };
}

function parseUsageWindow(value: unknown): AgentUsage["primary"] {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const window = value as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
  if (typeof window.used_percent !== "number" || typeof window.window_minutes !== "number") {
    return undefined;
  }

  return {
    usedPercent: Math.max(0, Math.min(100, window.used_percent)),
    windowMinutes: window.window_minutes,
    resetsAt: typeof window.resets_at === "number" ? window.resets_at : undefined
  };
}

function parseTokenUsage(value: unknown): AgentTokenUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const usage = value as {
    input_tokens?: unknown;
    cached_input_tokens?: unknown;
    output_tokens?: unknown;
    reasoning_output_tokens?: unknown;
    total_tokens?: unknown;
  };
  const parsed = {
    inputTokens: readNumber(usage.input_tokens),
    cachedInputTokens: readNumber(usage.cached_input_tokens),
    outputTokens: readNumber(usage.output_tokens),
    reasoningOutputTokens: readNumber(usage.reasoning_output_tokens),
    totalTokens: readNumber(usage.total_tokens)
  };

  return Object.values(parsed).some((item) => item !== undefined) ? parsed : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractUserMessage(payload: { message?: string; content?: Array<{ type?: string; text?: string }> } | undefined): string | undefined {
  const message =
    typeof payload?.message === "string"
      ? payload.message
      : payload?.content
          ?.filter((item) => item.type === "input_text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n");
  const trimmed = message?.trim();

  if (!trimmed || isInternalUserMessage(trimmed)) {
    return undefined;
  }

  return trimmed;
}

function isInternalUserMessage(message: string): boolean {
  return /^<(environment_context|skill|turn_aborted|developer|system|summary)\b/i.test(message);
}

type PermissionRequest = {
  command: string;
  reason?: string;
};

function parsePermissionRequest(rawArguments: string | undefined): PermissionRequest | undefined {
  if (!rawArguments) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawArguments) as { sandbox_permissions?: unknown; cmd?: unknown; justification?: unknown };
    if (parsed.sandbox_permissions !== "require_escalated") {
      return undefined;
    }
    return {
      command: typeof parsed.cmd === "string" && parsed.cmd.trim() ? parsed.cmd.trim() : "requires approval",
      reason: typeof parsed.justification === "string" && parsed.justification.trim() ? parsed.justification.trim() : undefined
    };
  } catch {
    return rawArguments.includes("require_escalated") ? { command: "requires approval" } : undefined;
  }
}

function formatPermissionMessage(request: PermissionRequest): string {
  const reason = request.reason ? `Reason: ${request.reason}\n\n` : "";
  return `${reason}$ ${request.command}`;
}

function parseSessionIdFromPath(transcriptPath: string): string {
  const match = path.basename(transcriptPath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1] ?? transcriptPath;
}

async function countActiveCodexProcesses(diagnostics: AgentScanDiagnostic[]): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,comm=,args="], {
      timeout: 2500,
      maxBuffer: 1024 * 512
    });

    return stdout
      .split("\n")
      .filter((line) => /\bcodex\b/i.test(line))
      .filter((line) => !/agent-monitor|extensionHost/i.test(line)).length;
  } catch (error) {
    diagnostics.push(diagnostic("warning", "process check", `Could not count Codex processes: ${errorMessage(error)}`));
    return 0;
  }
}

export async function archiveTranscript(codexHome: string, transcriptPath: string): Promise<string> {
  const archivedDir = path.join(codexHome, "archived_sessions");
  await fs.mkdir(archivedDir, { recursive: true });
  const dest = path.join(archivedDir, path.basename(transcriptPath));
  await fs.rename(transcriptPath, dest);
  return dest;
}

export async function unarchiveTranscript(codexHome: string, transcriptPath: string): Promise<string> {
  const basename = path.basename(transcriptPath);
  const match = basename.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) {
    throw new Error(`Could not determine original date for ${basename}`);
  }

  const [, year, month, day] = match;
  const destDir = path.join(codexHome, "sessions", year, month, day);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, basename);
  await fs.rename(transcriptPath, dest);
  return dest;
}

export async function deleteArchivedTranscript(codexHome: string, sessionId: string, transcriptPath: string): Promise<void> {
  await fs.unlink(transcriptPath);
  await removeFromSessionIndex(codexHome, sessionId);
}

async function removeFromSessionIndex(codexHome: string, sessionId: string): Promise<void> {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  let content: string;
  try {
    content = await fs.readFile(indexPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }

  const remainingLines = content.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }
    try {
      const parsed = JSON.parse(trimmed) as { id?: string };
      return parsed.id !== sessionId;
    } catch {
      return true;
    }
  });

  await fs.writeFile(indexPath, remainingLines.length > 0 ? `${remainingLines.join("\n")}\n` : "");
}

function diagnostic(level: AgentScanDiagnostic["level"], source: string, message: string): AgentScanDiagnostic {
  return { level, source, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function summarize(sessions: AgentSession[]): AgentSummary {
  return {
    total: sessions.length,
    running: sessions.filter((session) => session.status === "running").length,
    needsApproval: sessions.filter((session) => session.status === "needs-approval").length,
    doneReview: sessions.filter((session) => session.status === "done-review").length,
    reviewed: sessions.filter((session) => session.status === "reviewed").length,
    archived: sessions.filter((session) => session.status === "archived").length,
    unknown: sessions.filter((session) => session.status === "unknown").length
  };
}

function latestUsage(transcripts: Map<string, TranscriptInfo>): AgentUsage | undefined {
  const usages = [...transcripts.values()]
    .map((transcript) => transcript.usage)
    .filter((usage): usage is AgentUsage => usage !== undefined)
    .sort((a, b) => (parseTime(b.capturedAt) ?? 0) - (parseTime(a.capturedAt) ?? 0));

  const latest = usages[0];
  if (!latest) {
    return undefined;
  }

  return {
    ...latest,
    primary: latest.primary ?? usages.find((usage) => usage.primary)?.primary,
    secondary: latest.secondary ?? usages.find((usage) => usage.secondary)?.secondary
  };
}

function isRecent(timeMs: number, seconds: number): boolean {
  return Date.now() - timeMs <= seconds * 1000;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
