- [x] for claude, see if the usage object is enough to show per session total usage, last run (since last user message) usage, and context window. if so implement copying/reusing the codex display style but with the context bar orange. if not, respond below.

Codex response: Total and last-run usage are implemented — summed across all assistant `usage` entries (`input_tokens + cache_creation_input_tokens + output_tokens`), with the last-run counter resetting on each new (non-internal) user message. Each Claude card now shows a "Total / Last run / Context" usage block in the same `session-usage` style as Codex.

> Response: Context *window percentage* is not implemented as a bar. Codex can compute a percent because it explicitly writes `info.model_context_window` into the transcript; Claude's transcripts never include the model's max context size anywhere (checked transcripts, settings, and the local cache dir). The only way to get a percentage would be to hardcode a lookup table of context windows per model name, which would silently go stale or be wrong for beta/extended-context modes. Instead I show the raw "Context" token count (input + cache_creation + cache_read tokens from the latest assistant turn) without a percent/bar. Let me know if you'd like me to hardcode a per-model window table anyway (e.g. 200k for current Sonnet/Opus/Haiku) despite that risk.

- [x] apply a hardcoded 200k max context window for both claude and codex. if the actual context exceeds the window, change the color of the bar to red.

Codex response: Both usage bars now compute their percent against a single shared `CONTEXT_WINDOW_TOKENS = 200_000` constant (Codex's real per-transcript `model_context_window` is no longer used for this calculation, for consistency between the two). The percent shown is uncapped (so it can read e.g. "131%"), the bar width is clamped to 100%, and the fill turns red (`.usage-fill.over-limit`, reusing the existing needs-approval red) whenever it exceeds 100%. Verified against a real live session whose context is already over 200k tokens — it renders as a full red bar.

- [x] the reviewed status is saved by the extension, so implement that for claude as well, also use the same auto compact on review settings.

Codex response: `ReviewState` is generic by session ID already, so it's now shared directly between Codex and Claude (no collisions — the ID formats don't overlap). Claude sessions gained a `"reviewed"` status (idle + reviewedAt), a `Reviewed`/`Unreview` action pair mirroring Codex's, and resuming a reviewed session (going back to running/needs-input) clears the reviewed flag the same way Codex does. `markClaudeReviewed` also honors `autoCompactOnReview`, running through `sendClaudeCompact` and skipping the compact if context is already at 0%, exactly like the Codex flow.

- [x] for claude. do not include subagents as session cards they would be under .claude/projects/workingdirpath/mainsessionid/subagents/agent-subagentid

Codex response: Confirmed the path shape against a real subagent transcript (`.claude/projects/-home-django/<mainSessionId>/subagents/agent-<id>.jsonl`). Both the active and archived file walks now filter out any path with a `subagents` directory segment before reading sessions. Verified against real data — the count dropped and no `subagents` path remained in the results.

- [x] for claude, the approval notification and the approve/always approve button on cards didnt show up. for claude, the approve would be to go to that terminal and hit enter, for always approve it would be down button then enter.

Codex response: The buttons were missing because `renderClaudeActions` never had a `needs-input` branch — added one with `Approve`/`Always Approve`, wired to new `approveClaudeSession` (sends Enter to the terminal) and `alwaysApproveClaudeSession` (sends Down-arrow, then Enter) commands. Also added a Claude-side transition notifier (`notifyClaudeTransitions` in `extension.ts`) so a warning popup with the same four actions (Open Monitor / Open Agent / Approve / Always Approve) appears when a session transitions into `needs-input`, mirroring the existing Codex approval notification.

- [x] for codex, seems like the unnamed sessions dont show up in session_index. lets explore the actual rollout files to find sessions, if its not named, display the name as the truncated first user message, and display as red.

Codex response: Confirmed against real data — `~/.codex/archived_sessions` had two rollout files whose session IDs were never written to `session_index.jsonl`, so they were completely invisible in the dashboard (not just unnamed — missing entirely). `scanAgents` now also builds synthetic entries for any transcript session ID not present in the index, and falls back to the truncated first real (non-internal) user message as the name when there's no `thread_name`/transcript title, styled red via the same `name-fallback` class Claude's `ai-title` fallback uses. Verified: session count went from 4 to 7 with the two orphaned sessions now showing up correctly.

- [x] when a chat is archived, the id should be unable to click to open, and remove the underline. but keep the color. 

Codex response: For archived sessions (both Codex and Claude), the id now renders as a plain `<span class="inline-action static">` instead of a `<button>` — no `data-command` means the click handler no-ops even if clicked, so it's non-functional, not just visually disabled. The `.static` modifier removes the underline and cancels the hover color-change, while the base `.inline-action` color (including the orange Claude override) still applies, so the color is preserved.
