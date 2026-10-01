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

## [1.2.15]

- Requires ViON 2.2.5 or newer
- **After the update, select this plugin as "Face Recognition" for each camera** (camera settings, "Plugins", "Detections"). Until then faces are detected but not named. The plugin downloads its new face models on the first start.
- **Face recognition is now a sensor of its own and straightens the face before recognizing it.** It recognizes far more people, and a face seen from the side or steeply from above gets no name instead of a wrong one. The recognition model is set once for the whole plugin; ViON processes the saved pictures of people again by itself.
- Compatibility update for the current ViON version

## [1.2.14]

- Compatibility update for the current ViON version

## [1.2.13]

- **TensorRT is ready faster after a model or plugin update.** The measurements from the previous preparation are kept and reused.
- **When the TensorRT libraries are missing, the log now names the right Docker image.** With 'tensorrt' selected, it points to the ViON image with NVIDIA support (TensorRT), which contains them.
- Minor fixes

## [1.2.12]

- **When CUDA cannot be loaded, the log now says which Docker image fits.** This plugin needs the CUDA 13 libraries: the ViON image with NVIDIA support (CUDA) and NVIDIA driver 580 or newer on the host. On a system with CUDA 12, use the ViON image with NVIDIA support (CUDA 12) together with the ONNX Legacy plugin.

## [1.2.11]

- **License plates are read again.** Every reading was rated as unreadable and discarded before it reached an event, whatever the camera saw. If you lowered the reading confidence in the camera settings to work around this, set it back.

## [1.2.9]

- A second CLIP model is available for the semantic search, and the model is now a single plugin setting instead of a choice per camera. After switching, the recordings view offers to reindex the existing events so that older footage stays searchable.
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

- The plugin moved to CUDA 13. The RTX 50 series is now supported natively. Your system needs CUDA 13, cuDNN 9 for CUDA 13 and NVIDIA driver 580 or newer.
- NVIDIA graphics cards before the GTX 1650 (Maxwell, Pascal, Volta) lost GPU support with CUDA 13. On those cards use the new sibling plugin "ONNX Legacy": it stays on CUDA 12 and keeps them working on the GPU. It is also the right choice if you want to keep an installed CUDA 12. The log points to it when detection on the GPU fails.

## [1.2.2]

- Fixed license plate detection failing whenever exactly one plate was in the image: the log showed a license plate detection error and the plate was not read. Two or more plates worked.

## [1.2.1]

- CUDA works again on Linux and Windows. The fix from 1.2.0 was undone shortly before the release, so detection stayed on the processor no matter what the "Execution Provider" setting said.
- When the selected provider is missing from the installation, the log now says so; before, the plugin quietly ran on the processor

## [1.2.0]

- Models for the processor load faster after the first start. The prepared model is kept on disk and reused instead of being rebuilt on every plugin start.
- Fixed the "Re-download Models" button doing nothing: pressing it only produced an error in the log
- CUDA works again. On Linux, detection often stayed on the processor no matter what the "Execution Provider" setting said.
- Compatibility update for the current ViON version
- Requires ViON 2.0.23 or newer

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

- The CoreML option was removed from the "Execution Provider" setting; 'auto' now selects CUDA on Linux and Windows (x86_64) and the processor otherwise
- CUDA is tuned for faster detection
- A model that fails to load is now reported in the log and tried again on the next request; when one model fails, the others still load
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
