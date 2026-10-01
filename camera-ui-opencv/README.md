# OpenCV

Detects motion in the camera picture. For each camera you choose one of three detection methods and adjust its sensitivity.

## What it does

- Detects motion in the camera picture and marks the areas where something moves
- Offers three detection methods: Frame Difference compares each picture with the previous one, Background Subtraction learns the calm scene and reports what differs from it, Default compares smoothed pictures with an adjustable threshold
- Keeps separate settings for each method and each camera
- Has a reset button for each method and one for all settings
- Works on the processor, no graphics card is needed
- The same methods can be used in the motion detection test and in automations

## Settings

- Motion Detector: the detection method used for the camera. Background Subtraction is preselected
- Area: the minimum size of detected motion in pixels. Smaller movements are ignored
- Threshold: the sensitivity. The higher the value, the lower the sensitivity
- Blur (Default method): smooths the picture to suppress noise
- Dilation (Default method): enlarges the areas of detected motion
- Learning Rate (Background Subtraction method): how fast the background adapts to changes in the scene, from 0 to 1; -1 means automatic
