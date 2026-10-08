## [1.3.0]

- The ViON assistant reads the presets of a PTZ camera, saves the current position as a preset or deletes one, and reboots an ONVIF camera that stopped answering; each change is confirmed in the chat and only an administrator can make it

## [1.2.8]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.2.7]

- Compatibility update for the current ViON version

## [1.2.6]

- A camera that was unreachable when ViON started now comes back on its own
- Compatibility update for the current ViON version

## [1.2.5]

- Compatibility update for the current ViON version

## [1.2.4]

- Compatibility update for the current ViON version

## [1.2.3]

- Moving to a PTZ preset works again. Most cameras store a preset under a different identifier than the name they show, and the plugin sent the name, so the camera answered that the preset does not exist
- Presets you add or rename in the camera's own app show up within a minute. Previously the list was read once at startup and a new preset needed a restart of the plugin

## [1.2.1]

- Compatibility update for the current ViON version

## [1.2.0]

- Short motion pulses from thingino cameras are no longer missed. These cameras report only the latest motion state each time they are asked, and the plugin used to pause between two requests in exactly the moment a one-second motion could start and end, so most triggers were lost. While there is activity, the plugin now asks without pauses
- Tapo cameras no longer flood the log with "other side closed" and no longer lose their event subscription every two minutes. Their firmware drops an event request it has not answered within about 10 seconds; when that happens, the plugin now switches to shorter requests that the camera answers in time
- Compatibility update for the current ViON version
- Requires ViON 2.0.23 or newer

## [1.1.11]

- Motion events from thingino cameras arrive reliably now. Their firmware (before 02/2026) sends a broken reply when asked which event types it supports, and the plugin gave up on events entirely instead of listening anyway

## [1.1.10]

- Cameras you have already added no longer reappear under "Discovered" after a while, sometimes twice with the same address. Some cameras report a new identity after a reboot; the search now recognizes them by their address instead of listing them again

## [1.1.9]

- Fewer unnecessary messages in the log

## [1.1.8]

- Cameras no longer become unresponsive after the connection dropped during operation. A failed event request ("other side closed" or an HTTP error with status 400) was repeated without a pause and flooded the camera until it stopped answering ONVIF requests altogether, including the camera search and PTZ. Failed requests are now repeated with growing pauses, and a broken connection no longer discards an event subscription that is still valid
- PTZ status requests no longer pile up while the camera does not respond; they pause with increasing delays until the camera answers again
- Fewer unnecessary messages in the log: a repeated event error is logged once instead of flooding the camera log, followed by a "recovered" line once events work again, and the list of camera capabilities on connect is now a short summary

## [1.1.7]

- Internal improvements

## [1.1.6]

- Leftover diagnostic messages removed from the log

## [1.1.5]

- Sensors now show their details in the sensor settings: event sensors list the camera event topics that feed them, the PTZ sensor shows the axes, the supported move commands and the presets found on the camera
- Bug fixes and improvements
- Compatibility update for the current ViON version

## [1.1.4]

- Compatibility update for the current ViON version

## [1.1.3]

- Device addresses entered without the protocol in front (`192.168.1.100` or `192.168.1.100:8080`) are accepted instead of failing with "Invalid URL"; when a saved address really is broken, the log now names that address

## [1.1.2]

- Motion and detection events now arrive from cameras that report an internal or wrong address for their event subscription. The plugin always uses the address and port you entered
- More detail about incoming ONVIF events in the log (event topic, recognized motion state, discarded events). Set the camera's log level to debug to follow how events arrive

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

- Initial release
