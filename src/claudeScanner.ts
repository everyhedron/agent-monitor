import * as fs from "fs/promises";
import * as path from "path";
import type { ReviewMap } from "./reviewState";

export type ClaudeSessionStatus = "running" | "needs-input" | "idle" | "reviewed" | "archived";

export type ClaudeUsage = {
  totalTokens: number;
  lastRunTokens: number;
  contextTokens: number;
};

export type ClaudeSession = {
  id: string;
  name: string;
  nameIsAiGenerated: boolean;
  status: ClaudeSessionStatus;
  updatedAtMs: number;
  transcriptPath: string;
  lastUserMessage?: string;
  lastMessage?: string;
  usage?: ClaudeUsage;
  reviewedAt?: string;
};

export async function scanClaudeSessions(claudeHome: string, reviewed: ReviewMap): Promise<ClaudeSession[]> {
  const liveStatus = await readLiveStatuses(claudeHome);
  const activeFiles = (await walkJsonl(path.join(claudeHome, "projects"))).filter((file) => !isSubagentTranscript(file));
  const archivedFiles = (await walkJsonl(path.join(claudeHome, "archived_sessions"))).filter(
    (file) => !isSubagentTranscript(file)
  );
  const activeSessions = await Promise.all(activeFiles.map((file) => readClaudeSession(file, liveStatus, false, reviewed)));
  const archivedSessions = await Promise.all(archivedFiles.map((file) => readClaudeSession(file, liveStatus, true, reviewed)));

  return [...activeSessions, ...archivedSessions]
    .filter((session): session is ClaudeSession => session !== undefined)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function isSubagentTranscript(filePath: string): boolean {
  return filePath.split(path.sep).includes("subagents");
}

export async function findClaudeUsageProbeSessionId(claudeHome: string): Promise<string | undefined> {
  const files = (await walkJsonl(path.join(claudeHome, "projects"))).filter((file) => !isSubagentTranscript(file));
  for (const file of files) {
    const sessionId = await readUsageProbeSessionId(file);
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

// A "/usage" probe session never invokes the model - the local command's output shows up as a
// standalone `system`/`local_command` line, not an assistant turn. So "probe-only" means "has a
// /usage local-command result, and has never produced a real assistant message".
async function readUsageProbeSessionId(transcriptPath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return undefined;
  }

  let sessionId = path.basename(transcriptPath, ".jsonl");
  let hasAssistantMessage = false;
  let hasUsageLocalCommand = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: ClaudeTranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as ClaudeTranscriptLine;
    } catch {
      continue;
    }

    if (parsed.sessionId) {
      sessionId = parsed.sessionId;
    }

    if (parsed.type === "assistant" && parsed.message?.model !== "<synthetic>") {
      hasAssistantMessage = true;
    }

    if (parsed.type === "system" && parsed.subtype === "local_command" && parsed.content && parseClaudeUsageText(parsed.content)) {
      hasUsageLocalCommand = true;
    }
  }

  return hasUsageLocalCommand && !hasAssistantMessage ? sessionId : undefined;
}

export type ClaudeUsageSnapshot = {
  sessionPercent?: number;
  sessionResets?: string;
  weekPercent?: number;
  weekResets?: string;
  checkedAtMs: number;
};

export function parseClaudeUsageText(output: string): Omit<ClaudeUsageSnapshot, "checkedAtMs"> | undefined {
  const sessionMatch = output.match(/Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n]+))?/i);
  const weekMatch = output.match(/Current week \(all models\):\s*(\d+)%\s*used(?:\s*·\s*resets\s*([^\n]+))?/i);
  if (!sessionMatch && !weekMatch) {
    return undefined;
  }

  return {
    sessionPercent: sessionMatch ? Number(sessionMatch[1]) : undefined,
    sessionResets: sessionMatch?.[2]?.trim(),
    weekPercent: weekMatch ? Number(weekMatch[1]) : undefined,
    weekResets: weekMatch?.[2]?.trim()
  };
}

