# OpenVino

Detects objects, faces and license plates in the camera image and makes recordings searchable by description. It is optimized for Intel hardware: processor, Intel graphics or Intel NPU.

## What it does

- Object detection: people, vehicles and animals
- Face detection and face recognition
- Finds license plates and reads their text
- AI search by description; with the multilingual model also in Russian and about 100 other languages
- Finds people who look alike across cameras (Person Re-ID, switched on per camera) and outlines people, vehicles and animals (segmentation)
- Uses a detector that ViON Cloud trained on the footage you reviewed, once it is published
- Answers yes/no questions it was trained for about a detected object, for example "person with a bag"
- Lets you pick the exact device on systems with several graphics cards

## What you need

- Linux or Windows
- On Windows with Intel graphics up to 10th gen Core (HD/UHD Graphics 610 to 630), use the OpenVino Legacy plugin instead: the drivers of these chips do not work with the current OpenVINO version

## Settings

- "Device": 'Default' finds the device itself (NPU, GPU or CPU); AUTO lets OpenVINO choose; CPU, GPU and NPU force one device; numbered entries such as GPU.0 and GPU.1 select one of several cards.
- "Active Hardware": shows the device the models currently run on
- "CLIP Model (Images)": the AI search model for all cameras. After changing it, reindex the recordings.
- "Face Recognition Model": one model for all cameras. After a change the saved faces are processed again.
- Per camera: the models for object detection, face detection and license plates. "Default" follows the recommended model.
