- [x] it gets stuck at 0s forever "6 sessions · Refreshing in 0s" check the logic to see why its doing that. if the refresh genuinly takes so long, it should be changed to "Refreshing..." while it is actually refreshing, and keep restart the counter after it refreshes.
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

- [x] we would also like a per session cumulative usage, and the current context window. total token usage is a number, while context window is a bar relative to the auto compaction limit, when hovering it will show the actual number.

Per-session usage now uses the latest `token_count` entry in that session transcript. It displays cumulative `total_token_usage.total_tokens`, plus a context bar using latest turn `last_token_usage.input_tokens / model_context_window`. Hovering the context bar shows the raw token count and context window.
- [x] add an approve button and always approve buttons on the needs approval notification, as well as change the "Reviewed" button on the page to the two buttons. which will send a y or p to that terminal respectively. for anything that is running, we can hide the reviewed button. the notification for approval should also include this part of the message (reason and the command also the name of the agent session) "  Reason: Allow reinstalling the packaged Project Monitor extension through the VS Code server.
 
  $ code --install-extension /home/django/everyhedron/project-monitor/project-monitor-0.0.10.vsix
  --force"
- [x] the reviewed tag should to cleared for a project if it ever becomes running after one marked it as reviewed.
- [x] add a auto compact on review checkbox at the top, will will submit a "/compact" message to the corresponding terminal, if auto compact has not been sent due to the terminal already closed, open the agent terminal and copy the /compact command to clipboard, and pop up a notification saying auto compact failed, please paste command to terminal manually.
- [x] you can omit the Total card on top, the default without selecting anything would be total.
