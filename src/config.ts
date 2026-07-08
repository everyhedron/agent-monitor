import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type AgentMonitorConfig = {
  codexHome: string;
  claudeHome: string;
  refreshIntervalMs: number;
  runningActivitySeconds: number;
  notifyOnDone: boolean;
  autoCompactOnReview: boolean;
};

export function readConfig(): AgentMonitorConfig {
  const config = vscode.workspace.getConfiguration("agentMonitor");
  const configuredHome = config.get<string>("codexHome", "").trim();
  const configuredClaudeHome = config.get<string>("claudeHome", "").trim();

  return {
    codexHome: configuredHome ? expandHome(configuredHome) : path.join(os.homedir(), ".codex"),
    claudeHome: configuredClaudeHome ? expandHome(configuredClaudeHome) : path.join(os.homedir(), ".claude"),
    refreshIntervalMs: Math.max(1000, config.get<number>("refreshIntervalMs", 5000)),
    runningActivitySeconds: Math.max(10, config.get<number>("runningActivitySeconds", 90)),
    notifyOnDone: config.get<boolean>("notifyOnDone", true),
    autoCompactOnReview: config.get<boolean>("autoCompactOnReview", false)
  };
}

export async function updateAgentMonitorOptions(
  options: Partial<Pick<AgentMonitorConfig, "autoCompactOnReview">>
): Promise<void> {
  const config = vscode.workspace.getConfiguration("agentMonitor");
  if (options.autoCompactOnReview !== undefined) {
    await config.update("autoCompactOnReview", options.autoCompactOnReview, vscode.ConfigurationTarget.Global);
  }
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}
