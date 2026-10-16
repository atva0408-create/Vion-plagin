## [0.23.0]

- A thing marked on a picture of the archive is followed by its outline: when it went and who carried it off (the assistant's `marked_thing`, «Кто унёс?» in the archive). Asked once, answered in minutes, never in the background. The outline comes from ONNX or OpenVINO 1.7.4 (ONNX Legacy 1.5.5, OpenVINO Legacy 1.5.4); the moments to look at come from the history of the place. It is gone only when it is still gone 5 s later and nobody from the event traces stands over the place (else 15 and 45 s later); the moment is found to a second. From the last picture with it, 2 pictures a second for up to 20 s follow it, also in the hands of the people traced near it; the one in whose box it was seen most is named, nobody else (a passer-by beside the place is never named for a thing nobody was seen carrying). A turn of the camera ends the search («there until the turn»)
- It is there when the outline of its box (10 % wider) or of its middle point overlaps the marked one by 0.4 at least, is within ×2.5 of its size and has the same pattern and hue (colour without brightness: a red cup at dusk, 30 % darker, is the same cup). At night and for dark things only the pattern. On the real model a thing was found on the picture it was marked on 15 times of 15, an empty desk was gone every time, a warm lamp and 30 % less light left it there. An empty place marked is said not outlined
- A question keeps to 8 minutes from the moment it is asked, its wait in the queue and the model's first load included, and to 120 pictures; past that the answer is what was found so far (`cut`), never «still there». Questions about a thing, about a place and `object_gone` go one at a time

## [0.22.12]

- A continuous recording keeps the first GOP of every connection: the file began at the second keyframe (the codec is learned from the first one once it is whole), and a second or two was lost after every restart, 50 s on a camera that sends a keyframe that rarely
- Older files that run on after a hole in their video end before it: a file of 155 minutes on the bench had 14 s of video and a few frames 2.5 hours on, and the hole showed as recorded. The one-time end of older files runs once more
- The newest seconds of the archive are read from the file being written: the scrubber and the trace found nothing for the last seconds, though the file had them

## [0.22.11]

- A recorded file is cut where its video stops: video that stops for 20 s ends its file at its last frame and what comes after is a file of its own, so a camera that stops sending video on an open connection is no longer shown recording, and the hours until it comes back are a gap on the timeline (a file of 155 minutes on the bench held 14 s of video at its start and a few frames at its end). Video that waited while the recorder was busy keeps its times and is no gap
- The patches of the search for when a thing went keep to their times (they were up to half a second early for their pictures, and a stretch ending just after a keyframe read the whole file or failed); far from a keyframe a picture is the keyframe after within 30 s or none, not one of another minute
- The one-time end of older files goes past a file it cannot read, and a file being written is never deleted with a range

## [0.22.10]

- A recorded file ends with its last frame, not when it was closed: a stream that stopped with its connection open left a file of a few seconds open, and its row said it was recorded all that time (a Xiaomi on the bench: 42 and 155 minutes over files of 6 and 14 s). The timeline showed those minutes recorded and every picture asked there read nothing. Files closed so by older versions end at their last frame after the first start (read once, only the files that end more than a minute past their last keyframe)
- The picture of a time is the frame of that time: the search for when a thing went and the history of a place read the picture of the keyframe after the time (1-2 s late on every camera, minutes late or nothing on a camera that sends keyframes rarely). The exact frame of the archive and of a trace, more than 300 frames past its keyframe, stopped short of the time and gave the last frame read as its picture; it now gives the nearest keyframe of the file, with its own time

## [0.22.9]

- The database of the recorder keeps to a size: its detection traces were most of it (744 thousand rows, 1.2 of 1.41 GB on the bench) and those of the events whose video is still there were never cleared. Over «Предел базы событий, ГБ» (Storage, 1 GB unless set; 0: no size) the retention clears the traces of the oldest events, 200 at most every five minutes; the events and the recordings stay. The file does not shrink, its freed pages are used again and it stops growing

## [0.22.8]

- A camera that does not answer is told once, not every minute: the recorder of an unreachable camera wrote «stream ended (HTTP 500); retrying in 60s» every minute all night (177 warnings a night, each an event of the system panel). Its first end is told as before, then once that the camera does not answer since then and is tried quietly every minute, and that it answers again when it does. A camera that is back records within a minute as before

## [0.22.7]

- The search index no longer holds the recorder every two minutes: its look for the events without a picture's vector went over the vectors by their model and read every vector for every event (12.5 s on the bench's 4 097 events with a warm cache, minutes on its cold disk after a start, every camera's messages timed out meanwhile). Two indexes answer it alone: 25.8 s → 2.5 ms on a database of that size (built once at the start, a few seconds)

## [0.22.6]

- No minute of a held recorder after a start: the first pass of the retention read every event of each camera older than its oldest video again (its progress was kept in memory only), and an event of a camera not recording at its start looked through every earlier file of the camera with its keyframes at each message. On the bench's HDD, cold after a restart and busy with the engines loading, the recorder's one thread stood for up to a minute and 35 messages of an event timed out. The progress is kept in the database, and an index of each file's span answers the look alone (built once, ~3 s for 12 783 files)

## [0.22.5]

- The engine of the search in pictures can be chosen: Settings of the NVR → AI → «Движок поиска по картинкам» lists the detection engines with CLIP here (ONNX Legacy on the GPU, OpenVINO on the CPU…). The chosen one is asked first; when it is not there the search goes on as before and the setting says it is not installed. «Автоматически» is the first that answers, as it was

## [0.22.4]

- The describer of events describes an event of a module's class too (a store module's bicycle: only a person, a vehicle or an animal was offered to the model), and is told what modules answered («Ответы модулей: играет в компьютер: нет, да; поза: сидит») as a hint beside the pictures
- Episodes: a class of a module is a kind of its own, joined across cameras with the same class and not with a person, and names the episode («Самокат: Въезд → Входная дверь»; it was «Движение» with no link); what modules answered yes in its events is told in the description
- With ViON 2.6.1 a question answered only «нет» names no event: at its first start the plugin takes such a question out of the types of the events recorded before, once, a batch at a time (the filter by type, the search and the counts found the child not playing)

