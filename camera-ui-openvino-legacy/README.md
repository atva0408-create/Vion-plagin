# OpenVino Legacy

Object, face and license plate detection for older Intel graphics. With the regular OpenVino plugin these chips cannot load the models, and every model silently moves to the processor.

## What it does

- Object detection: people, vehicles and animals
- Face detection and face recognition
- Finds license plates and reads their text
- AI search by description
- Finds people who look alike across cameras (Person Re-ID, switched on per camera) and outlines people, vehicles and animals (segmentation)

## What you need

- Use it instead of the regular OpenVino plugin if your Intel graphics is 10th gen Core or older (Gen9/Gen11 graphics, for example HD/UHD Graphics 610 to 630)
- It mainly matters on Windows, where the part these chips depend on belongs to the graphics driver and cannot be updated separately
- On Linux with the ViON Docker image it is usually not needed: the image already contains what older Intel graphics needs
- On 11th gen Core and newer (Iris Xe, Arc), use the regular OpenVino plugin: it is faster there and keeps receiving fixes

## Settings

- "Device": 'Default' finds the device itself (NPU, GPU or CPU); AUTO lets OpenVINO choose; CPU, GPU and NPU force one device; numbered entries such as GPU.0 and GPU.1 select one of several cards.
- "Active Hardware": shows the device the models currently run on
- "CLIP Model (Images)": the AI search model for all cameras. After changing it, reindex the recordings.
- "Face Recognition Model": one model for all cameras. After a change the saved faces are processed again.
- Per camera: the models for object detection, face detection and license plates. "Default" follows the recommended model.
