# VOICE

The voice of ViON: it speaks through the speaker of a camera and listens to its microphone. Speech is synthesized and recognized on your server; no sound leaves it.

## What it does

- **Screen time.** The camera sees a child at the computer and VOICE counts the time. When a break or bedtime comes, VOICE says so kindly and by name. If the child stays, it repeats more firmly, then tells the parents with a snapshot. The child may ask "how long is my break?" after a phrase of VOICE, or at any time by calling «ViON» ("ViON, how long is my break?", Russian for now), and hears the minutes left by the schedule.
- **Who is at the door.** A door camera sees a person and VOICE says in the rooms who came: "Dad has arrived", "There is a stranger at the door", or, with a model that sees pictures, "A courier with a box is at the door".
- **Say.** Any phrase through a camera speaker: from the assistant chat ("tell Artem dinner is ready"), from an automation, from another extension through a notification.

## The child cannot talk VOICE into anything

The assistant that answers the child has no access to the settings. Times and numbers in its answer must come from the schedule; an answer with anything else is replaced by a ready phrase. When the child asks for more time, VOICE passes the request on to the parents; only a parent can give more time.

## What you need

- A camera with a speaker and a talk channel in its stream. VOICE shows on every camera whether it can speak there and why not. Cameras without a speaker do not appear among the speakers.
- For phrases and answers written by the assistant: allow VOICE in Settings, Assistant. Without it VOICE uses ready phrases.
- The speech models are downloaded from the ViON models server the first time VOICE speaks or listens: about 60 MB per language for the voice, 21 MB for Russian recognition, 94 MB for English and German recognition.

## Setting up

Everything can be set up in the settings or in words in the assistant chat; both change the same settings.

**On the camera** (camera, Plugins tab, VOICE):

- Whether VOICE can speak through this camera.
- Screen time: one entry per child. The child's name and the zone of the computer, a break every so many minutes and for how long, a daily limit and the bedtime of school and weekend nights. Fields marked "More" are for special cases and can stay as they are.
- What is happening now, and the buttons "Give more time", "Say a phrase" and "Say a test phrase".

**On the page of the extension:** language and speed of speech, how long to wait for an answer, quiet hours, the rules "Who is at the door" and how to announce people, the speakers for notifications, the state of the assistant.

**In words:** for example "Artem plays at the computer in the kids room on the Xiaomi camera. A break every 45 minutes for 10, bed at 21:30 on weekdays and 22:30 at the weekend". The assistant shows a card with the values to confirm before anything changes.

## Automations

A camera with a speaker is a notification device "<camera> (VOICE)". Turn it on under "Speakers for notifications", then in an automation choose the action "Notification" and that speaker. VOICE says only notifications addressed to the speaker, never the others.

## Good to know

- The microphone opens only for a few seconds after a phrase of VOICE and closes; the sound is not kept. With "Answer when called" on for a child, the microphone of that camera stays open while the scenario works: each short phrase is recognized on the server to find «ViON», a phrase without it is dropped at once (after the name alone, the next phrase is taken as the question), nothing is recorded. What the child says on a call does not go to the assistant: a request for more time is found by its words. A word that only sounds like the name ("Leon" in a game) calls VOICE only together with a question about the time. The camera's status says when it listens. The text of the child's question goes to the assistant: if its model runs in the cloud, the text goes there.
- A camera says at most 6 phrases a minute (setting); more are not said.
- A child sitting still at the computer can stay out of detection events. VOICE reads the object sensor of the camera every 5 seconds, still people included.
