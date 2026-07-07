export type AgentStatus = "running" | "needs-approval" | "done-review" | "reviewed" | "archived" | "unknown";

export type AgentSession = {
  id: string;
  name: string;
  status: AgentStatus;
  updatedAt?: string;
  updatedAtMs: number;
  transcriptPath?: string;
  transcriptMtimeMs?: number;
  lastUserMessage?: string;
  lastMessage?: string;
  lastCompletionAt?: string;
  reviewedAt?: string;
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
};

export type AgentScan = {
  codexHome: string;
  scannedAt: string;
  sessions: AgentSession[];
  summary: AgentSummary;
  usage?: AgentUsage;
};
