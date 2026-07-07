- [x] please initialize git and use "git@github.com:everyhedron/agent-monitor.git" as remote. there is an MIT licence on the remote that we should pull and use. stage, commit, and push all changes.
- [x] currently the agent monitor and the project monitor have different ways of tracking the terminal name and if a session is already existing. we need them to be identical. do not include the id in the name of the terminal. just use "Project Name | Codex". if the logic in Project Monitor is not optimized, write below this line what are the isses, because earlier I used project monitor to start a agent terminal for agent monitor, and it created a new "Agent Monitor | Codex" instead of focusing the existing one. Do not edit the project monitor app, write me the diagnosis. 

Project Monitor diagnosis:

Project Monitor names agent terminals as `Project Name | Codex`, but it tracks reuse with an in-memory `Map` keyed by `agent:${projectPath}`. That map is only populated for terminals Project Monitor itself created during the current extension-host lifetime. If a terminal already exists from another source, or if VS Code reloads and the map is empty, Project Monitor does not scan `vscode.window.terminals` by terminal name. It will create a new `Agent Monitor | Codex` instead of focusing the existing one. Agent Monitor now uses the same terminal name format, but it checks `vscode.window.terminals` by name before creating a terminal.

- [x] for archived chats, remove the "Review/Unreview" buttons
- [x] same as project monitor whichever viewing mode is active, make it blue, the other one white. do not make both blue.
- [x] make the status sum cards on the top togglable by clicking. if nothing is selected, it will show all chats. if some are selected it will show only chats of those statuses.
- [x] for this line "/home/django/.codex · refreshed 7/7/2026, 12:24:12 PM · every 5s · reviewed saved in VS Code global state" keep it as clean as project monitor. n sessions (hover will show the count for each status), Refreshing in [countdown]s.
- [x] on the top we also want to have a usage traking the 5h usage, reset times, and 7 day limit. is this an information that is available in each session files? if so, write below what information we have available, i will choose which ones to include for each card. if information are available, implement the total 5h and 7d usage bar with reset times. if not, write below your suggestion. 

Usage information available:

Codex session transcripts include `event_msg` entries where `payload.type` is `token_count`. The useful fields are:

- `payload.info.total_token_usage`: cumulative input, cached input, output, reasoning output, and total token counts for that transcript.
- `payload.info.last_token_usage`: token counts for the last model turn.
- `payload.info.model_context_window`: model context window size.
- `payload.rate_limits.primary`: current 5h window usage, with `used_percent`, `window_minutes: 300`, and `resets_at`.
- `payload.rate_limits.secondary`: current 7d window usage, with `used_percent`, `window_minutes: 10080`, and `resets_at`.
- `payload.rate_limits.plan_type`: current plan label, for example `plus`.

Agent Monitor now uses the latest transcript `token_count` event to render total 5h and 7d usage bars with reset times.
- [x] Similar to project monitor, we want on the button status bar an icon with a x/y number. x is number of items needing review or needing approval, y is the total number of chats. when hovering it will display count for each status. and clicking will open or focus the page.
- [ ] 
