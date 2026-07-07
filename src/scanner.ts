import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import type { AgentMonitorConfig } from "./config";
import type { ReviewMap } from "./reviewState";
import type { AgentScan, AgentSession, AgentStatus, AgentSummary, AgentUsage } from "./types";

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
  lastUserMessage?: string;
  lastMessage?: string;
  lastCompletionAt?: string;
  pendingApprovalAt?: string;
  hasCompletion: boolean;
  hasPendingApproval: boolean;
  usage?: AgentUsage;
  latestUserAt?: string;
  latestAbortAt?: string;
};

export async function scanAgents(config: AgentMonitorConfig, reviewed: ReviewMap): Promise<AgentScan> {
  const index = await readSessionIndex(config.codexHome);
  const transcripts = await readAllTranscripts(config.codexHome);
  const activeProcessCount = await countActiveCodexProcesses();
  const sessions = index.map((session) => buildAgentSession(session, config, reviewed, activeProcessCount, transcripts));
  const sortedSessions = sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    codexHome: config.codexHome,
    scannedAt: new Date().toISOString(),
    sessions: sortedSessions,
    summary: summarize(sortedSessions),
    usage: latestUsage(transcripts)
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

  return {
    id: session.id,
    name: session.thread_name?.trim() || transcript?.title || session.id,
    status,
    updatedAt: session.updated_at,
    updatedAtMs,
    transcriptPath: transcript?.path,
    transcriptMtimeMs: transcript?.mtimeMs,
    lastUserMessage: transcript?.lastUserMessage,
    lastMessage: transcript?.lastMessage,
    lastCompletionAt: transcript?.lastCompletionAt,
    reviewedAt
  };
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

async function readSessionIndex(codexHome: string): Promise<IndexedSession[]> {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  let content = "";
  try {
    content = await fs.readFile(indexPath, "utf8");
  } catch {
    return [];
  }

  const sessions = new Map<string, IndexedSession>();
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
      continue;
    }
  }

  return [...sessions.values()];
}

async function readAllTranscripts(codexHome: string): Promise<Map<string, TranscriptInfo>> {
  const activeFiles = await walkJsonl(path.join(codexHome, "sessions"));
  const archivedFiles = await walkJsonl(path.join(codexHome, "archived_sessions"));
  const activeInfos = await Promise.all(activeFiles.map((file) => readTranscriptInfo(file, false)));
  const archivedInfos = await Promise.all(archivedFiles.map((file) => readTranscriptInfo(file, true)));
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

async function walkJsonl(root: string): Promise<string[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return walkJsonl(fullPath);
      }
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
    })
  );

  return nested.flat();
}

