# CoreML

Detects objects, faces and license plates in the video of your cameras on a Mac, using Apple CoreML, and provides the semantic search (CLIP).

## What it does

- Detects people, vehicles and animals
- Detects faces and recognizes known people
- Detects license plates and reads their text
- Provides the CLIP semantic search for events
- Follows the confidence values from the camera's detection settings
- Lets you choose which parts of the Apple hardware do the work: CPU, GPU and Neural Engine
- Downloads its models itself

## What you need

- A ViON server running on a Mac (macOS)
- For names on faces, this plugin must be selected as "Face Recognition" for each camera: camera settings, "Plugins", "Detections"

## Settings

- **CLIP model (images)**: the model for the semantic search, shared by all cameras. After a change the recordings have to be reindexed
- **Face recognition model**: shared by all cameras. After a change the saved faces are recalculated
- **Compute units**: where CoreML runs the models. ALL uses CPU, GPU and Neural Engine; the other options use only some of them
- **Active hardware**: shows where the models are running
- **Download models again**: deletes the downloaded models and downloads the current ones
- **Reset settings**: puts all plugin settings back to their defaults
- Per camera, in the groups "Object detection", "Face detection" and "License plates": **Model**, **Detection model** and **OCR model**. "Default" follows the recommended model
