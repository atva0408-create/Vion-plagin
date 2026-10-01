# Reolink

Connects Reolink cameras, doorbells, NVRs and Home Hubs to ViON over the protocol the Reolink app itself uses. Works with all Reolink models, including battery cameras and models without RTSP or ONVIF.

## What it does

- Finds Reolink devices in the local network; others can be added by hand by IP address or UID
- Live view close to real time, with two-way audio
- Motion, recognized objects, a crying baby, doorbell presses and the battery level arrive as sensors
- Siren, spotlight and PTZ with the positions saved in the Reolink app, where the camera has them
- Each channel of an NVR or Home Hub and the tele lens of a dual-lens camera become separate cameras
- Battery cameras sleep between events, so the battery lasts

## What you need

- Username and password of the camera's local account, as set in the Reolink app
- The camera must be reachable from the ViON server by IP address (port 9000) or, in the same network segment, by UID
- Battery cameras must be able to reach the ViON server on the "Event Webhook Port"

## Settings

- **Camera Name**, **IP Address**, **UID**, **Add Camera**: add a camera by hand; it then appears among the discovered cameras
- **Catch Up To Live (seconds)**: how far the picture may fall behind before old pictures are skipped; 0 keeps everything
- **Permanently Powered**: for battery models with a permanent power supply, such as a doorbell on its bell transformer; the camera reacts faster, but a battery would be empty within a day
