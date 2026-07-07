- [x] to submit the compact command automatically, it should be "/compact" and enter, instead of /compact\n, which will paste in an actual newline
- [x] for the above item, it still doesnt work, did we actually try entering /compact and sending an enter key action? im still getting /compact with a trailing newline.

Codex response: Replaced `Terminal.sendText("/compact", true)` with VS Code's terminal sequence command using `/compact\r`, which sends the command plus carriage-return Enter to the active shown terminal instead of asking `sendText` to append a newline.
- [ ] we are still not getting the compact message to submit. maybe try waiting for 1 second before hitting enter? maybe we needed the command list to react
- [x] after reload, maybe we have multiple panels so the page is opened and pined multiple times on each panel. or maybe we did not successfully detect there are already existing monitor page. effect is, when i reload, i get duplicated pages.

Codex response: Dashboard attachment now enforces a single monitor panel. If startup open and restored webview panels race, the later duplicate panel is disposed and the existing panel is revealed.
- [x] ![alt text](image-1.png) we should make the notification for needing approval more beautiful. such as in the beginning just say which agents needs approval, then another line the reason (could be truncated), then the raw command on another line.

Codex response: Approval notifications now use separate lines: `Approval needed`, truncated `Reason`, and truncated `Command`, while keeping the monitor/open-agent/approve/always-approve actions.
- [x] ![alt text](image-2.png) for agent finished notification, we should have just which agent finished, a truncated version of its last message. and info in terms of its usage for the last run. and for buttons, we dont want the mark reviewd. we want an open agent button.

Codex response: Finished notifications now show the agent name, truncated last agent message, and last-run usage (`tokens`, `5h`, `7d`). Buttons are now `Open Monitor` and `Open Agent`; `Mark Reviewed` was removed.
- [ ] make the open trastript action agent text regular color instead of blue. and underlined only when being hovered.
- [ ] for a project i added a new file which is unstaged, why does it not say unstaged, instead it says 
- [ ] how does 
