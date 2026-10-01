# Rust Motion

Detects motion in the camera picture with low load on the processor. It also catches small and slow movement.

## What it does

- Detects motion in the camera picture and marks the areas where something moves
- Puts little load on the processor and needs no graphics card
- Detects small and slow movement reliably, by day and at night
- Counts changed regions close to each other as one movement, so a distant animal is one detection instead of several specks
- Starts over after a camera move or a sudden change of exposure instead of marking the whole picture
- Keeps separate settings for each camera, with a button that restores the default values

## What you need

- The detector is not available for every server system. If it is missing for yours, the plugin adds no motion sensor to the cameras

## Settings

- Area: the minimum combined size of nearby changed regions that counts as motion
- Threshold: the brightness change at which a pixel counts as changed
- Blur Radius: smooths the picture before detection to reduce noise
- Dilation Size: joins nearby changed pixels into one area
- Reference Hold: how many seconds the comparison image is kept. Higher values catch very slow movement, lower values keep the motion boxes closer to the current position
