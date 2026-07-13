This extension is already published. When rebuilding, use SemVer, maintain the CHANGELOG, and track the currently published version. If our changes can be folded into a recent unpublished version, merge them there instead of creating a new release.
- [x] check whether deleting chats for codex also deletes them from the session_index file.
  > Response: Yes. `deleteSession` calls `deleteArchivedTranscript`, which unlinks the archived transcript and rewrites `session_index.jsonl` without the deleted session id.
- [x] can you check that the codex manual check usage will update the display if its later than the last in message usage?
  > Response: Fixed. Codex usage rendering now compares the manual check timestamp with the transcript usage timestamp and displays whichever source is newer for each usage window.
- [x] did you confirm the above issue, becuase i observed that the manual refresh does nothing.
  > Response: Confirmed a display bug. The Codex usage section could render an empty state before showing manual usage/check status when transcript usage was absent. It now keeps the Check usage control visible and shows the latest manual checked timestamp.
- [x] autocompact should not open an agent terminal if its not already open
  > Response: Fixed. Auto-compact now sends `/compact` only when the matching Codex or Claude terminal is already open; explicit Compact still opens the terminal when needed.
- [x] in the agent finished notification, "open monitor" button does not focus on the existing opened monitor. actually, after 5 min it focued on it. can it be real time??
  > Response: Fixed toward real-time focus. Notification actions now explicitly reveal the existing monitor and focus the active editor group immediately instead of depending on later refresh behavior.
- [x] can you also make the manual check usage display independent of the overall refresh?
  > Response: Fixed. Codex Check usage now updates the current dashboard render directly for the checking/result states instead of waiting on a full agent scan refresh.
