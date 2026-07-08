import * as fs from "fs/promises";
import * as path from "path";

export type ClaudeSessionStatus = "running" | "needs-input" | "idle" | "archived";

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
};

export async function scanClaudeSessions(claudeHome: string): Promise<ClaudeSession[]> {
  const liveStatus = await readLiveStatuses(claudeHome);
  const activeFiles = await walkJsonl(path.join(claudeHome, "projects"));
  const archivedFiles = await walkJsonl(path.join(claudeHome, "archived_sessions"));
  const activeSessions = await Promise.all(activeFiles.map((file) => readClaudeSession(file, liveStatus, false)));
  const archivedSessions = await Promise.all(archivedFiles.map((file) => readClaudeSession(file, liveStatus, true)));

  return [...activeSessions, ...archivedSessions]
    .filter((session): session is ClaudeSession => session !== undefined)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
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
          const parsed = JSON.parse(content) as { sessionId?: string; status?: string };
          if (parsed.sessionId && parsed.status) {
            statuses.set(parsed.sessionId, normalizeStatus(parsed.status));
          }
        } catch {
          // status file may be mid-write; skip it for this scan
        }
      })
  );

  return statuses;
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
  isMeta?: boolean;
  customTitle?: string;
  agentName?: string;
  aiTitle?: string;
  slug?: string;
  sessionId?: string;
  message?: { role?: string; content?: unknown; usage?: ClaudeUsageRaw };
};

async function readClaudeSession(
  transcriptPath: string,
  liveStatus: Map<string, ClaudeSessionStatus>,
  archived: boolean
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

    if (parsed.type === "user" && parsed.message?.role === "user" && !parsed.isMeta) {
      const text = extractText(parsed.message.content);
      if (text && !isInternalUserMessage(text)) {
        lastUserMessage = text;
        lastRunTokens = 0;
      }
    }

    if (parsed.type === "assistant" && parsed.message?.role === "assistant") {
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

  const nameIsAiGenerated = !customTitle && !agentName && !!aiTitle;

  return {
    id: sessionId,
    name: customTitle || agentName || aiTitle || slug || sessionId,
    nameIsAiGenerated,
    status: archived ? "archived" : liveStatus.get(sessionId) ?? "idle",
    updatedAtMs: stat.mtimeMs,
    transcriptPath,
    lastUserMessage,
    lastMessage,
    usage: hasUsage ? { totalTokens, lastRunTokens, contextTokens } : undefined
  };
}

function isInternalUserMessage(message: string): boolean {
  return /^<(command-name|command-message|command-args|local-command-stdout|system-reminder)\b/i.test(message);
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
