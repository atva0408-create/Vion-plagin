## [1.5.0]

- People who look alike can be found across cameras, together with ViON NVR 0.12.0: choose this plugin for a camera in its settings → Plugins → Sensor Types → Person Re-ID. It keeps what a person's clothes and build look like, not who they are. Its model loads with the first person such a camera sees, never at start
- A search by picture finds the biggest person in the picture and cuts them out first, the way the server cuts the people out of the frames
- Segmentation: the plugin outlines people, vehicles and animals, on its page and for the server; this model too loads only when it is first needed
- Needs ViON 2.4.0 or newer: adding the plugin to a camera leaves Person Re-ID off there

## [1.4.6]

- A module version given out no more is unloaded, and an updated module of the store is loaded again: both stopped with an error since 1.4.4

## [1.4.5]

- Training modules from ViON Cloud: the detector of an object module (for example "bicycle") works next to the camera's own detector on the cameras chosen for it in ViON, and the classifiers of question modules work only on their cameras; a module version given out no more is unloaded

## [1.4.4]

- Detector modules from the ViON store: a module installed on the Modules tab of the store appears among the object models of this plugin and is used like them; an updated module is loaded again

## [1.4.3]

- Object detection gets frames of the size the chosen model expects: it was given 320×320 whatever the model, and switching the model could stop and start the detector twice

## [1.4.2]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.4.1]

- Compatibility update for the current ViON version

## [1.4.0]

- **Models trained by ViON.** When ViON Cloud has published a detector that was trained further on the footage you reviewed, the object model setting "Default" switches to it by itself, without a restart. Your own categories from the "Training" editor (for example "bicycle") come with the model. A model that fails to load does not leave the camera without object detection: the standard model keeps working.
- **Object attributes.** A new classifier, "ViON: признаки" (attributes): trained classifiers answer questions such as "person · with a bag" (yes / no), and the answer is stored in the event as an attribute. ViON switches it on by itself on the cameras where this plugin detects objects.

## [1.3.0]

- **Search in Russian.** A new search model, the multilingual SigLIP: queries in the AI search of the recordings can be written in Russian (and about 100 other languages) without translating them. Select the model in the plugin setting "CLIP Model (Images)"; after changing the model, press "Reindex search".
- The CLIP models in the settings now carry labels that show which ones understand English queries only

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

- A second CLIP model is available for the semantic search, and the model is now a single plugin setting instead of a choice per camera. After switching, the recordings view offers to reindex the existing events so that older footage stays searchable.
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

- The plugin description now points owners of older Intel graphics on Windows to the OpenVino Legacy plugin. No functional changes.

## [1.2.4]

- When Intel graphics on Windows refuses to load a model, the log now points to the new OpenVino Legacy plugin. It still loads all models on graphics up to 10th gen Core, where the regular plugin silently fell back to the processor.

## [1.2.3]

- Fixed license plate detection failing whenever exactly one plate was in the image: the log showed a license plate detection error and the plate was not read. Two or more plates worked.

## [1.2.2]

- Detection is roughly 50 times faster. The plugin had set up your hardware for processing many images at once, which pays off when hundreds of images are waiting, but detection sends one frame and waits for the answer. On Intel graphics that single frame took about a second instead of eleven milliseconds, so only one frame per second was analyzed and anyone walking past was easily missed. The setup is now tuned for a fast single answer.
- A GPU serves more cameras at once. It now works on two frames in parallel, which keeps it busy while image data is being moved.

## [1.2.1]

- A device that cannot run a model no longer floods the log. If your graphics driver refuses a model, the log now says so in one line and names the reason, instead of printing a long driver report for every model. Detection continues on the next device, as before.
- The device list in the log now includes the graphics driver version. On older Intel chips the driver decides whether the GPU can be used at all, so this is the first thing to check when models end up on the processor.
- Older Intel graphics gets a second chance before a model drops to the processor: if the graphics driver refuses a model, it is tried again at full precision on the same device.

## [1.2.0]

- Models are now prepared once instead of on every start. The prepared models are kept on disk, so a plugin restart skips the heavy preparation for GPU and NPU that could stall weaker systems. The first start after an update or a model change still takes longer.
- The "Active Hardware" field shows the device detection really runs on. With AUTO it used to stay on the temporary CPU step that is shown while the real device is still being prepared in the background.
- Fixed the "Re-download Models" button doing nothing: pressing it only produced an error in the log
- Compatibility update for the current ViON version
- Requires ViON 2.0.23 or newer

## [1.1.7]

- Choose the exact device on systems with several graphics cards. The "Device" list now shows every detected device individually (for example GPU.0 and GPU.1), so detection can run on a specific card instead of the one OpenVINO picks.

## [1.1.6]

- Fixed a restart loop on machines with an Intel NPU: loading the CLIP model stopped the plugin right after startup, over and over
- Face recognition, license plate reading and CLIP no longer fall back to the processor: the NPU and GPU can now run these models like the object detection models

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

- A model that fails to load is now reported in the log instead of being silently ignored, and it is tried again on the next request
- When a single model fails to load, the remaining models still load
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
