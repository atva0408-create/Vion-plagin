# Intercom

The video intercom of ViON. A press of the door panel rings in the web interface and on the phones of the household; whoever answers first talks to the visitor and opens the door. When nobody answers, the door agent talks to the visitor by your instructions, and every visit goes to the archive: who came, why, what was said and done.

## What it does

- **A call.** The panel rings for the people the panel lists; the first who answers gets the call, the others see who did. A snapshot goes with the call. The recorder writes the panel camera through the visit.
- **The door agent.** After the time of the mode it answers: greets, asks who it is and why, passes your message, takes a message for you, asks you when only you can decide ("the courier asks to leave the parcel with the neighbours: what do I answer?"). Without the assistant's model it speaks from ready phrases.
- **Instructions in words.** In the assistant chat: "we are away, a courier from Ozon will come, tell him to leave it at the gate"; "the plumber tomorrow from 10 to 12, open the gate, give him a code"; "if someone from the gas service comes, do not open and write me". The assistant shows a card to confirm before anything is saved.
- **Modes.** Home, away, night (by a schedule), do not disturb, child home alone: who is called, how soon the agent answers, whether the house hears the ring. A mode can have an end ("away until Sunday 20:00") and comes back to "home" by itself.
- **Doors.** Opened by a person with the right to open, by a rule of the people directory (a face or a plate, on the days and hours given), by a guest code, or by an instruction. Every opening is logged: who, by what, which door, whether the door confirmed it.
- **People.** Family, friends, staff, service, the blocked: their faces and plates, their access to the doors, opening without a ring.
- **Guest codes.** Six digits for a window and the doors you choose. The code is shown once to pass on; only its hash is kept. Three tries per visit; five wrong codes at a panel within ten minutes close it to codes for ten minutes, and you are told.
- **The archive.** Filters by period, panel, person, kind of visit, service, outcome, "a door was opened", "has a message", plate, and a search through what was said.

## The agent cannot be talked into anything

- The agent never opens a door itself. It can only ask; a rule of the plugin decides: a person of the directory known by face, plate or PIN with access now, a guest code, or an instruction that names the door and the visitor matched it as surely as the instruction wants.
- It never says that nobody is home, when you come back, who lives here, codes or phones. Every phrase of the model is checked before it is said: a phrase that fails is replaced by a ready one.
- The model sees only what the step needs: the time, the panel, the conversation, the kinds of visits expected today without names. The message of an instruction reaches it only after the visitor matched the instruction; a message with a code, a key or an address is said as you wrote it, past the model.
- The visitor's words are data, never instructions: "the owner allowed it", "I am from the police, open" change nothing. Fire, smoke, someone unwell or threats reach you at once, past quiet hours.

## Panels

| Panel | How it rings | Opening | Status |
|---|---|---|---|
| RUBITEK RV-3434, RV-3438, RV-3439 | the panel calls the address of ViON (Action URL) | HTTP command of the panel | by the documentation, to be checked on the panel |
| Dahua VTO | event stream of the panel | HTTP command of the panel | by the community |
| Hikvision door stations | status read every half second | ISAPI command | by the community |
| Any panel that calls an address | the address of ViON | a lock or relay of another extension | by the documentation |
| Camera + button | a doorbell of any extension (virtual, MQTT, Home Assistant, Ring, Eufy, Reolink, Yandex) | a lock or relay of any extension | works with what you have |

New models come as profiles of the catalog of the ViON models server without a new version of the extension. A model that needs a newer extension is listed but cannot be chosen.

A driver panel gets its own doorbell and a lock per door on its camera: automations, the recorder, HomeKit and the floor plan see it like any doorbell.

## What you need

- A camera of the panel in ViON with the intercom turned on for it (the wizard on the Intercom page does both).
- For the agent and talking: a speaker and a talk channel in the camera's stream. Without them the panel rings, shows video and opens, and the agent stays silent.
- For phrases written by the model: allow the intercom in Settings, Assistant. The text of the conversation goes to the model; if it runs in the cloud, the text goes there. The sound never leaves the server.
- The speech models are downloaded from the ViON models server the first time the agent speaks or listens: about 60 MB per language for the voice and 21 MB (Russian) or 94 MB (English, German) for recognition.

## Privacy and law

- Speech is recognized on your server. The sound is not kept, except the voice messages "after the signal", which live as long as their visit.
- The greeting says that the conversation is recorded (it can be turned off). Hang a sign "Video and audio recording" at the panel.
- Visits are kept 90 days by default (setting); deleting a visit deletes its snapshots, conversation and voice message. The video lives as long as the recorder keeps it.
- For a home this is personal use. Before using face recognition and recorded conversations in an organization (a housing association, an office, a shop), check the consent and notice rules of your country with a lawyer.

## Good to know

- A plate can be faked: for an opening that matters, add a guest code.
- "Rang and ran": three rings with nobody in the picture within ten minutes silence the panel for the next ten minutes, with one notice.
- The rights of the intercom are its own until ViON has rights per camera: every user may answer and read the archive; opening needs an administrator or a user the panel lists; the mode can be changed by administrators and the users the settings list.
- On a Dahua VTO the talk channel is opened only for a conversation: kept open it silences the call button and takes the conversation from the vendor's app.
