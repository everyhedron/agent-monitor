rebuild into new vsix, then install.

- [x] also include last run duration.

  > Response: Added `lastRunDurationMs` to both session types, computed as wall-clock time from the start of the latest real user turn to the most recent agent activity since then. For Codex, that's `lastCompletionMs - latestUserMs` from the transcript, only populated once `task_complete` has actually fired (mirrors the existing `hasCompletion` gating already used for `lastCompletionAt`). For Claude, which has no explicit "run complete" event, I added timestamp tracking to `claudeScanner.ts` (the transcript lines weren't being parsed for `timestamp` at all before this): the clock resets alongside `lastRunTokens` on each new non-slash-command user message, and stops at the most recent real (non-synthetic) assistant message. Both render as e.g. "3m 42s" or "1h 12m" next to the existing "Last run N tokens" line via a new `formatDuration()` helper.
- [x] please implement codex check usage button which is to query "https://chatgpt.com/backend-api/wham/usage" with with access token in.codex/auth.json as the bearer token. it will return something like this "{
    "user_id": "xxx",
    "account_id": "xxx",
    "email": "xxx",
    "plan_type": "plus",
    "rate_limit": {
        "allowed": true,
        "limit_reached": false,
        "primary_window": {
            "used_percent": 2,
            "limit_window_seconds": 18000,
            "reset_after_seconds": 17478,
            "reset_at": 1783634989
        },
        "secondary_window": {
            "used_percent": 90,
            "limit_window_seconds": 604800,
            "reset_after_seconds": 80213,
            "reset_at": 1783697724
        }
    },
    "code_review_rate_limit": null,
    "additional_rate_limits": null,
    "credits": {
        "has_credits": false,
        "unlimited": false,
        "overage_limit_reached": false,
        "balance": "0",
        "approx_local_messages": [
            0,
            0
        ],
        "approx_cloud_messages": [
            0,
            0
        ]
    },
    "spend_control": {
        "reached": false,
        "individual_limit": null
    },
    "rate_limit_reached_type": null,
    "promo": null,
    "referral_beacon": null,
    "rate_limit_reset_credits": {
        "available_count": 2
    }
}"

  > Response: Implemented in a new `src/codexUsage.ts`: reads `<codexHome>/auth.json` (defaulting to `~/.codex`, respecting the existing `agentMonitor.codexHome` setting), tries `tokens.access_token` first (that's the field name I've seen documented for the Codex CLI's stored login), then falls back to a top-level `access_token` or `OPENAI_API_KEY` in case the CLI's schema has shifted - I did not inspect your actual auth.json contents while writing this (a permission check in this environment blocked that as unnecessary credential scanning), so if none of those field names match, the button will surface a clear error via the output channel and a VS Code error toast rather than failing silently. The button now does a real `fetch()` to the wham/usage endpoint with `Authorization: Bearer <token>`, and merges the response's `primary_window`/`secondary_window` percentages and unix-second `reset_at` values into the same usage cards Codex already populates from transcripts - manual check results take priority per-field, falling back to the transcript-derived values if a field is missing. The disabled grey button from last round is now the real thing (default button styling, matching the existing Codex blue accent used elsewhere in the dashboard). Please try clicking it once installed and let me know if the auth.json field name needs adjusting.

- [x] since you are adding the year to the claude usage, can you check that for edge cases where we are nearing the end of year, will it behave nicely.

  > Response: Good catch - this was a real latent bug. The old code always stamped the reset date with the *current* year, so a check made on e.g. Dec 30 with a reset date of "Jan 2" would have rendered "Jan 2, <this year>" instead of "Jan 2, <next year>" - a year in the past. Fixed by comparing the reset's month against the reference date's month: since Claude's session (hours) and week (days) windows only ever reset a few days out at most, the *only* way the reset's month can appear earlier than the reference month is a same-instant wrap into January - never a same-year rollback - so I increment the year in exactly that case. Verified the logic against both a mid-year reference (no change) and an end-of-year reference with a January reset (correctly rolls to next year).

  **Publishing steps (👤 = you have to do this personally, 🤖 = I can run this for you once the 👤 steps are done):**

  1. 👤 Create a publisher on the [VS Code Marketplace management page](https://marketplace.visualstudio.com/manage) (needs a Microsoft/Azure DevOps account). The publisher ID has to match `package.json`'s `"publisher": "everyhedron"`.
  2. 👤 In Azure DevOps, create a **Personal Access Token** with the "Marketplace (Manage)" scope. Treat it like a password - don't paste it into chat or commit it anywhere.
  5. 🤖/👤 Run `npx vsce login everyhedron` once and paste in the PAT when prompted (I can run the command, but you'll need to type the token in yourself since it shouldn't pass through chat).
  6. 👤 Decide on a version bump (currently `0.0.1`) and confirm you want to publish - actually publishing is a one-way, publicly-visible action, so I'll always ask before running it even if steps 1-5 are done.
  7. 🤖 Once you say go: `npx vsce publish [patch|minor|major]` (bumps the version and publishes in one step), or `npx vsce publish` to publish the current version as-is.

- [x] first version will be 1.0.0. im currently still creating the azure account and stuff. go through the entire code thoroughly, dont modify anything, write below what can be refactored, improved, are there any risks, suggestions, etc.

  > Response: Read through every file in `src/` (types.ts, scanner.ts, claudeScanner.ts, codexUsage.ts, dashboard.ts, extension.ts, config.ts, reviewState.ts) plus package.json/README/LICENSE - no code changed, as asked. Findings below, roughest/most important first.

  > **Risks:**
  > - The new Codex "Check usage" button (this round) calls `chatgpt.com/backend-api/wham/usage` - an internal/undocumented ChatGPT backend endpoint, not a published third-party API. It works today because it's the same endpoint the Codex CLI itself uses, but OpenAI can change or block it without notice, and it's worth your own judgment call on whether calling an internal backend API from a published Marketplace extension is something you're comfortable with before 1.0.0.
  > - Both usage features fundamentally scrape either free-text CLI stdout (`claude -p /usage`) or JSONL transcript fields whose schemas aren't a stable public contract. If either CLI changes its output wording or field names, the parsing regexes (`parseClaudeUsageText`, the Codex `rate_limits` field reads) will silently return `undefined`/fall back to "unavailable" rather than erroring loudly - safe-but-silent, so a future format change could go unnoticed for a while.
  > - `execFileAsync("claude", ...)` and `execFileAsync("ps", ...)` assume `claude` and `ps` are on the extension host's PATH. GUI-launched VS Code (especially on macOS) doesn't always inherit a full shell PATH, so "Check usage" and Codex-process-detection could fail with an unhelpful error for some users - worth a troubleshooting note in the README once you see real user reports.
  > - `resolveTerminal()` matches terminals by exact tab name string. Two sessions that happen to produce the same fallback display name (or a user manually renaming a tab to collide) could make an approval/compact action target the wrong terminal. Edge case, but it's sending real keystrokes, so worth knowing about.
  > - Full transcript files are re-read and re-parsed line-by-line from disk on every single poll tick (every `refreshIntervalMs`, default 5s), for every transcript, forever - no incremental/cached parsing by mtime or byte offset. Fine for small transcripts; on a long-running session with a transcript that's grown to tens of MB, this is the most likely source of real CPU/IO cost as usage scales.

  > **Refactor opportunities:**
  > - `escapeHtml`, `truncate`/`truncateLines`, `formatCompactNumber`, `formatPercent`, and time-parsing (`parseTime`) are each duplicated near-verbatim across 2-4 files (`scanner.ts`, `claudeScanner.ts`, `dashboard.ts`, `extension.ts`). Worth consolidating into one `src/utils.ts` - purely mechanical, low risk, but currently a bugfix to one copy (e.g. an escaping edge case) has to be remembered and applied to every duplicate.
  > - `CONTEXT_WINDOW_TOKENS = 200_000` is a single hardcoded constant used for both Codex and Claude context-percent bars, even though real context windows vary by model (e.g. some Claude models support far more than 200k). It's honestly labeled "(assumed)" in tooltips already, so this is a known simplification rather than a bug, but as you approach 1.0.0 it might be worth deciding whether to surface the assumption more visibly in the README's feature description (it's currently only in a hover tooltip).

  > **Suggestions:**
  > - No automated tests anywhere in the repo. The pure-function parsers (`parseClaudeUsageText`, `normalizeClaudeResetLabel`, `deriveStatus`, `parsePermissionRequest`) are exactly the kind of logic that's cheap to unit-test and easy to silently regress - these would be my first candidates if you want a minimal test suite before 1.0.0.
  > - No CI workflow (no `.github/workflows/*`) to run `tsc --noEmit` / `vsce package` automatically on push or PR - currently that only happens when I (or you) run it manually.
  > - No CHANGELOG.md - worth starting one now, before the 1.0.0 cut, so the jump from 0.0.1 has a record of what shipped.

- [x] also check git history for all the sensitive information such as my domain, email, password, secrets, file paths, etc. list below what they are and you can write the actual value to somewhere in your claude folder, and point me to where i can find them. i need to evaluation the risk of publishing.

  > Response: Searched the full git history (`git log -p --all`, all 14 commits) for credential patterns (API-key/token/PEM-key shapes), email addresses, absolute file paths, and domain mentions. Full findings with the actual values are written to `/home/django/.claude/agent-monitor-git-history-scan.md` (not in this repo, so it doesn't itself become part of what you'd publish). Summary:
  > - **The one real exposure**: every commit's author/committer email is permanently baked into history - two real addresses at your `everyhedron.com` domain. If this repo goes to a *public* GitHub repo, those become publicly visible and scrapable by anyone who clones it, not just people who browse the GitHub UI. This is the thing most worth a deliberate decision before making the repo public - options (squash history, or rewrite authors repo-wide with `git filter-repo`) both rewrite commit hashes, so I did not do either without you confirming first.
  > - `everyhedron.com` / the `everyhedron` publisher name also appear intentionally in `package.json`, `LICENSE`, and the git remote - this looks deliberate (it's your public Marketplace identity anyway), flagging only for completeness.
  > - A few old, already-resolved TODO.md entries contain pasted local file paths (`/home/django/...`) and a sibling/precursor project name ("project-monitor") - low sensitivity, no credentials.
  > - No actual API keys, OAuth tokens, JWTs, private keys, or passwords turned up anywhere in the 14-commit history.
