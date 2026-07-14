import * as fs from "fs/promises";
import * as path from "path";

export type CodexManualUsage = {
  planType?: string;
  primaryPercent?: number;
  primaryResetsAt?: number;
  secondaryPercent?: number;
  secondaryResetsAt?: number;
};

type CodexAuthFile = {
  OPENAI_API_KEY?: string;
  access_token?: string;
  tokens?: { access_token?: string };
};

type CodexUsageResponse = {
  plan_type?: string;
  rate_limit?: {
    primary_window?: CodexUsageWindowResponse | null;
    secondary_window?: CodexUsageWindowResponse | null;
  };
};

type CodexUsageWindowResponse = {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
};

type ParsedCodexUsageWindow = {
  percent?: number;
  resetsAt?: number;
  windowSeconds?: number;
};

// Codex has no locally-cached "current" usage snapshot the way transcripts give us historical
// rate-limit readings - this hits the same endpoint the Codex CLI itself uses to check usage on
// demand, authenticating with the same bearer token the CLI already stores after login.
export async function fetchCodexUsage(codexHome: string): Promise<CodexManualUsage> {
  const authPath = path.join(codexHome, "auth.json");
  let authContent: string;
  try {
    authContent = await fs.readFile(authPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${authPath}: ${errorMessage(error)}. Log in with the Codex CLI first.`);
  }

  let auth: CodexAuthFile;
  try {
    auth = JSON.parse(authContent) as CodexAuthFile;
  } catch (error) {
    throw new Error(`Could not parse ${authPath}: ${errorMessage(error)}`);
  }

  const token = auth.tokens?.access_token || auth.access_token || auth.OPENAI_API_KEY;
  if (!token) {
    throw new Error(`No access token found in ${authPath}. Log in with the Codex CLI first.`);
  }

  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Codex usage request failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as CodexUsageResponse;
  const primaryWindow = parseWindow(body.rate_limit?.primary_window);
  const secondaryWindow = parseWindow(body.rate_limit?.secondary_window);
  const windows = [primaryWindow, secondaryWindow].filter((window): window is ParsedCodexUsageWindow => window !== undefined);
  const fiveHourWindow = findWindowByDuration(windows, 5 * 60 * 60) ?? (primaryWindow?.windowSeconds === undefined ? primaryWindow : undefined);
  const sevenDayWindow = findWindowByDuration(windows, 7 * 24 * 60 * 60) ?? (secondaryWindow?.windowSeconds === undefined ? secondaryWindow : undefined);

  return {
    planType: body.plan_type,
    primaryPercent: fiveHourWindow?.percent,
    primaryResetsAt: fiveHourWindow?.resetsAt,
    secondaryPercent: sevenDayWindow?.percent,
    secondaryResetsAt: sevenDayWindow?.resetsAt
  };
}

function parseWindow(window: CodexUsageWindowResponse | null | undefined): ParsedCodexUsageWindow | undefined {
  if (!window) {
    return undefined;
  }

  return {
    percent: typeof window.used_percent === "number" ? window.used_percent : undefined,
    resetsAt: typeof window.reset_at === "number" ? window.reset_at : undefined,
    windowSeconds: typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : undefined
  };
}

function findWindowByDuration(
  windows: ParsedCodexUsageWindow[],
  targetSeconds: number
): ParsedCodexUsageWindow | undefined {
  return windows.find((window) => window.windowSeconds !== undefined && Math.abs(window.windowSeconds - targetSeconds) <= 60);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
