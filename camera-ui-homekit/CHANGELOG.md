## [1.3.4]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.3.3]

- Compatibility update for the current ViON version

## [1.3.2]

- **Remote live view stays clean.** Video was sent in pieces larger than the Home app asked for, so the picture got more and more corrupted when watching away from home
- The bridge no longer warns that no server address is set when an address is set but does not exist on this machine. The warning now names the ignored address and the addresses the plugin does find

## [1.3.1]

- **A camera that changes its video format is picked up again.** Switching the main stream of a camera from H.264 to H.265 while ViON was running left HomeKit recording an H.265 stream labelled as H.264, which Apple discarded shortly after the start. The accessory now follows the change
- **Clean audio in local live view on iOS 27.** HEVC cameras using the new Secure Video could sound distorted when watched at home. The sound is now sent the way Apple expects there; remote view was not affected

## [1.3.0]

- **HomeKit Secure Video for iOS 27.** Cameras with an HEVC (H.265) main stream use Apple's new secure video services: live view at home and away, recording and two-way audio run on the original HEVC stream of the camera without converting it, so a 4K camera no longer takes up a processor core each. Needs iOS 27 / tvOS 27 on the viewing device and on the home hub. Remote view is HEVC only on the Apple side, H.264 cameras stay on the classic path
- **Force legacy path.** A switch per camera in the advanced settings keeps a camera on the classic HomeKit services, for homes that stay on iOS 26 or older
- A failed start no longer loses the pairing of a camera. Before, an error while the camera was announced at startup removed the accessory together with its pairing, so the camera had to be added to Home again

## [1.2.11]

- Compatibility update for the current ViON version

## [1.2.10]

- Bug fixes and improvements

## [1.2.9]

- Bug fixes and improvements

## [1.2.8]

- When a live view ends, one line in the log reports what the Apple device measured about the connection: lost packets, jitter, round trip time and requests for a full picture. If the device sent no reports, the line says so
- Minor bug fixes and improvements

## [1.2.7]

- Compatibility update for the current ViON version

## [1.2.5]

- Compatibility update for the current ViON version

## [1.2.4]

- An outdated network address no longer stops the bridge. When ViON is set to an address the machine does not have any more (changed IP address, old configuration), the bridge and the cameras skip that address with a warning and stay reachable on the remaining ones, instead of failing to start

## [1.2.3]

- New sensor types reach HomeKit. Carbon monoxide, carbon dioxide (level plus an alarm above 1500 ppm), illuminance and vibration sensors now appear in the Home app; vibration shows up as a motion sensor because HomeKit has no vibration category. Gas, heat, cold, tamper, problem and power sensors stay in ViON only, HomeKit has no matching accessory type

## [1.2.2]

- Minor bug fixes and improvements

## [1.2.1]

- The bridge is found by the Home app again. It announced itself under a name the network could not handle, so Home never saw it and pairing by QR code ran into a timeout. The bridge was renamed
- The bridge now starts even when no sensor is exposed yet. QR code, PIN and port are there from the first start, so you can pair the bridge in advance, and sensors you expose later show up in the Home app right away

## [1.2.0]

- New bridge for standalone sensors. Contact, occupancy, smoke, leak, temperature, humidity, lock, garage door, switch and security system sensors, plus standalone lights and sirens, come across behind a single bridge. Pair it once and every sensor you expose later joins automatically. QR code, PIN, port and a reset button are in the plugin settings
- Cameras in the Home app now carry the hardware of the camera: spotlight, siren and battery show up on the camera itself, alongside motion and doorbell
- The "Expose sensor" switch on the Sensors page decides what reaches HomeKit. Turning it off removes the sensor, turning it on brings it back
- Compatibility update for the current ViON version
- Requires ViON 2.0.23 or newer

## [1.1.7]

- New camera setting to turn hardware acceleration off

## [1.1.6]

- Disabled and offline cameras stay in HomeKit and show a placeholder picture instead of disappearing. Snapshots and live view show "privacy mode" for disabled cameras, "offline" for disconnected ones, and a substitute picture when no snapshot is available
- HomeKit Secure Video recording and live view clean up reliably after retries, reconnects and failed starts. Systems that run for a long time no longer use more and more processor and memory when a camera keeps dropping out

## [1.1.5]

- Bug fixes and improvements

## [1.1.4]

- Bug fixes and improvements

## [1.1.3]

- Compatibility update for the current ViON version

## [1.1.2]

- Bug fixes and improvements

## [1.1.1]

- Bug fixes and improvements

## [1.1.0]

- Compatibility update for the current ViON version

## [1.0.3]

- Compatibility update for the current ViON version

## [1.0.2]

- Bug fixes and improvements

## [1.0.1]

- Bug fixes and improvements

## [1.0.0]

- First release
