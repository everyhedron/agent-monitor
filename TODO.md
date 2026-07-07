- [x] it gets stuck at "6 sessions · Refreshing..." forever. is it genuinly taking so much time? is something blocking it? what are the heavy operations? Can you confirm that it loops back to counting after it finishes refreshing?

The webview now resets the countdown after refresh failures/timeouts instead of staying on `Refreshing...`. Scan timing is exposed in the header tooltip. Current smoke scan: total 2677ms, index 14ms, transcripts 2561ms, process check 85ms, so transcript parsing is the heavy operation.
- [x] what error was it omitting? if there are errors we should actively print to the vscode output section for this app, which i assume is the console.log, instead of silently swallowing.

Codex response: Added an `Agent Monitor` VS Code output channel and scan diagnostics for index, transcript, process-check, webview-message, and notifier-poll errors. Missing optional transcript folders stay quiet; malformed transcript/index lines are counted and logged instead of being silently swallowed.
- [x] to submit the compact command automatically, it should be "/compact" and enter, instead of /compact\n, which will paste in an actual newline
- [x] for the above item, it still doesnt work, did we actually try entering /compact and sending an enter key action? im still getting /compact with a trailing newline.

Codex response: Replaced `Terminal.sendText("/compact", true)` with VS Code's terminal sequence command using `/compact\r`, which sends the command plus carriage-return Enter to the active shown terminal instead of asking `sendText` to append a newline.
- [x] can you confirm that the last xx.x token is counted since the last user input, not just the very last agent action?

Codex response: It was previously using Codex's raw `last_token_usage`, which is the latest reported action/model call. The dashboard now computes `Last run` by diffing total token usage since the latest real user message and falls back to `last_token_usage` only when no baseline exists.
- [x] after reload, maybe we have multiple panels so the page is opened and pined multiple times on each panel. or maybe we did not successfully detect there are already existing monitor page. effect is, when i reload, i get duplicated pages.

Codex response: Dashboard attachment now enforces a single monitor panel. If startup open and restored webview panels race, the later duplicate panel is disposed and the existing panel is revealed.
- [x] ![alt text](image-1.png) we should make the notification for needing approval more beautiful. such as in the beginning just say which agents needs approval, then another line the reason (could be truncated), then the raw command on another line.

Codex response: Approval notifications now use separate lines: `Approval needed`, truncated `Reason`, and truncated `Command`, while keeping the monitor/open-agent/approve/always-approve actions.
- [x] ![alt text](image-2.png) for agent finished notification, we should have just which agent finished, a truncated version of its last message. and info in terms of its usage for the last run. and for buttons, we dont want the mark reviewd. we want an open agent button.

Codex response: Finished notifications now show the agent name, truncated last agent message, and last-run usage (`tokens`, `5h`, `7d`). Buttons are now `Open Monitor` and `Open Agent`; `Mark Reviewed` was removed.
