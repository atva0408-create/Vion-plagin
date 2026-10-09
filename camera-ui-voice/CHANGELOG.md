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
