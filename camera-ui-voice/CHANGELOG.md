## [0.5.0]

- VOICE keeps a journal of every day: when the child sat down and got up, the breaks between, the reminders and the ones the child went on after or that reached the parents. The assistant (and Alice through it) answers for any of the last 30 days how long the child played, how many times and how long they rested, and when and how often they broke the rules (voice_report). Days before this version have the minutes only
- The journal tells what VOICE did not see: while the camera was offline, the scenario off or VOICE down, the time is "not watched", not "did not play", and a session ends where the child was last seen (a session across two days off was kept as 2930 minutes). A reminder VOICE could not say is not one the child let pass, and the parents count as told only when the notice went. A break counts as whole as the rule took it (rest added up over absences)
- A pause in the looks (the scenario off, VOICE or the server down) no longer goes on with the session and its minute: it is handled as a camera gone blind

## [0.4.0]

- When the child keeps on after three reminders, the parents' notice opens an event in the camera's recordings («Сыночка за компьютером во время сна», the reminders let pass, from the first one) with its video. Needs ViON NVR 0.14.0; without it the notice goes as before
- The notice goes for sure once VOICE told the child «I told your parents», even if the child steps away a moment later; every notice is in the log, sent or not and why
- Bedtime and the daily limit no longer start their reminders over when the child is out of sight for less than 15 minutes (a classifier saying "no" for two minutes did that, and the third step that tells the parents never came)

## [0.3.0]

- Calling VOICE by name: with "Answer when called" on for a child, the child says «ВиОН» and a question («ВиОН, сколько мне ещё отдыхать?») at any time and VOICE answers. The camera's microphone stays open for it; speech is recognized on the server and nothing is kept, and what the child says on a call does not go to the assistant. A word that only sounds like the name ("Leon" in a game) calls only with a question about the time. With several children at the camera, each one at the computer is answered. Russian only for now; off by default
- Answers in minutes: "5 minutes of the break left", "you can play: 20 minutes until the break", "less than a minute"; back early, the same minutes as the reminder; a break due at the computer is the whole break; the next morning is still a time ("tomorrow at 07:30")
- A break is added up: back early and away again, the child takes only the rest of it; the reminder, the status and the answer name what is left
- Fixed: after the daily limit VOICE said "you can play tomorrow at 03:00" in Moscow (midnight UTC) instead of 00:00

## [0.2.1]

- Cancel pending phrases, reminders and listening when a camera is released, a scenario is disabled, a parent grants time or VOICE shuts down. Late assistant/model responses cannot reopen the camera.
- Pace RTP after long timer stalls; stop failed or half-open talk channels and bound the pending phrase queue.
- Catch speech activity and assistant errors; validate literal phrases, time grants and saved state. Keep the end time of a partial break consistent across reminders and answers.

## [0.2.0]

- With the intercom installed: a ring at a panel is announced on the speakers for notifications ("Ring: Gate"), through the queue, the limits and the quiet hours of VOICE
- The cameras of the intercom's panels are no longer VOICE's speakers: the door agent speaks there

## [0.1.1]

- The speech engine, the speaker, listening and the model downloads now live in the shared package `packages/vion-speech`, which the intercom uses too. Nothing changes in what VOICE does

## [0.1.0]

- First version: screen time with breaks, a daily limit and bedtime, answers to the child's questions, "who is at the door", phrases from the chat, automations and notifications. Speech synthesized and recognized on the server. Set up on the camera, on the extension page or in words in the assistant chat
