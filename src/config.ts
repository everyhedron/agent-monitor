import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type AgentMonitorConfig = {
  codexHome: string;
  refreshIntervalMs: number;
  runningActivitySeconds: number;
  notifyOnDone: boolean;
  openOnStartup: boolean;
  pinOnStartup: boolean;
};

export function readConfig(): AgentMonitorConfig {
  const config = vscode.workspace.getConfiguration("agentMonitor");
  const configuredHome = config.get<string>("codexHome", "").trim();

  return {
    codexHome: configuredHome ? expandHome(configuredHome) : path.join(os.homedir(), ".codex"),
    refreshIntervalMs: Math.max(1000, config.get<number>("refreshIntervalMs", 5000)),
    runningActivitySeconds: Math.max(10, config.get<number>("runningActivitySeconds", 90)),
    notifyOnDone: config.get<boolean>("notifyOnDone", true),
    openOnStartup: config.get<boolean>("openOnStartup", false),
    pinOnStartup: config.get<boolean>("pinOnStartup", false)
  };
}

export async function updateStartupOptions(options: Partial<Pick<AgentMonitorConfig, "openOnStartup" | "pinOnStartup">>): Promise<void> {
  const config = vscode.workspace.getConfiguration("agentMonitor");
  if (options.openOnStartup !== undefined) {
    await config.update("openOnStartup", options.openOnStartup, vscode.ConfigurationTarget.Global);
  }
  if (options.pinOnStartup !== undefined) {
    await config.update("pinOnStartup", options.pinOnStartup, vscode.ConfigurationTarget.Global);
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
