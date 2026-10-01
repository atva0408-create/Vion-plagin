# WASM Motion

Detects motion in the camera picture. The plugin works on any system and needs no extra components.

## What it does

- Detects motion by comparing the pixels of the camera picture and marks the areas where something moves
- Works on any system without extra components and without a graphics card
- Lets you adjust the sensitivity for each camera separately
- Has a button that restores the default values

## Settings

- Area: the minimum size of an area that counts as motion
- Threshold: the brightness change at which a pixel counts as changed
- Blur Radius: smooths the picture before detection to reduce noise
- Dilation Size: joins nearby changed pixels into one area
- Reset settings: restores the default detection values
