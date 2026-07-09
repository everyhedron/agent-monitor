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
    primary_window?: { used_percent?: number; reset_at?: number };
    secondary_window?: { used_percent?: number; reset_at?: number };
  };
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

  return {
    planType: body.plan_type,
    primaryPercent: body.rate_limit?.primary_window?.used_percent,
    primaryResetsAt: body.rate_limit?.primary_window?.reset_at,
    secondaryPercent: body.rate_limit?.secondary_window?.used_percent,
    secondaryResetsAt: body.rate_limit?.secondary_window?.reset_at
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
