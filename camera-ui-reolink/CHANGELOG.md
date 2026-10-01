## [1.2.27]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.2.26]

- Compatibility update for the current ViON version

## [1.2.25]

- Compatibility update for the current ViON version

## [1.2.24]

- Compatibility update for the current ViON version

## [1.2.23]

- A camera added by IP address no longer stays on the slow UID connection after a hiccup. If the direct connection failed once, the camera switched to its UID and kept using it for hours, with choppy video and dropped frames. When it reconnects, it now tries the direct connection again, at most every five minutes

## [1.2.22]

- Compatibility update for the current ViON version

## [1.2.21]

- Switching a camera between H.264 and H.265 no longer crashes the plugin. The stream now adapts to the new video format while it is running

## [1.2.20]

- Minor bug fixes

## [1.2.19]

- Compatibility update for the current ViON version

## [1.2.18]

- Compatibility update for the current ViON version

## [1.2.17]

- Compatibility update for the current ViON version

## [1.2.16]

- Adding a battery camera that is slow to wake up no longer fails halfway. Adding allowed exactly as much time as the wake-up needs, so it could give up a moment before the camera answered

## [1.2.15]

- Cameras that run on battery only can now be added by IP address alone. The fallback to the UID connection needed the UID to be known, which it is not when a camera is typed in by hand; the camera is now asked for its UID the same way the Reolink app does it, and the answer is saved with the camera
- Waking a sleeping camera gets the time it needs. A battery camera answers only after about ten seconds of attempts, and the connection attempt gave up just before that

## [1.2.14]

- Cameras that run on battery only can be added again. A sleeping camera does not accept direct connections, so adding one failed with "connection refused" even though the Reolink app reached it. The plugin now falls back to the camera's UID connection

## [1.2.13]

- Battery cameras and doorbells no longer lose their charge within a day. The plugin kept a connection to the camera open around the clock, which is what stops a battery model from sleeping. It now gives the camera an address to report to and lets the connection go; motion, doorbell presses and the battery level arrive on their own. Cameras whose firmware cannot report this way say so in the log and keep the old behavior
- The connection to a battery camera is only dropped once the camera has actually reached ViON with a report of its own. If it cannot, the connection stays up and the log says so, so a camera in an unusual network setup never ends up silent
- New camera setting "Permanently Powered" for battery models. A doorbell wired to its bell transformer has no reason to sleep, so it keeps a connection like a mains camera and reacts faster. It takes effect right away
- A camera you disabled is now really disabled. Disabling only stopped recording and streaming, while the plugin stayed logged in to the camera and kept asking it for events. Enabling and disabling takes effect right away

## [1.2.12]

- Compatibility update for the current ViON version

## [1.2.11]

- Compatibility update for the current ViON version

## [1.2.10]

- Bug fixes and improvements

## [1.2.9]

- Motion and AI detections from cameras whose firmware packs the events differently are recognized again. Some models wrap them in a list the plugin did not know, and every detection from those cameras was lost
- A camera that reports its detections for a different channel than the one it was added as now says so in the log instead of looking like a camera that never detects anything

## [1.2.8]

- PTZ cameras show their saved positions. The presets you set up in the Reolink app appear in the PTZ controls and moving to one is a click; the list is read again every minute, so renamed or newly added presets show up on their own
- Cameras no longer show up as offline over a shaky network. A busy camera answers the connection check late because its reply waits behind the video, and that was counted as a dead camera. Video arriving on the connection now counts as proof that the camera is there, and a camera gets 30 seconds to come back before it is reported offline
- One stuttering stream no longer drops the whole camera. A stream that goes quiet is restarted on its own, events and the other streams keep running
- A camera that cannot deliver its video in time no longer leaves the live view stuck seconds in the past. The stream skips the old pictures and continues at the next full frame, so the live view stays live. The new camera setting "Catch Up To Live" sets how many seconds the picture may trail before that happens and takes effect right away; skipped seconds are missing from recordings too, so set it to 0 to keep every frame and accept the delay

## [1.2.7]

