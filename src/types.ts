export type AgentStatus = "running" | "needs-approval" | "done-review" | "reviewed" | "archived" | "unknown";

export type AgentSession = {
  id: string;
  name: string;
  nameIsFallback: boolean;
  status: AgentStatus;
  updatedAt?: string;
  updatedAtMs: number;
  transcriptPath?: string;
  transcriptMtimeMs?: number;
  lastUserMessage?: string;
  lastMessage?: string;
  approvalReason?: string;
  approvalCommand?: string;
  lastCompletionAt?: string;
  reviewedAt?: string;
  usage?: AgentUsage;
  isOpenInTerminal?: boolean;
};

export type AgentSummary = {
  total: number;
  running: number;
  needsApproval: number;
  doneReview: number;
  reviewed: number;
  archived: number;
  unknown: number;
};

export type AgentUsageWindow = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: number;
};

export type AgentUsage = {
  capturedAt: string;
  primary?: AgentUsageWindow;
  secondary?: AgentUsageWindow;
  planType?: string;
  totalTokenUsage?: AgentTokenUsage;
  lastTokenUsage?: AgentTokenUsage;
  lastUserTurnTokenUsage?: AgentTokenUsage;
  modelContextWindow?: number;
  lastPrimaryDeltaPercent?: number;
  lastSecondaryDeltaPercent?: number;
};

export type AgentTokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

export type AgentScan = {
  codexHome: string;
  scannedAt: string;
  sessions: AgentSession[];
  summary: AgentSummary;
  usage?: AgentUsage;
  timings: AgentScanTimings;
  diagnostics: AgentScanDiagnostic[];
};

export type AgentScanTimings = {
  totalMs: number;
  indexMs: number;
  transcriptsMs: number;
  processMs: number;
};

export type AgentScanDiagnostic = {
  level: "warning" | "error";
  source: string;
  message: string;
};