// Scans every transcript (active + archived) for the freshest "/usage" local-command result,
// whether it came from our own probe session or from the user manually running /usage in a real
// chat. This is pure local file reading - no CLI spawn - so it's cheap enough to run on every
// periodic refresh instead of only on the manual "Check Claude usage" button.
export async function findLatestClaudeUsageSnapshot(claudeHome: string): Promise<ClaudeUsageSnapshot | undefined> {
  const files = [
    ...(await walkJsonl(path.join(claudeHome, "projects"))),
    ...(await walkJsonl(path.join(claudeHome, "archived_sessions")))
  ].filter((file) => !isSubagentTranscript(file));

  let latest: ClaudeUsageSnapshot | undefined;

  await Promise.all(
    files.map(async (file) => {
      let content: string;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        return;
      }

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes("local_command")) {
          continue;
        }

        let parsed: ClaudeTranscriptLine & { timestamp?: string };
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (parsed.type !== "system" || parsed.subtype !== "local_command" || !parsed.content) {
          continue;
        }

        const usage = parseClaudeUsageText(parsed.content);
        const checkedAtMs = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
        if (!usage || !Number.isFinite(checkedAtMs)) {
          continue;
        }

        if (!latest || checkedAtMs > latest.checkedAtMs) {
          latest = { ...usage, checkedAtMs };
        }
      }
    })
  );

  return latest;
}

export async function archiveClaudeTranscript(claudeHome: string, transcriptPath: string): Promise<string> {
  const projectDir = path.basename(path.dirname(transcriptPath));
  const archivedDir = path.join(claudeHome, "archived_sessions", projectDir);
  await fs.mkdir(archivedDir, { recursive: true });
  const dest = path.join(archivedDir, path.basename(transcriptPath));
  await fs.rename(transcriptPath, dest);
  return dest;
}

export async function unarchiveClaudeTranscript(claudeHome: string, transcriptPath: string): Promise<string> {
  const projectDir = path.basename(path.dirname(transcriptPath));
  const destDir = path.join(claudeHome, "projects", projectDir);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(transcriptPath));
  await fs.rename(transcriptPath, dest);
  return dest;
}

export async function deleteClaudeTranscript(transcriptPath: string): Promise<void> {
  await fs.unlink(transcriptPath);
}

async function readLiveStatuses(claudeHome: string): Promise<Map<string, ClaudeSessionStatus>> {
  const statuses = new Map<string, ClaudeSessionStatus>();
  const dir = path.join(claudeHome, "sessions");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return statuses;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        try {
          const content = await fs.readFile(path.join(dir, entry), "utf8");
          const parsed = JSON.parse(content) as { pid?: number; sessionId?: string; status?: string };
          if (parsed.sessionId && parsed.status && isPidAlive(parsed.pid)) {
            statuses.set(parsed.sessionId, normalizeStatus(parsed.status));
          }
        } catch {
          // status file may be mid-write; skip it for this scan
        }
      })
  );

  return statuses;
}

