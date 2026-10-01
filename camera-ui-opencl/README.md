# OpenCL

Detects motion in the camera picture and does the analysis on the graphics card.

## What it does

- Detects motion in the camera picture and marks the areas where something moves
- Runs the analysis on the graphics card
- Lets you choose which device does the analysis, which helps in systems with several graphics cards
- Keeps separate sensitivity settings for each camera, with a button that restores the default values
- Can be used in the motion detection test and in automations

## What you need

- A graphics card with an installed OpenCL driver. Without OpenCL on the server, motion detection does not start
- If no graphics card is found, the plugin uses the processor, provided an OpenCL driver for it is installed

## Settings

- OpenCL Device: the device that does the analysis. 'auto' takes the first graphics card found; the other entries are the detected devices, numbered as in the hint under the field
- Area: the minimum size of detected motion in pixels. Smaller movements are ignored
- Threshold: the sensitivity, from 0 to 1. The higher the value, the lower the sensitivity
- Blur: smooths the picture to suppress noise
- Dilation: enlarges the areas of detected motion
