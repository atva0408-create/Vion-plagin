# ViON Sensor

A security sensor on an ESP32-CAM board. It notices people moving in a room by how they change the Wi-Fi signal
between the board and the router (Wi-Fi Sensing): no video, works in the dark and through a door. The camera of the
board is optional.

## Setting up a board

1. Flash the ViON Sensor firmware once over USB (see `sensor esp VION` in the ViON project).
2. Power the board where it should watch. It shows its own Wi-Fi network **ViON-Sensor-XXXX**: connect a phone to it,
   choose your home network (2.4 GHz) and enter its password.
3. In ViON open **Sensors**, **Found**, and add **ViON Sensor XXXX**. The board gives this ViON its key: from now on it
   answers only here.
4. For 30 seconds after the start the sensor learns the empty room: keep the room empty.

If the board does not appear, type its address in the settings of this plugin.

## Settings of a sensor

- **Sensitivity threshold** — how many times the signal has to change more than in an empty room. Lower is more
  sensitive and gives more false alarms; start at 1.4.
- **Motion lasts, seconds** — how long the sensor stays in motion after the last movement.
- **Camera** — turns the camera of the board on; it then appears in **Cameras**, **Found**. The board restarts and
  calibrates again.
- **Calibrate** — learn the empty room again (leave the room first).
- **Update the firmware** — appears when a new firmware is out; the board downloads and checks it itself.
- **Reset the sensor** — the board forgets the Wi-Fi and this ViON.

Three quick power-ons in a row (each shorter than 10 seconds) also reset the board.

## Placing it

The sensor sees best what moves near the line between the board and the router. Fix the 2.4 GHz channel of the
router (not "auto") and a 20 MHz width: a changing channel looks like movement.
