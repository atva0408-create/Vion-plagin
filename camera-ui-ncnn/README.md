# NCNN

Detects objects, faces and license plates in the video of your cameras. It runs on the server's processor or, when one is present, on a graphics card that supports Vulkan.

## What it does

- Detects people, vehicles and animals
- Detects faces and recognizes known people
- Detects license plates and reads their text
- Uses a graphics card with Vulkan when one is present, otherwise the processor
- Follows the confidence values from the camera's detection settings
- Downloads its models itself

## What you need

- For faster detection, a graphics card with Vulkan support; without one the plugin runs on the processor
- For names on faces, this plugin must be selected as "Face Recognition" for each camera: camera settings, "Plugins", "Detections"

## Settings

- **Face recognition model**: shared by all cameras. After a change the saved faces are recalculated
- **Use Vulkan (GPU)**: when on, the models run on the graphics card through Vulkan if it is available; otherwise on the processor
- **Vulkan device**: which graphics card is used on systems with several; "Auto" leaves the choice to the system
- **Active hardware**: shows where the models are running
- **Download models again**: deletes the downloaded models and downloads the current ones
- **Reset settings**: puts all plugin settings back to their defaults
- Per camera, in the groups "Object detection", "Face detection" and "License plates": **Model**, **Detection model** and **OCR model**. "Default" follows the recommended model
