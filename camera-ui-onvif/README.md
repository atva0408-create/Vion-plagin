# Onvif

Connects cameras that support the ONVIF standard to ViON. The plugin finds them in your network, adds their video streams and passes on the events and the PTZ control that the camera itself offers.

## What it does

- Finds ONVIF cameras in the local network and lists them as discovered cameras
- Adds the camera with its video streams in high, medium and low quality and its snapshot, as far as the camera offers them
- Controls PTZ cameras: pan, tilt, zoom and the presets saved on the camera; presets added or renamed in the camera's own app appear within a minute
- Passes on what the camera detects itself: motion, people, vehicles and animals, sounds and faces
- Reconnects on its own when a camera was unreachable

## What you need

- A camera that supports ONVIF and can be reached from the ViON server over the network
- The username and password of the camera's ONVIF account
- Events and PTZ only appear when the camera itself supports them

## Settings

- **Username** and **Password**: the camera's ONVIF account. They are asked for when you add the camera
- **URL**: the address of the camera. Change it when the camera gets a new address
- **Reconnect**: sets up the connection to the camera again
- The sensor settings show for information which **Event Topics** of the camera feed a sensor, and for PTZ the **Axes**, **Move Support** and **Presets** of the camera
