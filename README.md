# Agent Monitor

Prototype VS Code extension for watching local Codex chats.

Open `Agent Monitor: Open Dashboard` from the Command Palette. The dashboard reads `~/.codex/session_index.jsonl` as the authoritative chat list, finds matching transcript files under `~/.codex/sessions` and `~/.codex/archived_sessions` for status details, and shows each chat as `running`, `done`, `reviewed`, or `archived`.

Reviewed/unreviewed state is stored in VS Code global extension state under the `agentMonitor.reviewedSessions` key. A chat is marked `done` when it is complete or inactive and has not been marked reviewed from the dashboard.

## Notes

- Running detection is heuristic: active Codex processes and recent transcript writes are treated as active work.
- Completion detection prefers Codex transcript `task_complete` events.
- Notifications are sent only when a known running chat transitions to done after the extension has started.
- Archive status is detected from matching files under `~/.codex/archived_sessions`.
