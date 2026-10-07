## [0.11.2]

- Hovering an event on the home page plays a short motion excerpt of it, together with ViON's new event cards: up to 4 seconds of consecutive frames from the keyframe before the event, instead of a few keyframes

## [0.11.1]

- The search re-index counts only its own work: events that already had their vector were shown as failures ("3 of 3, 2 failed"), and a search index that was up to date was never said to be
- A changed plan of ViON Cloud reaches the recording at once, together with ViON 2.3.4: the cloud tells the server, the server tells the recorder. A plan with more cameras starts their recording right away, it used to take up to an hour

## [0.11.0]

- Fewer wrong names on faces, together with ViON 2.3.0. A face that looks about as much like two known people is no longer given to one of them, and for a face that is nobody for sure the recorder says whom it came closest to, which the event trace of the server shows

## [0.10.6]

- An archive whose events are not in the search yet is caught up quickly. In 0.10.5 the next portion of events was taken only once in two minutes instead of 20 seconds after the previous one, so an archive of thousands of events took hours to become searchable

## [0.10.5]

- The search by description finds every event by itself. Events of motion alone, without a recognized object, got into the search only after a re-index started by hand, so most events of a day could not be found. Their pictures are now added to the search automatically, the newest first, and an archive that was never indexed is filled in behind them
- When the search cannot add events, or a re-index started by hand stops, the reason is written to the log

## [0.10.4]

- An archive moved to another disk or folder plays again, and cleanup removes its files, not only their entries. New recordings are stored relative to the archive folder; existing ones are found where the archive is now
- Recordings keep their timing when the server is busy for several seconds. Before, the video after such a stall was shifted by the length of the stall
- The recordings calendar, the dates of the storage page and the names of exported files follow the time zone of the viewer, not of the server
- A timelapse of a range that starts in the middle of a recording was an empty file. It now shows the chosen range and reports its real length
- The export dialog says before the export starts when it is too large for a ZIP archive. A failed export leaves no unfinished file, and the empty folders of expired exports are removed
- Playback no longer runs further and further ahead of the player after pausing, resuming, changing speed or crossing gaps in the archive
- A manual recording is shown as paused while recording is paused for lack of disk space, and goes on when there is room again
- The storage page shows "off" for a camera whose recording is switched off
- An event can be opened by its id, so the moments of the assistant's day summary open their recording
- The recordings page opens far faster on a large archive

## [0.10.3]

- Cameras that send a long header in front of every keyframe (many Hikvision and Dahua models, H.265 streams) are recorded. Such a camera could record nothing at all while the log looked healthy. The log now says when a camera sends video without keyframes
- A full or failing disk no longer stops the recording of every camera at once: recording goes on and the index of the archive catches up
- An exported clip that runs over a pause in the recording ends where it was asked to and reports its real length. Pauses longer than 2 seconds are left out of the clip
- An export too large for a ZIP file is refused at once with the reason, and a failed export leaves no files on the archive disk
- "Record" is refused with an explanation while recording is paused for lack of disk space
- A camera that records two streams no longer flickers to "not recording" when one of them reconnects
- Cameras in "On request" mode are shown with that mode in the storage statistics
- The Episodes view shows the real number of episodes
- Events that happened at the same instant on several cameras are no longer skipped when the list loads more
- The "Recording file length" setting takes effect at once
- AI descriptions: the hourly limit is spent only by events that were sent to the model
- Cleaning up a large archive by its size limit is much faster

## [0.10.2]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [0.10.1]

- Compatibility update for the current ViON version

## [0.10.0]

- Recording on request. A recording can be started by hand or by an automation, extended while it runs and stopped at any time: 5 minutes by default, from 1 to 120. The pre-recording of the camera goes into the beginning of the recording. A camera in "Continuous" mode records anyway and gets no manual recording; a camera with recording turned off or above the plan limit reports an error
- The "On request" mode works again: the camera keeps its pre-recording but records only after a manual start. Detections are saved as events and do not start a recording. Before, such a camera recorded as in "On event" mode
- A manual recording is kept apart from recording started by detections: stopping it by hand does not cut off what a detection asked for. It carries over when the streams of the camera change and ends when recording of the camera is turned off or switched to "Continuous". A restart of the NVR ends a manual recording

## [0.9.0]

- Episodes. Events of one visit from different cameras are joined into an episode by fixed rules: the same kind of object on another camera no later than 45 seconds afterwards (or at the same time), the same license plate or recognized face within 10 minutes. At least two cameras, at most 24 events and 15 minutes; events with motion only do not take part. The interface shows them under Recordings → Show → Episodes
- An episode reaches the interface as soon as the second camera joins and is updated while the visit goes on. After a restart of the NVR an unfinished episode continues
- The episode player shows blocks of cameras: where two cameras see the object at once, the first stays the main one and the second becomes the "Second angle"
- Episode trace: every link with its reason, the participants with their kinds and license plates or faces, and a picture of each event. The mosaic of the episode card has up to four pictures
- Episode download: MP4, or ZIP with a clip for each block of cameras. A favorite episode protects its events from automatic cleanup. A deleted event leaves the episode and the title is rebuilt; an episode left with one camera is deleted