- Live streams run close to real time now. Every stream used to be held back for a fixed time before it left the plugin; that delay is gone and pictures are passed on the moment the camera sends them
- A hiccup in the camera's clock no longer causes a frozen picture or a jump; the stream keeps its steady pace and audio stays in sync
- Dual-lens cameras (TrackMix, RLC-81MA) can stream their tele lens. Add the camera and the tele lens appears in the list of discovered cameras as its own camera, with username and password prefilled

## [1.2.5]

- No more corrupted video pictures when the system is briefly overloaded. A lost piece of the camera stream was patched over with wrong data and could show up as picture glitches; the stream now restarts cleanly instead
- When the system cannot keep up with the video under load, the picture now pauses briefly and resumes at the next full frame instead of dropping random frames that left every viewer with a broken image. Audio keeps running through the pause

## [1.2.4]

- The plugin keeps listening for events for as long as the connection lasts. Listening used to be stopped and set up again every five minutes, and a detection that fell into that moment was lost

## [1.2.3]

- Cameras on an NVR or Home Hub get their events again. The request for events was sent for the wrong channel, so the camera accepted it and then never reported motion or AI detections
- A camera that stays silent after that request is now asked again every 30 seconds instead of every 5 minutes, and the log says so if it never answers

## [1.2.2]

- Doorbells report a lingering visitor again. Some models describe the zone without saying what they saw, and those events were dropped instead of counting as motion

## [1.2.1]

- Compatibility update for the current ViON version

## [1.2.0]

- Compatibility update for the current ViON version
- Requires ViON 2.0.23 or newer

## [1.1.5]

- WiFi cameras no longer go missing when you search for cameras. Some models ignore the search for the first ten seconds, so they showed up only every other try. The plugin now keeps looking in the background, and a search finishes in two seconds instead of ten
- Sound and picture now share one clock. The camera sends its audio without any timing information, and the plugin started the audio clock from zero instead of from the picture, which is why audio and video could not be lined up in recordings
- Two-way audio works again. The camera stayed silent because your voice arrived on a second connection that the plugin discarded; both connections now reach the camera
- The spotlight switch now follows the camera. When the camera turns its own light on, or you switch it in the Reolink app, ViON shows it instead of staying on the last state it set itself
- Cameras that listen for a baby crying now get their own audio detection sensor, instead of the sound showing up as if it had been seen in the picture. The sensor appears the first time the camera actually reports one

## [1.1.4]

- New cameras now get "Preload" turned on for every stream and "Hot mode" for the main and sub stream, so the live view opens without the long wait
- Streams are only started when someone actually watches; the connection to the camera stays open for events and snapshots
- Bug fixes and improvements

**Please check your existing cameras.** Cameras added before this update keep their old settings. Open the camera, go to "Sources" and turn on "Hot mode" and "Preload" for the main and sub stream. On battery cameras leave "Hot mode" off, it would keep the camera awake and drain the battery

## [1.1.3]

- Bug fixes and improvements

## [1.1.2]

- NVRs and Home Hubs are recognized correctly when you add them. On devices that use AES encryption the reply to the login was read wrong, so an NVR was treated like a single camera instead of listing its channels
- Detections from both lenses of dual-lens cameras (TrackMix, RLC-81MA) are now recognized
- Zone-based smart detections (line crossing, intrusion, loitering) now trigger motion and object events; before, cameras set up with only smart zones stayed silent

## [1.1.1]

- Compatibility update for the current ViON version

## [1.1.0]

- NVR and Home Hub support: adding an NVR lists every occupied channel as its own camera, finds out for each channel what it can do (AI detection, siren, spotlight, PTZ) and remembers the username and password, which are prefilled and survive restarts
- New action "Forget NVR" in the plugin settings for removing a connected NVR and its channel entries
- Fixed "bad credentials" when connecting to NVRs (for example RLN36): the plugin now addresses the NVR and its channels the way the official Reolink apps do
- Fixed the choice of encryption: the plugin now uses the kind of encryption the device's firmware agrees to instead of always switching to AES after login
- The camera search now only lists devices the current search actually sees; channels of an NVR are listed while their NVR is present, cameras added by hand are exempt

## [1.0.3]

- Internal improvements

## [1.0.2]

- Compatibility update for the current ViON version

## [1.0.1]

- Compatibility update for the current ViON version

## [1.0.0]

- Initial release
