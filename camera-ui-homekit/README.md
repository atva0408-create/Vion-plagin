# HomeKit

Shows your ViON cameras and sensors in Apple's Home app.

## What it does

- Each camera becomes its own accessory in the Home app, with live view, HomeKit Secure Video recording and two-way audio.
- Cameras with an H.265 (HEVC) main stream use the new Secure Video of iOS 27 without converting the video, so even 4K cameras put little load on the server. H.264 cameras work the classic way.
- Motion, doorbell, spotlight, siren and battery of a camera show up on the camera itself.
- Sensors without a camera arrive behind one bridge: contact, occupancy, smoke, leak, temperature, humidity, carbon monoxide, carbon dioxide, light level and vibration sensors, locks, garage doors, switches, security systems, lights and sirens. Pair the bridge once; sensors added later join by themselves.
- Disabled and offline cameras stay in the Home app and show a placeholder picture.

## What you need

- For the new Secure Video: iOS 27 or tvOS 27 on the viewing devices and on the home hub.
- For sensors: "Expose sensor" turned on for each sensor on the Sensors page.

## Settings

- "QR Code" and "PIN": scan or type them in the Home app to pair. Every camera has its own; those of the bridge are in the plugin settings.
- "Reset Pairing": unpairs and creates a new pairing code.
- "Force legacy path": keeps a camera on the classic HomeKit services, for homes that stay on iOS 26 or older.
- "Use Hardware Acceleration": turn it off for a camera whose video is unstable.
