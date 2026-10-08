## [1.2.20]

- Training modules from ViON Cloud: the detector of an object module (for example "bicycle") works next to the camera's own detector on the cameras chosen for it in ViON, and the classifiers of question modules work only on their cameras; a module version given out no more is unloaded

## [1.2.19]

- Detector modules from the ViON store: a module installed on the Modules tab of the store appears among the object models of this plugin and is used like them; an updated module is loaded again

## [1.2.18]

- Object detection gets frames of the size the chosen model expects: it was given 320×320 whatever the model, and switching the model could stop and start the detector twice

## [1.2.17]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.2.16]

- Compatibility update for the current ViON version

## [1.2.15]

- Requires ViON 2.2.5 or newer
- **After the update, select this plugin as "Face Recognition" for each camera** (camera settings, "Plugins", "Detections"). Until then faces are detected but not named. The plugin downloads its new face models on the first start.
- **Face recognition is now a sensor of its own and straightens the face before recognizing it.** It recognizes far more people, and a face seen from the side or steeply from above gets no name instead of a wrong one. The recognition model is set once for the whole plugin; ViON processes the saved pictures of people again by itself.
- Compatibility update for the current ViON version

## [1.2.14]

- Compatibility update for the current ViON version

## [1.2.13]

- **TensorRT is ready faster after a model or plugin update.** The measurements from the previous preparation are kept and reused.
- Minor fixes

## [1.2.12]

- **When CUDA cannot be loaded, the log now says which Docker image fits.** This plugin needs the CUDA 12 libraries: the ViON image with NVIDIA support (CUDA 12). With CUDA 13, which is the ViON image with NVIDIA support (CUDA), use the regular ONNX plugin.

## [1.2.11]

- **License plates are read again.** Every reading was rated as unreadable and discarded before it reached an event, whatever the camera saw. If you lowered the reading confidence in the camera settings to work around this, set it back.

## [1.2.9]

- The CLIP model for the semantic search is now a single plugin setting instead of a choice per camera
- Object detection follows the confidence values per type (person, vehicle, animal) from the camera settings

## [1.2.8]

- The confidence thresholds have been removed from the plugin settings. Object, face and license plate detection now use the values from the camera's detection settings, so they are set in one place and a change takes effect right away.
- The plugin reports which model it has loaded and which device it runs on, so ViON can show this in the camera metrics

## [1.2.6]

- Compatibility update for the current ViON version

## [1.2.5]

- **The recommended face detection model has changed.** Behind the "Default" option there is now a stronger model: on test footage it finds a face in 82% of the frames where the previous one managed 30%, and it no longer mistakes the back of a head for a face. Your current selection stays untouched. New installations get it right away; on an existing one, choose "Default" in the model list or use "Reset settings". A face check then takes about twice the computing effort and only runs when a person was seen.

## [1.2.4]

- **A "Reset settings" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "Default" choice in every model list.** It follows the recommended model for the task, so plugin updates can improve the choice automatically. Selecting a specific model still fixes it. Existing setups keep their current selection.
- **Five new face detection models.** Small and medium sizes plus 640 px variants of every size (t, s, m). The 640 px models catch small and distant faces that the 320 px default misses, at a higher computing cost. The default model stays unchanged.

## [1.2.3]

- Initial release. The same functions as the ONNX plugin, but on CUDA 12. The regular plugin moved to CUDA 13, which dropped NVIDIA graphics cards before the GTX 1650 (Maxwell, Pascal, Volta); this plugin keeps them working on the GPU. It is also meant for systems that stay on an installed CUDA 12.
