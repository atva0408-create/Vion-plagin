# Eufy

Connects Eufy cameras, doorbells, HomeBases and sensors to ViON. You log in once with your Eufy account, and the devices of that account appear in ViON.

## What it does

- Live view over P2P, or over RTSP where the camera offers it, with two-way audio on cameras that have a speaker
- Motion, people, vehicles, pets, sounds, doorbell presses and the battery level arrive as sensors of the camera
- Spotlight, siren, pan and tilt and switching the camera on or off appear as controls, where the camera supports them
- Entry, motion, leak, smoke and CO sensors, locks and the guard mode and siren of a HomeBase can be added on the "Sensors" page
- Snapshots come from the latest Eufy notification without waking a battery camera
- Runs next to the Eufy app and other integrations on the same account

## What you need

- A Eufy account: its email, password and country
- Eufy may ask for a captcha or send a verification code; the settings then show a field for it. The login is saved, a restart does not ask again

## Settings

- **Email**, **Password**, **Country** and **Log In**: your Eufy account. **Log Out** ends the session and forgets the saved login
- **Stream Mode** (per camera, where RTSP is offered): P2P works for every camera; RTSP needs mains power, and a HomeBase serves only one camera over RTSP
- **Max Live Stream Duration**: battery cameras stop streaming after this many seconds
- **Ignore Devices**: serial numbers of Eufy devices that should not be offered
