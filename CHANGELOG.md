# Changelog

All notable changes to the Hedron Agent Monitor extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.0.2] - 2026-07-13

### Fixed
- Auto-compact on review now only sends `/compact` when the matching agent terminal is already open.
- Codex Check usage now remains visible without transcript usage and shows the latest manual checked timestamp.
- Codex Check usage now updates its checking/result display without waiting for a full dashboard refresh.
- Codex usage cards now prefer the freshest source, so newer transcript usage can replace an older manual check.
- Notification Open Monitor actions now explicitly focus the existing dashboard panel.
- Confirmed archived Codex deletion removes the deleted session from `session_index.jsonl`.

### Added
- Dashboard webview listing Codex and Claude Code sessions, with derived status (`running`, `needs approval`, `done`, `reviewed`, `archived`).
- Togglable status-card filters for session status.
- Inline session actions: open terminal, approve pending tool calls, mark reviewed, send `/compact`, archive/unarchive, delete archived sessions.
- Review-state tracking, automatically cleared when new activity is detected on a session.
- Optional compact-on-review (`agentMonitor.autoCompactOnReview`).
- Status bar item summarizing sessions requiring attention, with notifications on state transitions.
- Codex and Claude usage tracking, including last-run token counts and last-run duration per session.
- "Check usage" button for both tools: Codex queries the live `chatgpt.com` usage endpoint using the CLI's stored login; Claude usage refreshes from the CLI's own `/usage` output.
- Archive lifecycle moving transcripts into each tool's `archived_sessions` location, with restore/permanent-delete support.

### Fixed
- Year-rollover bug in Claude usage reset-date labels near the end of December.
- Various races around compact-vs-reviewed state, terminal lookup order, and orphaned Codex sessions.

[Unreleased]: https://github.com/everyhedron/agent-monitor/compare/v0.0.2...main
[0.0.2]: https://github.com/everyhedron/agent-monitor/releases/tag/v0.0.2
