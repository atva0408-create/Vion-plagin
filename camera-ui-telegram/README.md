# Telegram

Sends VION notifications to Telegram chats through your own bot: the picture and words of an event, the notices of zone rules, everything a phone gets.

## What it does

- Each VION user connects their own chat (or a group) with a one-time link; the chat gets that user's notifications.
- Quiet hours, mute and the cameras a user may see apply as they do for a phone.
- A notification with a picture arrives as the picture with its words; silent notifications arrive without sound.
- A chat that blocks the bot is switched off; `/stop` in the chat turns it off.
- The bot reads its messages by itself: nothing has to reach VION from the internet.

## Setting up

1. In Telegram open @BotFather, send `/newbot` and follow it. Copy the token it gives.
2. Paste the token in the plugin settings, «Bot token».
3. Each user: VION → Settings → Notifications → «Connect Telegram», open the link and press Start.

## Settings

- **Bot token** — from @BotFather.
- **Bot API address** — empty for api.telegram.org; a self-hosted Bot API server or a proxy, for example where Telegram is blocked.
- **VION address for the button** — when set, a message has a button that opens the moment in VION.