## [0.8.0]

- Sound in the archive. New setting "Record audio" (off by default): the sound of the camera (most often G.711) is converted to AAC while recording; a camera without a microphone still records video. Before, sound was dropped when recording
- Playback plays the sound of recordings that have it. Views that show video only (the camera wall) get no sound
- Export keeps the sound in the MP4 (AAC); for recordings without sound the file stays without it. A timelapse has no sound
- Existing archives are updated by themselves; older recordings are read as recordings without sound

## [0.7.0]

- Assistant tools. The ViON assistant gets read-only access to the archive: the events of a period filtered by camera, object, license plate or recognized face; a summary of one or several days in the time zone of the user, with the main events in order of time; search by description; the license plates that were read; the picture of an event. Before, the assistant could not sum up a day, find an event or list license plates
- License plates are compared without spaces, hyphens and letter case ("К 178 УС 77" and "к178ус77" are the same plate); an unrecognized face is not presented as a person

## [0.6.0]

- The recording filters work: "Triggers" (including sound labels), "Attributes" (face, license plate), "Other" and the "AND/OR" switches between the groups; "AND" binds more strongly than "OR". The confidence threshold no longer drops events without rated detections (sensors, doorbell). A selective filter also finds events beyond the latest few hundred recordings
- The event statistics really count up to 5000 events and the number of segments
- Detection trace: the steps of a detection are saved with the event (and deleted with it) and shown page by page, with pictures from the recording at those moments (the nearest in time)
- Export respects "Quality": "Best quality" takes the stream with the highest resolution, "Smallest files" the one with the lowest (of those recorded in the chosen section)
- The "On request" recording mode had no way to start and recorded nothing: such cameras now record "on event"
- The interface is told what the recorder supports (episodes: not yet, export quality: yes) and does not offer more than that

## [0.5.2]

- Playback at the live edge no longer breaks off when a new recording file starts: the new file can be played at once instead of 4 seconds later
- Updates of one event are handled in order: the end of an event is no longer overwritten by a late update with pictures (events do not stay "active" forever)
- "On event" mode: the pre-recording of a new file does not repeat pictures of the previous one
- A disk write error (no space, disk failure) no longer stops the plugin: the file is closed and recording continues with the next full picture
- After a camera reconnects with a different video format or resolution, recording continues (before, it stopped until a restart)
- The event statistics count up to 5000 events (before, they were cut off at 500)
- Archive cleanup: when a recording file cannot be deleted, it stays listed and the cleanup tries again, instead of leaving behind a file nobody knows about

## [0.5.1]

- Playback of an event that began slightly before the recording (the camera was still connecting, long interval between full pictures) starts from the first recorded picture instead of "No recording"
- A recording file removed by archive cleanup while it is being watched is skipped and no longer ends playback with an error

## [0.5.0]

- AI event descriptions (setting "AI event descriptions"): after an event with a person, vehicle or animal the assistant model describes what happened from the pictures of the event. Works with any assistant model of ViON that understands pictures (OpenAI-compatible gateway, Ollama, OpenRouter and others); there is a limit of descriptions per hour
- Combined AI search: by the content of pictures (CLIP/SigLIP) and by the text of the descriptions, Russian word forms included
- Smart notifications: the description arrives as a notification ("Entrance: Courier left a parcel")
- An event can be described on request

## [0.4.0]

- Search in events by meaning: the pictures of detected objects are indexed, and a text query is matched against them with the help of the CLIP plugin (ONNX, OpenVINO, CoreML); older events can be indexed again from their pictures
- Faces: a database of known people (several photos per person), matching at detection, unknown faces with grouping of similar ones, ignoring faces, correcting a name in an event teaches the system, repeated matching
- The search data is stored separately and is no longer sent to the interface together with the events
- Thumbnails of faces and license plates are displayed (before, they were not shown)

## [0.3.0]

- The recording settings show the plan, its limits and the cameras that take up the recording slots
- Events that were left active after a restart are closed at startup
- Built into the ViON server: installed and updated together with it

## [0.2.0]

- Limits of the ViON Cloud plan: the number of cameras with recording and the longest archive period (a server without the cloud uses local limits)
- The plan is shown in the recording settings

## [0.1.0]

- First version of ViON NVR: continuous recording and recording on event, timeline, playback, events, MP4/ZIP export, retention period and disk limits
