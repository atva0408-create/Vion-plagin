# NIKA

Links VION with NIKA, the voice assistant of the home. NIKA says what VION has to tell, for example that a child did not leave the computer for the break, and a parent can tell her «give him one more hour».

## What it does

- Finds every NIKA on the home network by itself. To connect one, NIKA says a code of 6 digits aloud and you enter it in VION. After that they find each other again when an address changes or a device restarts.
- NIKA says VION notifications aloud, as a station does: the notices of the screen time of VOICE, zone rules, events. Which notifications go to her is set in Settings → Notifications, as for any device.
- NIKA can ask VION about the screen time («сколько он сегодня играл», «когда перерыв») and give more time when an adult tells her: N more minutes, skipping the next break, or «можно до 23:00».
- Time is given only with a parent's permission. A voice proves nothing about who speaks. NIKA asks, the parents get a notification and answer on this page or in the chat of the assistant, and NIKA tells the room what came of it. A request not answered in 10 minutes is refused. If you choose, the time can be given at once, and the parents are told what was given.
- The journal on this page keeps what NIKA was asked to give and what came of it.
- The assistant of VION can do the same in words: connect or disconnect NIKA, change the settings, answer a request, make NIKA say a phrase.

## Setting up

1. NIKA and VION must be in the same home network. If VION runs in a container, it needs the network of its host.
2. Plugins → NIKA → «Connect NIKA». Choose her from the list, or give her address if she is not found.
3. NIKA says a code aloud. Enter it within 5 minutes.
4. To check, use «Say a phrase on NIKA».

Screen time needs the VOICE extension with a screen-time scenario of the child.

## Settings

- **Permissions asked by voice**: a parent confirms (the default), or the time is given at once and the parents are told.
- **What NIKA may ask VION**: the commands NIKA learns when she connects. An unchecked one she cannot ask for.
- **Requests waiting for a parent**, **Answer a request**: what NIKA asked for and the answer to it.
- **Journal**: the last requests and what came of them.
- **Disconnect NIKA**: VION and NIKA forget each other.

## How the link is protected

The code NIKA says aloud shows that the VION being connected belongs to the person standing next to her. After that, each side proves on every connection that it holds the key, without sending the key itself. A device that only claims to be NIKA is refused. Every message is signed, so nothing on the way can change, repeat or add one. The messages are not encrypted: in the home network they can be read, but not changed.