async function readTranscriptInfo(transcriptPath: string, archived: boolean): Promise<TranscriptInfo> {
  const [stat, content] = await Promise.all([fs.stat(transcriptPath), fs.readFile(transcriptPath, "utf8")]);
  let sessionId = parseSessionIdFromPath(transcriptPath);
  let title: string | undefined;
  let lastUserMessage: string | undefined;
  let lastMessage: string | undefined;
  let lastCompletionAt: string | undefined;
  let pendingApprovalAt: string | undefined;
  let latestUserAt: string | undefined;
  let latestAbortAt: string | undefined;
  let lastCompletionMs = 0;
  let latestUserMs = 0;
  let latestAbortMs = 0;
  let transcriptUsage: AgentUsage | undefined;
  const pendingApprovalCalls = new Map<string, number>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as {
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
        };
      };
      const timestampMs = parseTime(parsed.timestamp) ?? 0;

      if (parsed.type === "session_meta") {
        sessionId = parsed.payload?.id || parsed.payload?.session_id || sessionId;
        title = parsed.payload?.thread_name || title;
      }

      if (
        (parsed.type === "event_msg" && parsed.payload?.type === "user_message") ||
        (parsed.type === "response_item" && parsed.payload?.type === "message" && parsed.payload.role === "user")
      ) {
        latestUserAt = parsed.timestamp;
        latestUserMs = timestampMs;
        const userMessage = extractUserMessage(parsed.payload);
        if (userMessage) {
          lastUserMessage = userMessage;
        }
      }

      if (parsed.type === "event_msg" && parsed.payload?.type === "agent_message" && parsed.payload.message) {
        lastMessage = parsed.payload.message;
      }

      if (parsed.type === "event_msg" && parsed.payload?.type === "task_complete") {
        lastCompletionAt = parsed.timestamp;
        lastCompletionMs = timestampMs;
        if (parsed.payload.last_agent_message) {
          lastMessage = parsed.payload.last_agent_message;
        }
      }

      if (parsed.type === "event_msg" && parsed.payload?.type === "turn_aborted") {
        latestAbortAt = parsed.timestamp;
        latestAbortMs = timestampMs;
      }

      if (parsed.type === "response_item" && parsed.payload?.type === "function_call" && parsed.payload.name === "exec_command") {
        const permissionRequest = parsePermissionRequest(parsed.payload.arguments);
        if (permissionRequest && parsed.payload.call_id) {
          pendingApprovalCalls.set(parsed.payload.call_id, timestampMs);
          pendingApprovalAt = parsed.timestamp;
          lastMessage = `Permission requested: ${permissionRequest}`;
        }
      }

      if (parsed.type === "response_item" && parsed.payload?.type === "function_call_output" && parsed.payload.call_id) {
        pendingApprovalCalls.delete(parsed.payload.call_id);
      }

      if (parsed.type === "event_msg" && parsed.payload?.type === "token_count") {
        const usage = parseUsage(parsed.timestamp, parsed.payload);
        if (usage) {
          transcriptUsage = usage;
        }
      }
    } catch {
      continue;
    }
  }

  const hasCompletion = lastCompletionMs > 0 && lastCompletionMs >= latestUserMs && lastCompletionMs >= latestAbortMs;
  const latestPendingApprovalMs = Math.max(0, ...pendingApprovalCalls.values());
  const hasPendingApproval = latestPendingApprovalMs > 0 && latestPendingApprovalMs >= lastCompletionMs && latestPendingApprovalMs >= latestAbortMs;

  return {
    sessionId,
    path: transcriptPath,
    mtimeMs: stat.mtimeMs,
    archived,
    title,
    lastUserMessage,
    lastMessage,
    lastCompletionAt: hasCompletion ? lastCompletionAt : undefined,
    pendingApprovalAt: hasPendingApproval ? pendingApprovalAt : undefined,
    hasCompletion,
    hasPendingApproval,
    usage: transcriptUsage,
    latestUserAt,
    latestAbortAt
  };
}

function parseUsage(timestamp: string | undefined, payload: { rate_limits?: unknown }): AgentUsage | undefined {
  if (!timestamp || typeof payload.rate_limits !== "object" || payload.rate_limits === null) {
    return undefined;
  }

  const rateLimits = payload.rate_limits as {
    primary?: unknown;
    secondary?: unknown;
    plan_type?: unknown;
  };

  const primary = parseUsageWindow(rateLimits.primary);
  const secondary = parseUsageWindow(rateLimits.secondary);
  if (!primary && !secondary) {
    return undefined;
  }

  return {
    capturedAt: timestamp,
    primary,
    secondary,
    planType: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : undefined
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
  return /^<(environment_context|turn_aborted|developer|system|summary)\b/i.test(message);
}

function parsePermissionRequest(rawArguments: string | undefined): string | undefined {
  if (!rawArguments) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawArguments) as { sandbox_permissions?: unknown; cmd?: unknown };
    if (parsed.sandbox_permissions !== "require_escalated") {
      return undefined;
    }
    return typeof parsed.cmd === "string" && parsed.cmd.trim() ? parsed.cmd.trim() : "requires approval";
  } catch {
    return rawArguments.includes("require_escalated") ? "requires approval" : undefined;
  }
}

function parseSessionIdFromPath(transcriptPath: string): string {
  const match = path.basename(transcriptPath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1] ?? transcriptPath;
}

async function countActiveCodexProcesses(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,comm=,args="], {
      timeout: 2500,
      maxBuffer: 1024 * 512
    });

    return stdout
      .split("\n")
      .filter((line) => /\bcodex\b/i.test(line))
      .filter((line) => !/agent-monitor|extensionHost/i.test(line)).length;
  } catch {
    return 0;
  }
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
  return [...transcripts.values()]
    .map((transcript) => transcript.usage)
    .filter((usage): usage is AgentUsage => usage !== undefined)
    .sort((a, b) => (parseTime(b.capturedAt) ?? 0) - (parseTime(a.capturedAt) ?? 0))[0];
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