function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeStatus(status: string): ClaudeSessionStatus {
  if (status === "busy") {
    return "running";
  }
  if (status === "needs_input" || status === "waiting") {
    return "needs-input";
  }
  return "idle";
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

type ClaudeUsageRaw = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

type ClaudeTranscriptLine = {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  slug?: string;
  sessionId?: string;
  content?: string;
  message?: { role?: string; content?: unknown; usage?: ClaudeUsageRaw; model?: string };
  compactMetadata?: { postTokens?: number };
};

async function readClaudeSession(
  transcriptPath: string,
  liveStatus: Map<string, ClaudeSessionStatus>,
  archived: boolean,
  reviewed: ReviewMap
): Promise<ClaudeSession | undefined> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  let content: string;
  try {
    [stat, content] = await Promise.all([fs.stat(transcriptPath), fs.readFile(transcriptPath, "utf8")]);
  } catch {
    return undefined;
  }

  let sessionId = path.basename(transcriptPath, ".jsonl");
  let customTitle: string | undefined;
  let agentName: string | undefined;
  let aiTitle: string | undefined;
  let slug: string | undefined;
  let lastUserMessage: string | undefined;
  let lastMessage: string | undefined;
  let totalTokens = 0;
  let lastRunTokens = 0;
  let contextTokens = 0;
  let hasUsage = false;
  let hasAssistantMessage = false;
  let hasUsageLocalCommand = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: ClaudeTranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as ClaudeTranscriptLine;
    } catch {
      continue;
    }

    if (parsed.sessionId) {
      sessionId = parsed.sessionId;
    }

    if (parsed.type === "custom-title" && parsed.customTitle) {
      customTitle = parsed.customTitle;
    }

    if (parsed.type === "agent-name" && parsed.agentName) {
      agentName = parsed.agentName;
    }

    if (parsed.type === "ai-title" && parsed.aiTitle) {
      aiTitle = parsed.aiTitle;
    }

    if (parsed.type === "system" && parsed.slug) {
      slug = parsed.slug;
    }

    if (parsed.type === "system" && parsed.subtype === "compact_boundary" && parsed.compactMetadata?.postTokens !== undefined) {
      // Compaction isn't a new user turn, so it shouldn't reset lastRunTokens - only contextTokens
      // actually changes here.
      contextTokens = parsed.compactMetadata.postTokens;
      hasUsage = true;
    }

    if (parsed.type === "system" && parsed.subtype === "local_command" && parsed.content && parseClaudeUsageText(parsed.content)) {
      hasUsageLocalCommand = true;
    }

    if (parsed.type === "user" && parsed.message?.role === "user" && !parsed.isMeta) {
      const text = extractText(parsed.message.content);
      if (text && !isInjectedArtifact(text)) {
        // A bare slash command like "/compact" is still worth showing as the last user message
        // (it tells you a compaction just happened), but it isn't a new unit of work, so it
        // shouldn't reset the last-run token count.
        lastUserMessage = text;
        if (!isSlashCommand(text)) {
          lastRunTokens = 0;
        }
      }
    }

    if (parsed.type === "assistant" && parsed.message?.role === "assistant" && parsed.message.model !== "<synthetic>") {
      // The CLI emits a synthetic "No response requested." assistant turn for queued local
      // commands (e.g. a queued "/usage" or "/config") that don't actually invoke the model -
      // marked by `message.model === "<synthetic>"`. Treating that as a real assistant turn would
      // both defeat the usage-probe-hiding check below and clobber lastMessage with meaningless
      // filler text.
      hasAssistantMessage = true;
      const text = extractText(parsed.message.content);
      if (text) {
        lastMessage = text;
      }

      const usage = parsed.message.usage;
      if (usage) {
        hasUsage = true;
        const turnTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
        totalTokens += turnTokens;
        lastRunTokens += turnTokens;
        contextTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      }
    }
  }

  if (hasUsageLocalCommand && !hasAssistantMessage) {
    // A "/usage" probe session (run interactively, or via "claude -p /usage") - hidden from the
    // dashboard, but left on disk so a later usage check can resume it instead of spawning a
    // fresh session every time.
    return undefined;
  }

  const nameIsAiGenerated = !customTitle && !agentName && !!aiTitle;
  const reviewedAt = reviewed[sessionId];
  const liveOrIdleStatus = liveStatus.get(sessionId) ?? "idle";
  const status: ClaudeSessionStatus = archived
    ? "archived"
    : liveOrIdleStatus === "idle" && reviewedAt
    ? "reviewed"
    : liveOrIdleStatus;

  return {
    id: sessionId,
    name: customTitle || agentName || aiTitle || slug || sessionId,
    nameIsAiGenerated,
    status,
    updatedAtMs: stat.mtimeMs,
    transcriptPath,
    lastUserMessage,
    lastMessage,
    usage: hasUsage ? { totalTokens, lastRunTokens, contextTokens } : undefined,
    reviewedAt
  };
}

const COMPACT_CONTINUATION_PREFIX = "This session is being continued from a previous conversation";

// Content injected by the CLI itself rather than typed by the user: command-wrapper tags, and the
// auto-generated continuation summary that follows a compaction. Never worth showing as "the last
// user message" and never a real new unit of work.
function isInjectedArtifact(message: string): boolean {
  const trimmed = message.trim();
  return (
    /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder)\b/i.test(trimmed) ||
    trimmed.startsWith(COMPACT_CONTINUATION_PREFIX)
  );
}

// A bare slash-command invocation, e.g. "/compact" or "/usage" typed directly.
function isSlashCommand(message: string): boolean {
  return /^\/[a-z][a-z0-9_-]*$/i.test(message.trim());
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() || undefined;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((block): block is { type?: string; text?: string } => typeof block === "object" && block !== null)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
    return text || undefined;
  }

  return undefined;
}
