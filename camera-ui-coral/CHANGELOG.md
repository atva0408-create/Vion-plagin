## [1.2.12]

- The description, settings and release notes of the plugin are now available in English, Russian and German and follow the language of the interface

## [1.2.11]

- Compatibility update for the current ViON version

## [1.2.10]

- Compatibility update for the current ViON version

## [1.2.9]

- Compatibility update for the current ViON version

## [1.2.8]

- Minor fixes

## [1.2.7]

- Compatibility update for the current ViON version

## [1.2.5]

- Object detection follows the confidence values set per object type (person, vehicle, animal) in the camera settings

## [1.2.4]

- The confidence threshold is no longer in the plugin settings. Object detection now uses the value from the camera's detection settings, so it is set in one place and a change takes effect right away
- The plugin reports which model it loaded and which hardware it runs on, so ViON can show this in the camera metrics

## [1.2.2]

- Compatibility update for the current ViON version

## [1.2.1]

- **A "Reset settings" button in every settings section.** One click puts all values of that section back to the defaults, models included.
- **A new "Default" choice in the model list.** It follows the recommended model, so plugin updates can improve the choice automatically. Choosing a specific model still keeps that model. Existing setups keep their current selection.

## [1.2.0]

- Fixed the "Download models again" button, which did nothing when pressed
- Compatibility update for the current ViON version
- Requires ViON 2.0.23 or newer

## [1.1.6]

- You can choose which Edge TPU runs the detection when several are connected. The new "Edge TPU device" setting accepts "usb", "pci" or a number such as ":0". Leaving it empty keeps the previous behavior (the first available one)

## [1.1.5]

- Downloaded models are no longer included in backups

## [1.1.4]

- Internal improvements

## [1.1.3]

- Compatibility update for the current ViON version

## [1.1.2]

- Bug fixes and improvements

## [1.1.1]

- The log names the model when it starts loading, and a model that fails to load is now reported instead of failing silently; loading it can then be tried again
- When one model fails to load during a reload, the other models are still loaded
- Compatibility update for the current ViON version

## [1.1.0]

- Compatibility update for the current ViON version

## [1.0.4]

- Compatibility update for the current ViON version

## [1.0.3]

- Bug fixes and improvements

## [1.0.2]

- Bug fixes and improvements

## [1.0.1]

- Bug fixes and improvements

## [1.0.0]

- First release