## [0.22.3]

- A person's route: a hop between cameras needs a likeness of at least 0.2 at the broadest precision (it went down to 0.1, where the most alike person of another camera minutes later is almost anyone: on the bench 75 % of the same minutes of other days passed 0.1, 42 % pass 0.2). The hops keep a threshold of their own under the one asked for the stays, moved by it: across cameras re-ID is weak (8 % of the bench's hops pass 0.6)
- The detection traces behind the oldest video are cleared reading only the events since the last pass, by an index (every five minutes each pass read every old event of each camera)

## [0.22.2]

- The privacy zones of a camera are black in every picture of its recording that «what became of a place» and «when a thing went» read and show the assistant: the recording is the camera's raw video, and those pictures went to the model with what the zones hide
- What became of a place: a thing taken (or brought) as the light changed between day and night is said between the two nearest pictures by one light, around the night, instead of hours off at the next change of light as exact; the history says it too
- When a thing went: the night coming is no longer taken for a turned camera (a night picture and a day one of the same room differ as much as a turned camera's), which looked for the thing only before the dusk; a camera turned within a minute of the thing's first look is said with the thing there until the turn, not «nothing recorded»
- A look at a keyframe of a 50 or 60 fps camera reads that keyframe, not the next one (changes were dated a keyframe early, the last keyframe of each file read nothing)
- No pause in the recording is said for a change right after the marked moment; a picture that cannot be made (its file deleted meanwhile) no longer loses the whole answer; a short search says its step in seconds
- A decode that hangs is stopped after two minutes: it held every later search behind it

## [0.22.1]

- A detection trace goes with the video it is drawn on: the disk guard and the quota delete the oldest video long before events go by their days, and the trace of each event stayed until the event went (969 MB of a 1.4 GB database on the bench, a week older than its video). Retention clears the trace of a camera's events older than its oldest video left, a little at a time; the events stay
- When a thing went: a PTZ camera turned is no longer taken for its going (the place is elsewhere in the picture after it). The turn is said, and the thing is looked for only before it
- The describer of events is given no empty picture: an empty card file went to the model as an empty image

## [0.22.0]

- What became of a place marked on a frame of the recording: with ViON 2.4.5, pause a camera's recording, outline a place and ask where what lay there went, when it came or what was there over a while. The place is watched, not the thing, so anything works, also what the search in pictures does not know: its look at keyframes (only keyframes are decoded, 0.15-0.2 s each) is compared with the marked moment, and each change is narrowed to neighbouring keyframes (1-3 s) with the stretch someone stood in front of it. The rest of the picture tells a turned camera (the looking stops there) and night pictures (compared with night pictures only). The assistant says the moments in the person's clock with the pictures before and after, the events by them and buttons that open the recording paused on them; a week at most per question

## [0.21.1]

- When a thing went: the last minutes are compared with how the place looked in the stream itself (the scaled whole frame differs from it a little, and on a real camera nothing was taken as the same); a thing that moves while it is there (a person at a desk) is said between two moments about a minute apart

## [0.21.0]

- When a thing that lay in a camera's picture went: ask the assistant «на камере в прихожей лежал телефон — когда он исчез». The search in pictures finds the thing where it lay in the recording, the recording is halved, and the last minutes are compared twice a second with how the place looked; the answer gives the last moment the thing was seen and the first it was not (to about a second), the events around it (who was by it) and two pictures of the place, before and after, which the assistant looks at before telling. A person standing over the thing for a while and a finder missing it now and then are not taken for its going; a pause in the recording is said. Needs ONNX or OpenVINO 1.7.0 for the search in pictures; takes up to a few minutes

## [0.20.1]

- The assistant finds the recorder's settings: person_route names the hop settings and that the assistant can change them; with ViON 2.4.4 it sets a value only as its field takes it and shows each setting by its title, from what to what, before it is confirmed

## [0.20.0]

- A person's route follows the precision asked: the «More precise» slider of the recordings page made only the stays stricter, the hops between cameras stayed at 0.35 whatever it said. The hop threshold now moves with the slider as much as the stays' threshold (0.475 at the top, 0.275 near the bottom); the assistant's person_route takes the same `precision`
- The hops are set in the NVR's settings (People): the likeness a hop needs at the middle precision (0.35), how many minutes after or before a stay the person is looked for on another camera (3), how many hops in a row at most (6; 0 for a route by likeness alone)

## [0.19.1]

- The recorder no longer ends its process when the search in the picture fails (the bus not answering in 30 s, NATS reconnecting, a stop): the failure is the query's and is said to the page; the recording goes on
- A start no longer holds the recorder ~50 s: the retention read every segment row to find the old ones (a 1.37 GB database on the bench's HDD), now only the old ones; the events still going on are found by an index instead of reading every event each minute
- The search by description finds its best again: the compact index of 0.19.0 kept the signs of each vector, too coarse for CLIP's text-to-picture scores (among 300 000 pictures 34 of the 50 best were left); it keeps int8 vectors now (≈210 MB for 400 000), scored within a few thousandths of the cosine, the recording getting its turn every 8192 vectors
- A search narrowed to cameras or days takes the best of those cameras and days (it took the best 2000 of all and dropped the rest: a camera with weaker matches got few or none); a person's route reads its short windows from the table again (50 ms on 400 000 vectors instead of 493)
- After a re-index by another model (CLIP to SigLIP) a replaced vector leaves the index of the model it was of (it took a candidate's place and could answer a CLIP query with an event without a CLIP vector); the people's data cleared while the index is read at start no longer leaves what is filed after it unfound until a restart
- Search in the picture: the query typed last is looked at first (the pictures of the one before no longer hold it up), one nobody asks for in 30 s is left, and a failure is told only to the search waiting for it (not to the same words a day later); an empty picture file is no picture, the event's next one is looked at; an engine updated while the recorder runs is found without a restart, and one without a finder is said as such, not as a failure. Pictures that cannot be read need ONNX/OpenVINO 1.7.1 (legacy 1.5.1)
- The assistant: person_route is an admin's, as the people search; the route of a crowd dressed alike says it was cut and gives the 50 stays nearest the moment (it gave 400-500, 40 KB); attribute_time counts several people in one stay once (two lying and a grown-up standing by made 100 minutes of an hour) and reads the questions and their answers in one pass (2.9 s → 1.4 s for 60 000 events); line_counts knows a label in capitals («Самокат») and tells how many are inside by camera, line and class (it summed every line: a person through the gate and the door was two); a day whose midnight the clock skips (Chile, Cuba) starts after the jump

## [0.19.0]

- The searches over the archive — by description and for people — keep their vectors in a compact index: on 400 000 vectors the recorder held 2.3 GB and stopped for 10 s at the first search; now about 170 MB, read in the background at start a portion at a time (the recording is held 0.1 s at most). A search by description takes about 70 ms instead of half a second, a people search over 90 days about 50 ms instead of 3.5-6 s (measured on a PC, spec/bench-vectors.ts)
- The route of a person goes on camera to camera: from the end of a stay to the best moment of another camera within three minutes, even when re-ID alone is not sure (from 0.35 instead of 0.525), and from there on with how the person looks on that camera. Across cameras re-ID is weak — another light, another angle — but who appears in the next camera a minute later is one of a few. On the bench (door and lift, 73 passes) the route now finds 56 % of the passes instead of 23 %, and links someone else in 3 % of the windows that hold other people (9 of 296). A chain stops after six hops; the recordings page draws such stays dashed and the assistant says them (`hop`)
- Search in the picture: for the events the search by description found, the recordings page asks where in their picture the thing is, and the text finder of the ONNX plugin (1.7.0: the query put into English, OWL-ViT boxes it) answers with its boxes and a crop of the find (findInEvents). A call answers at once with the finds made and the events still looked at, asked again (a call ends after 30 s, the finder takes longer to load); the pictures go to the finder one at a time, a dozen events a call, the finds of the latest queries kept; a failure is said to the next call
- The searches by description and in pictures carry the platform's language to the engines (searchEventsByTextQuery `language`, searchEventsByText, findInEvents, the assistant's search in the language of the conversation): ONNX and OpenVINO 1.7.0 put the query into English for their English-only models, from Russian whenever it has Cyrillic, else from that language

## [0.18.0]

- A question of a module answered with words of its own — the posture of people: стоит, сидит, лежит — is asked by one of them: «поза: лежит», or just «лежит». The assistant finds the events in which someone lay (query_events, event_stats), adds up how long someone lay a day (attribute_time) and counts the postures in a day's summary; the other words of the question are its «no» (standing or sitting: not lying). The list of the questions names such a question by its words
- How long a module answered counts the time of each answer when ViON gives it (a run of the same answer within one stay: stood ten minutes, then lay fifty), not the whole stay; events from before keep counting their whole segment

## [0.17.0]

- Where a person went, camera after camera: from a moment of the people search the recordings page shows the route (Маршрут) — the stays of the person on each camera with person re-ID, in time order, half an hour before and after, each with its moment; the assistant answers «куда он пошёл потом» with the same route (person_route). Re-ID compares clothes and build, so a stay can be someone dressed alike; the cameras that saw nobody are named
- The recorder keeps how many people and vehicles cross each line drawn on a camera, in or out when the line has a way in (from ViON's version that reports each crossing once): the assistant counts them over time for charts — per hour, day or week, or the hours of a day on average — together or apart by line, in and out (with how many are inside: in minus out), direction, object or camera (line_counts). The counts are kept 400 days whatever the retention of the recordings: this month can be compared with the same month last year. The modules page of ViON shows each line's counts of the last 24 hours (lineTotals)

## [0.16.0]

- The assistant counts events over time for charts: per hour, day or week of a period up to 92 days, or added up into the hours of a day and the days of a week (as sums, or per day on average with the number of days each holds), how many began or how many minutes they lasted, together or apart by camera, label or a module's answer (event_stats). The series are named in the person's language and have a value per bucket: none for an hour still to come or for days a very busy period was not read to, never a zero. The hours of the day are those of the clock, also on the days it is changed. The read gives way to the recording between its pages
- attribute_time takes a month: «how long did he play this month» per day; over a week it gives each day's sums instead of every stretch, and it reads through any number of events: a day it could not reach is unknown, not a day without play

## [0.15.0]

- The assistant reads what trained modules answer ("играет в компьютер: да/нет"): it finds events by the answer, counts them in a day's summary and adds up how long a day the answer was "yes", with the pauses between (attribute_time). The time is approximate: a module answers only on the frames the detector looks at, so moments closer than 10 minutes are joined, unless the module said "no" twice or more for 3 minutes between them. Each camera has its own count (two children are not added up), and an event still going on since before midnight counts on the day asked
- The assistant's event search takes any object a module recognises, not only the built-in ones; a label no event had is said instead of finding nothing, a question by a part of it, and with a label and a question both must hold
- An event still going on is in a range that began after it: "today" showed nothing of the child at the computer since 23:30. An event the server lost (a crashed frame worker, an "end" that never came) is ended within 10 minutes at its last update, not at the next start of the recorder; one taken for lost that the server still sends goes on without the end written then

## [0.14.0]

- Other extensions can put an event of their own in the recordings, in their own words: VOICE adds «Сыночка за компьютером во время сна» with the reminders the child let pass. The event is recorded like a detection (a camera that records by events starts recording), closes by itself, is found by its words in the search and is left alone by the AI descriptions

## [0.13.1]

- With «Record audio» on, cameras whose sound and video come through go2rtc (Xiaomi) record again: ffmpeg copied their HEVC from RTSP without timestamps and stopped at once, so the main stream recorded nothing. The video is now copied from go2rtc's MPEG-TS and the sound added beside it; a camera that sends no sound is recorded from the MPEG-TS as without the setting

## [0.13.0]

- People who look alike can be searched for, together with ViON's people search and the ML plugins that bring Person Re-ID: the recorder keeps what a person's clothes and build look like for every person a camera with Person Re-ID saw, and finds the moments with people who look the same, starting from a recorded moment or a picture with somebody on it. Re-ID describes clothes and build, not who someone is, so the search keeps to a few days around the moment. Only the server's admins can search
- The data of the people search is kept 7 days by default (Settings → People search) and can be deleted in one go; it is deleted with its event, favourites included. The person vectors never reach the stored events or the interface
- The search by description on the recordings page finds older events too, together with ViON's paged search: the page looked for matches only among the events it had loaded, so a match older than the loaded pages was never shown. The recorder now applies the page's filters (cameras, time, score, favourites, the rest of the filter) and sends the matches page by page
- A link to an older episode opens it: the recorder answers for one episode by its id
- H.265 cameras whose stream go2rtc starts with an H.264 access unit delimiter (Xiaomi) are recorded: the recorder took the delimiter for the start of a picture and never saw a keyframe

## [0.12.2]

- Naming a face through the assistant counts a person seen twice in one event once: someone the camera lost and found again was offered as "2 faces: unknown, unknown". Faces with the same known name, or in the same group of unknown faces, are one person and all of them get the name; unknown faces nothing tells apart are still offered to choose from, with a word that they may be the same person
- The recording check of the assistant tells what a camera does now apart from the period asked about: a camera that recorded the whole day and is over the plan or paused only now was reported as recorded 100% and "not recorded" at once

## [0.12.1]

- A time without an offset the assistant names ("delete the recordings from 2 to 3") is the time of the person who asked, not of the server: on a server in UTC it deleted 5 to 6 in Moscow
- The disk forecast of the assistant counts the cameras that record on events, by what they wrote a day: it left them out and promised more days than the disk holds
- A manual recording asked through the assistant of a camera set to record all the time but over the plan or paused says so, instead of "it records all the time anyway"
- The list of faces through the assistant is an administrator's, as the Faces page is

## [0.12.0]

- The assistant answers about the recording itself, together with ViON's assistant update: whether cameras recorded through a period (the share recorded, the gaps longer than a minute and their cause when the recorder logged one) and how many days the disk holds at the current rate, or that the retention ends the archive first
- The assistant lists the known and unknown faces and, after a confirmation in the chat by an administrator, names a face of an event («this is Masha»), corrects a wrong name, ignores a group of unknown faces or forgets a person. The confirmation card shows the face
- The assistant starts and stops a manual recording and deletes the recordings of one camera in a range of up to 24 hours, both for administrators and after a confirmation. A range with favorite events is refused unless the user said favorites go too; the card says how much goes and that it cannot be undone

## [0.11.3]

- The hover preview of an event finds the event where it is recorded: an event recorded only from its middle, or from a camera that sends a keyframe rarely, showed "no preview"; the excerpt now starts where the recording of the event begins, at the next keyframe when the one before is further back than the excerpt is long

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
