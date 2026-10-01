# Pam Diff

Detects motion by comparing the camera picture pixel by pixel.

## What it does

- Compares the camera pictures pixel by pixel and reports motion when enough pixels have changed
- Marks the areas where something moves
- Compares either in grayscale, which is faster, or in color
- Lets you adjust the sensitivity for each camera separately
- Has a button that restores the default values

## Settings

- Motion Difference: how much the color of a pixel must change to count as motion
- Motion Percentage: the share of changed pixels needed to trigger motion
- Detection Mode: Grayscale or RGB. Grayscale is faster
- Reset settings: restores the default detection values
