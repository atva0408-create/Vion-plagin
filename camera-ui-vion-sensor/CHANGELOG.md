# Changelog

## [0.2.0]

### Added

- Floor plans can show the sensor's motion, calibration countdown, missing router packets and connection state, together with its camera. Live readings reuse the existing cache without extra requests to the board.
- **Presence** (firmware 1.1.0): a second sensor of the board, offered in Sensors, Found once its motion sensor is added. It notices a person standing still too (the Espressif esp-radar algorithm). Its sensitivity is in the sensor's settings, and so is the choice of which algorithm makes motion: ViON, Espressif or either.
- **HLK-LD2450 radar** on the board: the positions of up to three people go to the floor plan.
- A firmware update that did not start (the board went back by itself) is shown in the settings and in the log.

## [0.1.0]

### Added

- **ViON Sensor:** a security sensor on an ESP32-CAM board that notices movement by the Wi-Fi signal. The board is
  found in the network by itself, added from Sensors, Found, set up and updated from ViON; its camera is optional.
