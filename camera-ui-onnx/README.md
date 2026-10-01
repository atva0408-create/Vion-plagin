# ONNX

Detects objects, faces and license plates in the camera image and makes recordings searchable by description. It runs on an NVIDIA graphics card or, without one, on the processor.

## What it does

- Object detection: people, vehicles and animals
- Face detection and face recognition
- Finds license plates and reads their text
- AI search by description; with the multilingual model also in Russian and about 100 other languages
- Uses a detector that ViON Cloud trained on the footage you reviewed, once it is published
- Answers yes/no questions it was trained for about a detected object, for example "person with a bag"
- Can use several NVIDIA graphics cards at once

## What you need

- Linux or Windows
- For an NVIDIA graphics card: CUDA 13, cuDNN 9 for CUDA 13 and NVIDIA driver 580 or newer
- For NVIDIA cards older than the GTX 1650 (Maxwell, Pascal, Volta) or systems staying on CUDA 12, use the ONNX Legacy plugin instead

## Settings

- "Execution Provider": 'auto' uses CUDA on Linux and Windows (x86_64), otherwise the processor; with 'tensorrt' (NVIDIA TensorRT) the first start takes longer. If it fails, the processor takes over.
- "CUDA Device IDs": which graphics cards to use, for example "0,1"
- "CLIP Model (Images)": the AI search model for all cameras. After changing it, reindex the recordings.
- "Face Recognition Model": one model for all cameras. After a change the saved faces are processed again.
- Per camera: the models for object detection, face detection and license plates. "Default" follows the recommended model.
