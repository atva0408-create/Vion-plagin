# ONNX Legacy

Object, face and license plate detection for older NVIDIA graphics cards and for systems that stay on CUDA 12. With the regular ONNX plugin, detection on these cards silently moves to the processor.

## What it does

- Object detection: people, vehicles and animals
- Face detection and face recognition
- Finds license plates and reads their text
- AI search by description

## What you need

- Use it instead of the regular ONNX plugin if your NVIDIA card is older than a GTX 1650: Maxwell (GTX 700/900 series), Pascal (GTX 10 series, Quadro P400 to P4000, Tesla P4/P40/P100) or Volta (Titan V, Tesla V100)
- Or if you want to keep an installed CUDA 12
- CUDA 12.x, cuDNN 9.x for CUDA 12 and NVIDIA driver 525 or newer
- Linux or Windows
- On a GTX 1650 or newer, use the regular ONNX plugin: it works with CUDA 13, supports the RTX 50 series natively and keeps receiving fixes

## Settings

- "Execution Provider": 'auto' uses CUDA on Linux and Windows (x86_64), otherwise the processor; with 'tensorrt' (NVIDIA TensorRT) the first start takes longer. If it fails, the processor takes over.
- "CUDA Device IDs": which graphics cards to use, for example "0,1"
- "CLIP Model (Images)": the AI search model for all cameras. After changing it, reindex the recordings.
- "Face Recognition Model": one model for all cameras. After a change the saved faces are processed again.
- Per camera: the models for object detection, face detection and license plates. "Default" follows the recommended model.
