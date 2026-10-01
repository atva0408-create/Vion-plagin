## [1.2.14]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.2.13]

- Compatibility update for the current ViON version

## [1.2.12]

- **The model always reads the picture it was given.** The picture could be overwritten in memory before the model read it, so an object or a face could be missed or rated wrongly.

## [1.2.11]

**Requires ViON 2.2.5 or newer.** After the update, select this plugin as "Face Recognition" for each camera: camera settings, "Plugins", "Detections". Until then faces are detected but not named. The plugin downloads its new face models on the first start.
- **Face recognition is a sensor of its own and straightens the face before recognizing it.** It recognizes far more people, and a face seen from the side or steeply from above gets no name instead of a wrong one. The recognition model is set once for the plugin, and ViON processes the saved face pictures again by itself.
- Compatibility update for the current ViON version

## [1.2.10]

- Compatibility update for the current ViON version

## [1.2.9]

- Minor fixes

## [1.2.8]

- **License plates are read again.** Every reading was rated as unreadable and discarded before it became an event, whatever the camera saw. If you lowered the plate reading confidence in the camera settings to work around this, set it back.

## [1.2.6]

- Object detection follows the confidence values set per object type (person, vehicle, animal) in the camera settings

## [1.2.5]

- The confidence thresholds are no longer in the plugin settings. Object, face and license plate detection now use the values from the camera's detection settings, so they are set in one place and a change takes effect right away
- The plugin reports which model it loaded and which hardware it runs on, so ViON can show this in the camera metrics

## [1.2.3]

- Compatibility update for the current ViON version

## [1.2.2]

- **The recommended face detection model changed.** The "Default" option now stands for a stronger model: on test footage it finds a face in 82% of the frames where the previous one managed 30%, and it no longer mistakes the back of a head for a face. Your current selection stays untouched. New installations get it right away; on an existing one, choose "Default" in the model list or use "Reset settings". A face check then takes about twice the computing effort, and only runs when a person was seen.

## [1.2.1]

- **A "Reset settings" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "Default" choice in every model list.** It follows the recommended model for that task, so plugin updates can improve the choice automatically. Choosing a specific model still keeps that model. Existing setups keep their current selection.
- **Five new face detection models.** Small and medium models plus 640 px variants of each size (t, s, m). The 640 px models catch small and distant faces that the 320 px default misses, at a higher computing cost. The default model stays unchanged.

## [1.2.0]

- Fixed the "Download models again" button, which did nothing when pressed
- Compatibility update for the current ViON version
- Requires ViON 2.0.23 or newer

## [1.1.7]

- You can choose which Vulkan graphics card runs the detection. The new "Vulkan device" setting lists the graphics cards that were found, so on systems with several of them the detection can be tied to a specific card. "Auto" keeps the previous behavior.

## [1.1.6]

- No more repeated Vulkan error messages in the log on systems without Vulkan. The search for a graphics card is skipped when Vulkan is not installed, and the detection runs on the processor as before.
- Software-only Vulkan devices no longer count as graphics cards. The detection is slower on them than on the processor alone, so systems without a real graphics card stay on the processor.

## [1.1.5]

- Downloaded models are no longer included in backups
- Compatibility update for the current ViON version

## [1.1.4]

- Internal improvements

## [1.1.3]

- Compatibility update for the current ViON version

## [1.1.2]

- Bug fixes and improvements

## [1.1.1]

- A model that fails to load is now reported in the log instead of failing silently, and the next attempt loads it afresh
- When one model fails to load at the start, the remaining models are still loaded
- Compatibility update for the current ViON version

## [1.1.0]

- Compatibility update for the current ViON version

## [1.0.4]

- Compatibility update for the current ViON version

## [1.0.3]

- Bug fixes and improvements

## [1.0.2]

- Bug fixes and improvements

## [1.0.1]

- Bug fixes and improvements

## [1.0.0]

- First release
