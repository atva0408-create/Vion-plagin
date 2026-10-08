## [1.1.0]

### Added

- **The ViON assistant** lists the entities of Home Assistant with their area and state and runs a scene, a script or an automation, switches a light or a switch, moves a cover or sets the climate ("turn on the evening scene"). Each call is confirmed in the chat and is for administrators only. Other domains (locks, the alarm panel, Home Assistant itself) stay closed unless added in the new setting Assistant Domains.

## [1.0.18]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.0.17]

- Compatibility update for the current ViON version

## [1.0.16]

- **Home Assistant entities show up for adding again.** A single device with numbers in its identifiers, or an entity whose name was just a number, made the whole search fail.

## [1.0.15]

- Compatibility update for the current ViON version

## [1.0.14]

- Compatibility update for the current ViON version

## [1.0.13]

- **Tapping a notification opens the event.** The Home Assistant app jumps to the ViON panel, straight to the camera's timeline at the moment of the detection. Needs the ViON integration for Home Assistant with its sidebar panel; without it the tap still only opens the app.

## [1.0.12]

**Requires ViON 2.1.13 or newer.**

- **Added entities stay added across restarts of the plugin and of ViON.** ViON keeps the list now, so the plugin cannot lose it any more.
- **Renaming an entity in Home Assistant keeps the sensor**, with its camera assignments, automations and history.
- **Entities you delete in Home Assistant are marked as removed in ViON.** They stay, with everything assigned to them, until you delete them on the Sensors page too.
- **Notification pictures show up on the phone.** Without remote access the picture could only be loaded inside the home network, so Home Assistant notifications usually arrived without an image. Pictures now load through Home Assistant itself. Needs the ViON integration for Home Assistant 0.4.0.
- **One push per phone.** The plugin offered Home Assistant's catch-all notify service, the phone's own service and the phone's notify entity as three separate targets, so a notification arrived up to three times. Only real device targets are listed now. Follow-up pushes of the same event replace the notification instead of stacking, and silent updates stay silent.
- Once after this update: entities added with version 1.0.11 show up as discovered again and their old entries are marked as removed. Delete the old entries and add the entities once more.

## [1.0.11]

- Entities are imported by choice now. Instead of importing every entity it understands, the plugin lists them in the Discovered section of the Sensors page, with name, type and room. You pick what comes over, and deleting a sensor there stops its import for good. This also applies to entities imported by earlier versions: after the update they all show up as discovered again, so pick the ones you actually use. Their old entries are cleaned up automatically, so an entity you add again starts fresh, without its earlier camera assignments. Requires ViON 2.1.11 or newer.

## [1.0.10]

- Compatibility update for the current ViON version

## [1.0.8]

- The log message about imported entities now appears only at startup and when entities were actually added or removed, instead of repeating every few minutes
- Compatibility update for the current ViON version

## [1.0.7]

- **Fixed the connection inside the Home Assistant add-on.** The add-on lacked the permission to access Home Assistant, so the automatic connection was always rejected with the message "rejected the access token". Update the ViON add-on to 0.1.7, and the connection works without any configuration again.
- **A manually entered URL and token now take priority over the add-on connection.** Before, the automatic connection of the add-on always came first, so entering your own details had no effect.
- Compatibility update for the current ViON version

## [1.0.6]

- **Notify entities work as notification targets.** Notify entities of Home Assistant now show up under Settings > Notifications. A target that could never deliver, because sending to it always failed with an error, no longer appears. These targets carry title and text only; Home Assistant does not accept a picture there.

## [1.0.5]

**Requires ViON 2.1.3 or newer. If you use the ViON integration in Home Assistant, update it as well.**

- **Imported sensors no longer flood Home Assistant with ViON devices.** Imported sensors are no longer passed on to other systems by default and are marked with where they came from, so the ViON integration and the MQTT connection never send them back to Home Assistant, even if you pass them on to other systems such as HomeKit. Existing imports are marked at the next start of the plugin; reload the ViON integration in Home Assistant once to remove the surplus devices.

## [1.0.4]

- **Fixed an import loop with the MQTT connection of ViON.** Sensors that ViON passed on to Home Assistant could be imported right back, creating endless duplicates. New entities are now picked up only after a check that recognises the sensors ViON itself passed on, and when that check cannot run, the import pauses instead of continuing unchecked.

## [1.0.3]

- Bug fixes

## [1.0.2]

- **Home Assistant notify services deliver ViON notifications.** Under Settings > Notifications the plugin now offers every notify service Home Assistant knows (companion app, text-to-speech, Telegram and others) as a target. Pick a service, and ViON alerts arrive on that channel with title, text and picture.

## [1.0.1]

- Minor fixes and improvements

## [1.0.0]

- First release
