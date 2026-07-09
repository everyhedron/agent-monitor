# Changelog

All notable changes to the Hedron Agent Monitor extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/everyhedron/agent-monitor/commits/main
