## [1.2.20]

- Detector modules from the ViON store: a module installed on the Modules tab of the store appears among the object models of this plugin and is used like them; an updated module is loaded again

## [1.2.19]

- Object detection gets frames of the size the chosen model expects: it was given 320×320 whatever the model, and switching the model could stop and start the detector twice

## [1.2.18]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.2.17]

- Compatibility update for the current ViON version

## [1.2.16]

- Requires ViON 2.2.5 or newer
- **After the update, select this plugin as "Face Recognition" for each camera** (camera settings, "Plugins", "Detections"). Until then faces are detected but not named. The plugin downloads its new face models on the first start.
- **Face recognition is now a sensor of its own and straightens the face before recognizing it.** It recognizes far more people, and a face seen from the side or steeply from above gets no name instead of a wrong one. The recognition model is set once for the whole plugin; ViON processes the saved pictures of people again by itself.
- Compatibility update for the current ViON version

## [1.2.15]

- Compatibility update for the current ViON version

## [1.2.14]

- Minor fixes

## [1.2.13]

- **License plates are read again.** Every reading was rated as unreadable and discarded before it reached an event, whatever the camera saw. If you lowered the reading confidence in the camera settings to work around this, set it back.

## [1.2.11]

- The CLIP model for the semantic search is now a single plugin setting instead of a choice per camera
- Object detection follows the confidence values per type (person, vehicle, animal) from the camera settings

## [1.2.10]

- The confidence thresholds have been removed from the plugin settings. Object, face and license plate detection now use the values from the camera's detection settings, so they are set in one place and a change takes effect right away.
- The plugin reports which model it has loaded and which device it runs on, so ViON can show this in the camera metrics

## [1.2.8]

- Compatibility update for the current ViON version

## [1.2.7]

- **The recommended face detection model has changed.** Behind the "Default" option there is now a stronger model: on test footage it finds a face in 82% of the frames where the previous one managed 30%, and it no longer mistakes the back of a head for a face. Your current selection stays untouched. New installations get it right away; on an existing one, choose "Default" in the model list or use "Reset settings". A face check then takes about twice the computing effort and only runs when a person was seen.

## [1.2.6]

- **A "Reset settings" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "Default" choice in every model list.** It follows the recommended model for the task, so plugin updates can improve the choice automatically. Selecting a specific model still fixes it. Existing setups keep their current selection.
- **Five new face detection models.** Small and medium sizes plus 640 px variants of every size (t, s, m). The 640 px models catch small and distant faces that the 320 px default misses, at a higher computing cost. The default model stays unchanged.

## [1.2.5]

- When the GPU refuses a model even with this plugin, the log no longer recommends this very plugin as the way out

## [1.2.4]

- Initial release. The same functions as the OpenVino plugin, but on the older OpenVINO 2024.6 for Intel graphics up to 10th gen Core. On those chips the current OpenVINO version cannot use the graphics and detection silently ran on the processor; with this plugin the models load on the GPU again.
