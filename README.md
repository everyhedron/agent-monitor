<h1 align="center">Agent Monitor</h1>

<p align="center">
  A VS Code dashboard for keeping tabs on local <strong>Codex</strong> and <strong>Claude Code</strong> chats -
  what's running, what's waiting on you, and what you've already reviewed.
</p>

> **Screenshot placeholder:** full dashboard view with both a Codex and a Claude card visible,
> showing a mix of running / needs-approval / reviewed sessions. Save as
> `media/dashboard-overview.png` and replace this note with a Markdown image tag pointing at it.

## Why

Codex and Claude Code both run as long-lived CLI sessions in terminal tabs. Once you have more than
one or two going, it's easy to lose track of which ones are still working, which ones are stuck
waiting on an approval, and which ones you've already looked at. Agent Monitor reads each tool's
local session data directly off disk, gives every chat a status, and puts them all in one place so
you never have to go hunting through terminal tabs to find out what needs your attention.

It is intentionally read-mostly: the dashboard doesn't wrap or proxy either CLI. It watches their
transcripts and session files, and the only things it writes back are the review/archive bookkeeping
described below plus, optionally, keystrokes into a terminal you already have open (an approval
reply, or `/compact`).

## Features

- **One dashboard, both tools.** Codex and Claude Code sessions are scanned separately and shown as
  color-coded cards side by side, so you can tell at a glance which tool a chat belongs to.
- **Status at a glance.** Every chat is bucketed into `running`, `needs approval`, `done - review`,
  `reviewed`, or `archived`, derived from each tool's own transcript/process state (see
  [How status is determined](#how-status-is-determined) below) - no manual tagging required.
- **Act without leaving the dashboard.** Jump straight to a chat's terminal, approve or
  always-approve a pending tool call, send `/compact`, or mark a chat reviewed, all from inline
  buttons on its card.
- **Review tracking that resets itself.** Marking a chat "reviewed" clears automatically the moment
  it produces new activity, so the badge always reflects whether you've seen the *latest* state, not
  just some past state.
- **Optional auto-compact on review.** Turn on `agentMonitor.autoCompactOnReview` to have marking a
  chat reviewed automatically send `/compact` to it, keeping long-running terminals lighter without
  extra clicks.
- **Usage tracking.** Claude Code's session/week usage percentages and reset times are parsed
  straight out of local `/usage` transcript data and shown on its card, with a manual "Check usage"
  refresh button. A matching (currently disabled) button is reserved on the Codex card for when the
  same check is wired up there.
- **Status bar summary + notifications.** A `$(hubot)` status bar item shows how many chats need
  attention at a glance, and VS Code notifications fire when a chat needs approval or finishes
  running - each with quick actions to open, approve, or dismiss.
- **Archive lifecycle.** Archiving a chat moves its transcript into that tool's own
  `archived_sessions` folder (the same mechanism the CLI itself uses), so archived state is real,
  not just hidden in the UI. Archived chats can be unarchived or permanently deleted.

## Screenshots

> **Screenshot placeholder:** a Codex card and a Claude card, cropped tightly, side by side so the
> two styles are easy to compare. Save as `media/cards-comparison.png`.

> **Screenshot placeholder:** the usage section on a Claude card with real session/week percentages
> and reset times visible. Save as `media/usage-section.png`.

> **Screenshot placeholder:** a VS Code notification toast for a chat that needs approval, with its
> action buttons visible. Save as `media/approval-notification.png`.

Once the images exist, swap each placeholder above for a Markdown image tag: caption in square
brackets, then the `media/<filename>.png` path in parentheses.

## Installation

This extension isn't published to the Marketplace yet. Install it from a packaged `.vsix`:

```sh
npm install
npm run package               # produces agent-monitor-<version>.vsix
code --install-extension agent-monitor-<version>.vsix
```

Then reload VS Code and run **Agent Monitor: Open Dashboard** from the Command Palette.

## Configuration

All settings live under the `agentMonitor.*` prefix in your VS Code settings:

| Setting | Default | Description |
| --- | --- | --- |
| `agentMonitor.codexHome` | `""` (uses `~/.codex`) | Path to the Codex home folder. |
| `agentMonitor.claudeHome` | `""` (uses `~/.claude`) | Path to the Claude Code home folder. |
| `agentMonitor.refreshIntervalMs` | `5000` | How often the dashboard and background notifier re-scan, in milliseconds. |
| `agentMonitor.runningActivitySeconds` | `90` | A chat without an explicit completion marker is treated as still running if its transcript changed within this many seconds. |
| `agentMonitor.notifyOnDone` | `true` | Show a VS Code notification when a running chat becomes done or needs approval. |
| `agentMonitor.autoCompactOnReview` | `false` | Send `/compact` to a chat's terminal automatically when it's marked reviewed. |

## Commands

| Command | Description |
| --- | --- |
| `Agent Monitor: Open Dashboard` | Opens the dashboard webview panel. |
| `Agent Monitor: Refresh` | Forces an immediate re-scan of both tools. |

Everything else (open, approve, always-approve, compact, mark reviewed, archive, unarchive, delete)
is available as an inline button directly on each chat's card.

## How status is determined

Agent Monitor never asks either CLI for its state - it infers it from the same files the CLI itself
maintains:

- **Codex** - transcripts under `~/.codex/sessions` (plus the `session_index.jsonl` list) are
  checked for `task_complete` events, pending approval requests, and recent write activity; matching
  OS processes are used as a secondary signal that a chat is still active.
- **Claude Code** - transcripts under `~/.claude/projects` (and `archived_sessions`) are read for the
  same kind of signals: pending tool-approval turns, a recent assistant turn, or the CLI's own
  `local_command` results for things like `/usage`. Synthetic assistant turns the CLI emits for
  queued slash commands (marked internally with `model: "<synthetic>"`) are ignored so a chat that
  only ever ran something like `/usage` doesn't show up as a real chat.

`reviewed` and `archived` are the two states Agent Monitor itself is responsible for: `reviewed` is
stored in VS Code's global extension state and cleared automatically on new activity; `archived`
means the transcript has been moved into the tool's own `archived_sessions` folder.

## Development

```sh
npm install
npm run compile   # one-off type-check + build
npm run watch      # rebuild on change
npm run package    # build the installable .vsix
```

## License

MIT - see the LICENSE file in this repository.
