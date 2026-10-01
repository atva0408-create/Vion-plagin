# Coral

Detects people, vehicles and animals in the camera picture and uses a Coral Edge TPU accelerator for the detection.

## What it does

- Detects people, vehicles and animals in the video of your cameras
- Runs the detection on a Coral Edge TPU and switches to the processor when no Edge TPU is available
- Lets you choose which Edge TPU to use when several are connected
- Follows the confidence values set per object type (person, vehicle, animal) in the camera's detection settings
- Downloads its model itself

## What you need

- A ViON server running Linux (x64 or ARM64)
- A Coral Edge TPU connected by USB or PCIe, and the Edge TPU system software (libedgetpu) installed on the server. Without them the plugin still works, then on the processor

## Settings

- **Use Edge TPU (Coral)**: when on, the detection runs on the Coral Edge TPU if it is available; otherwise the processor is used
- **Edge TPU device**: which Edge TPU to use when several are connected: "usb", "pci", ":0", ":1" or "usb:0". Leave the field empty to use the first available one
- **Active hardware**: shows where the models are running
- **Download models again**: deletes the downloaded models and downloads the current ones
- **Reset settings**: puts all plugin settings back to their defaults
- **Model**: set per camera in the "Object detection" group. "Default" follows the recommended model
