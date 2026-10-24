## [1.5.6]

- A model file that came back as a web page (the sign-in page of a hotel or train Wi-Fi) or cut short is no longer saved, and one saved before is downloaded again: the model failed to load at every start
- A classifier version given out no more (a newer version of its question) is unloaded instead of staying in memory with every new version

## [1.5.5]

- A question module asked of a class a module adds (a store module's bicycle) runs on its boxes: only person, vehicle and animal boxes were sent to the classifier, and a detector's own case of a class («Bicycle») did not match the question's

## [1.5.4]

- The outline of a thing marked on a picture, for VION NVR 0.23.0's «when did it go, who carried it off» (`outlineMarked`): SAM 2.1 Hiera tiny (155 MB from the models mirror) outlines what a box or a point on a picture shows. It loads with the first question and leaves memory after five minutes without one. Always on the processor, whatever the plugin's device: a quarter of the cores (two at least), one picture at a time, 3-5 s a picture on the bench, about 0.6 GB while loaded. While it loads the answer says so; a picture that cannot be read gets no outline and the others are outlined. Never in the background

## [1.5.3]

- At its start the plugin no longer writes «Не удалось предзагрузить модели CLIP:» with nothing after it: a failure of the translator of the search words is told as its own, and an error without text is named by its kind

## [1.5.2]

- «Outline the object» finds a person lying on the bed: the picture try-out takes the threshold it is asked for (the outline asks for 0.25 and shows each one's percentage); other try-outs keep the plugin's own

## [1.5.1]

- Search in the picture: a picture that cannot be read (a card cut short on a full disk or at a stop, an empty file) has no boxes and the others are looked at; it failed the whole call, and VION NVR ended the search of all the events found

## [1.5.0]

- The search by description understands the platform's language: CLIP ViT-B/32, the default model, knows English only, and a query in Russian found nothing. A query is put into English by opus-mt (≈110 MB, 0.2-0.3 s a query) from Russian whenever it has Cyrillic, whatever the platform speaks, else from the language of the platform the search comes from (German); the multilingual SigLIP gets the query as it is. The Russian translator is loaded at start with an English CLIP, another one when first needed (the search goes as typed while it loads, at most 15 s). Needs VION NVR 0.19.0 for the platform's language
- Words found in pictures: VION's recordings ask where the thing searched for by description is in the picture of each event found («красная сумка», «человек с велосипедом»), and show the find. The query is put into English the same way, OWL-ViT B/32 boxes the thing, a find comes with its crop. The model (≈600 MB) downloads and loads in the background when first asked for — meanwhile the answer says it loads, a failed load is said to the next call — and leaves memory after five minutes without a search; a picture takes 1-4 s on a processor. Needs VION NVR 0.19.0

## [1.4.0]

- Posture of people: with «Поза людей» on, the attribute sensor («VION: признаки») tells of every person a camera sees whether they stand, sit or lie, and the event gets it as the attribute «поза» («поза: лежит»). Turn it on in VION: Extensions → Modules → «Поза людей», or in the settings of the camera's attribute sensor. Its model (RTMPose-t) loads with the first person such a camera sees, never at start. Too little of a person seen, or a person bent over, says nothing.
- A pose model that loads but fails on the crops is dropped and reported to VION as not working, with the reason, and loaded again after ten minutes; it no longer looks as if it analysed
- Needs VION 2.4.2 or newer: older VION kept one answer per person in a frame and in a stay, so the posture would have pushed the trained questions' answers out and lost a change of posture
- A person the picture cuts (VION 2.4.2 says so) is said standing or nothing, never sitting or lying: the model makes the hidden legs up; on the bench 5 of the 6 wrong answers of a morning were such people

## [1.3.2]

- A model a sensor has not loaded yet is reported to VION as waiting to be loaded when first needed (Re-ID with the first person a camera sees) or as failed, with the reason: VION shows the first as connected and only the second as not working.
- A module version gone back to, or a fixed one, is loaded at once also for a camera that fell back to the standard model, not with its next frame with motion.

## [1.3.1]

- A failed module update keeps the working detector. Overlapping updates build one replacement, obsolete loads are discarded, and a successful swap refreshes the camera's input size.
- A model load that completes after shutdown or a device change cannot reactivate the old session.
- The plugin tells VION which version of a module it loaded and which it could not: the module card names a version that did not load, and an update keeps the version that worked as the way back. A camera whose module version does not load after a restart works on the standard model until the module loads. An update or a rollback of a module is loaded at once, without the ten-minute pause after a failed load.

## [1.3.0]

- People who look alike can be found across cameras, together with VION NVR 0.12.0: choose this plugin for a camera in its settings → Plugins → Sensor Types → Person Re-ID. It keeps what a person's clothes and build look like, not who they are. Its model loads with the first person such a camera sees, never at start
- A search by picture finds the biggest person in the picture and cuts them out first, the way the server cuts the people out of the frames
- Segmentation: the plugin outlines people, vehicles and animals, on its page and for the server; this model too loads only when it is first needed
- Needs VION 2.4.0 or newer: adding the plugin to a camera leaves Person Re-ID off there

## [1.2.22]

- A module version given out no more is unloaded, and an updated module of the store is loaded again: both stopped with an error since 1.4.4

## [1.2.21]

- Training modules from VION Cloud: the detector of an object module (for example "bicycle") works next to the camera's own detector on the cameras chosen for it in VION, and the classifiers of question modules work only on their cameras; a module version given out no more is unloaded

## [1.2.20]

- Detector modules from the VION store: a module installed on the Modules tab of the store appears among the object models of this plugin and is used like them; an updated module is loaded again

## [1.2.19]

- Object detection gets frames of the size the chosen model expects: it was given 320×320 whatever the model, and switching the model could stop and start the detector twice

## [1.2.18]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.2.17]

- Compatibility update for the current VION version

## [1.2.16]

- Requires VION 2.2.5 or newer
- **After the update, select this plugin as "Face Recognition" for each camera** (camera settings, "Plugins", "Detections"). Until then faces are detected but not named. The plugin downloads its new face models on the first start.
- **Face recognition is now a sensor of its own and straightens the face before recognizing it.** It recognizes far more people, and a face seen from the side or steeply from above gets no name instead of a wrong one. The recognition model is set once for the whole plugin; VION processes the saved pictures of people again by itself.
- Compatibility update for the current VION version

## [1.2.15]

- Compatibility update for the current VION version

## [1.2.14]

- Minor fixes

## [1.2.13]

- **License plates are read again.** Every reading was rated as unreadable and discarded before it reached an event, whatever the camera saw. If you lowered the reading confidence in the camera settings to work around this, set it back.

## [1.2.11]

- The CLIP model for the semantic search is now a single plugin setting instead of a choice per camera
- Object detection follows the confidence values per type (person, vehicle, animal) from the camera settings

## [1.2.10]

- The confidence thresholds have been removed from the plugin settings. Object, face and license plate detection now use the values from the camera's detection settings, so they are set in one place and a change takes effect right away.
- The plugin reports which model it has loaded and which device it runs on, so VION can show this in the camera metrics

## [1.2.8]

- Compatibility update for the current VION version

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
