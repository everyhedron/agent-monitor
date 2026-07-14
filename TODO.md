This extension is already published. When rebuilding, use SemVer, maintain the CHANGELOG, and track the currently published version. If our changes can be folded into a recent unpublished version, merge them there instead of creating a new release.
- [x] can you check that the codex manual check usage will update the display if its later than the last in message usage?
  > Response: Fixed. Codex usage rendering now compares the manual check timestamp with the transcript usage timestamp and displays whichever source is newer for each usage window.
- [x] did you confirm the above issue, becuase i observed that the manual refresh does nothing.
  > Response: Confirmed a display bug. The Codex usage section could render an empty state before showing manual usage/check status when transcript usage was absent. It now keeps the Check usage control visible and shows the latest manual checked timestamp.
- [x] ![alt text](image-5.png) the 7day usage never updated. its already july 14 and its still reporting july 10. also after clicking check usage, it gives an ungly checked at string. this should be the same thing as the hover last reported. if the in transcript is latest, use that date, if the manual check is latest use that.
  > Response: Fixed. The live Codex usage response now maps windows by duration, so a 604800-second window updates the 7d card instead of the 5h card, and the visible reported timestamp uses the latest source timestamp in the same concise format as the hover/reset labels.
- [x] in the agent finished notification, "open monitor" button does not focus on the existing opened monitor. actually, after 5 min it focued on it. can it be real time??
  > Response: Fixed toward real-time focus. Notification actions now explicitly reveal the existing monitor and focus the active editor group immediately instead of depending on later refresh behavior.
- [x] can you also make the manual check usage display independent of the overall refresh?
  > Response: Fixed. Codex Check usage now updates the current dashboard render directly for the checking/result states instead of waiting on a full agent scan refresh.
- [x] ![alt text](image-6.png) the compact button is gone despite the terminal being open.
  > Response: Fixed. Dashboard rendering now reconciles open agent terminals by visible terminal name, including VS Code's appended suffix text, before deciding whether to show Compact.
