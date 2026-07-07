import * as vscode from "vscode";

const reviewedKey = "agentMonitor.reviewedSessions";

export type ReviewMap = Record<string, string>;

export class ReviewState {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getReviewed(): ReviewMap {
    return this.context.globalState.get<ReviewMap>(reviewedKey, {});
  }

  async markReviewed(sessionIds: string[]): Promise<void> {
    const now = new Date().toISOString();
    const reviewed = { ...this.getReviewed() };
    for (const sessionId of sessionIds) {
      reviewed[sessionId] = now;
    }
    await this.context.globalState.update(reviewedKey, reviewed);
  }

  async markUnreviewed(sessionIds: string[]): Promise<void> {
    const reviewed = { ...this.getReviewed() };
    for (const sessionId of sessionIds) {
      delete reviewed[sessionId];
    }
    await this.context.globalState.update(reviewedKey, reviewed);
  }
}
