# YAMNet Audio Detection

Listens to the sound of your cameras, recognizes typical sounds such as breaking glass, a siren or a barking dog, and reports them to ViON.

## What it does

- Recognizes twelve kinds of sound: doorbell, glass break, siren, speaking, gunshot, dog bark, baby cry, alarm, scream, cat, car alarm and smoke alarm
- Reports each sound once and under the names ViON uses for sounds
- Uses the confidence value from the camera's settings, so the sensitivity is set per camera in one place
- Needs no setup of its own: the plugin always listens for all of these sounds
- Downloads its model itself on the first start
- Runs on the server's processor

## What you need

- A camera that transmits sound

## Settings

- The plugin has no settings of its own. How certain it must be before it reports a sound is set per camera with "Audio Confidence" in the camera's settings; if nothing is set there, the value 0.7 applies
- **Sounds to listen for** and **Confidence threshold** are used only when you test the detection
