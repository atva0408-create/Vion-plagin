# ViON NVR

ViON's own video recorder: it records your cameras and keeps the archive on your own server.

## What it does

- Records each camera continuously, on event (with the seconds before and after it) or on request: a manual recording runs 1 to 120 minutes, 5 by default.
- Shows the archive on a timeline with a calendar of recorded days, pause, speed and preview pictures.
- Keeps detection events with thumbnails, filters, favorites and a heatmap.
- Joins events of one visit from several cameras into an episode, for example a person walking from the gate to the door.
- Exports a section as MP4, as a timelapse, or several cameras at once as a ZIP file.
- Can have the assistant model describe events: you find them by text in "AI Search" and get the description as a notification.

## What you need

- The ViON Cloud plan of the server owner decides how many cameras may record and how long the archive is kept. A server not linked to ViON Cloud uses its local limits.
- For AI descriptions: an assistant model that understands pictures (Settings → Assistant) and permission for ViON NVR.

## Settings

- "Keep recordings, days": older video and events are deleted automatically; not longer than the plan allows.
- "Archive limit, GB" and "Minimum free space, %": when the archive exceeds the limit or less space is free, the oldest recordings are deleted.
- "Record audio": saves the sound of the cameras in the archive; off by default.
