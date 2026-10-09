## [0.4.1]

- Releasing an arrow, changing direction or removing PTZ cancels motor commands still waiting for P2P authentication. Queued commands cannot move a disposed control; movement state starts when the command is sent.
- UDP command writes are serialized and acknowledgements match the command's channel and sequence. Unbuffered out-of-order packets are not acknowledged, allowing retransmission. Closing a session releases pending acknowledgements immediately; command buffers are bounded.
- Damaged encrypted replies close only the motor session instead of crashing the plugin. Invalid relay frames are filtered before go2rtc, and remote disconnects notify the PTZ client. Failed motor bridges are released without stopping video.
- Sign-out and camera removal cancel pending LAN as well as remote connections. A PTZ sensor registered during camera removal is cleaned up.
- SDK reconnection restores PTZ without replaying commands from the previous connection. Disabling a held zoom still sends the lens stop command.

## [0.4.0]

- CS2 cameras in another network connect through Xiaomi P2P relays. Per-camera connection settings offer Auto, Local network and Remote P2P; Auto prefers a verified local connection. Existing go2rtc video/audio playback is retained through a loopback-only transport bridge.
- Remote sessions use fresh cloud credentials, bounded retries and cancellation on sign-out, camera removal or shutdown. Idle sessions are released. Verified remotely with `xiaomi.camera.c01a01`, HEVC 2304×1296 at Maximum quality.

## [0.3.0]

- Cameras with a zoom lens zoom from ViON: the zoom of the player and **Home** (all the way out), with **Pan, tilt and zoom (PTZ)** switched on. Their focus is set next to the switch: **Focus nearer**, **Focus farther** and the autofocus of the camera. The plugin finds the zoom and the focus in the MIoT description Xiaomi publishes for the model; cameras with a fixed lens (Mi 360°, C200, C300) have neither and turn as before
- A held arrow turns the camera in one smooth movement: the motor was stepped every half second and stopped before every step, so the camera turned in jerks and missed some of the steps. Autotracking sees the camera as moving for as long as its motor turns

## [0.2.0]

- Cameras with a motor turn from ViON: switch on **Pan and tilt (PTZ)** for the camera under **Settings**, **Autotrack**, then hold an arrow in the player or let autotracking follow a person

## [0.1.1]

- The picture check is shown however Xiaomi sends it, and a mistyped code is typed again in the same window, without a new code
- Cameras ViON cannot play yet (MTP and Agora) are not offered: the sign-in names them and says why
- Signing out removes the cameras of the account and the stored sign-in, also while a sign-in or the camera list is still running
- A sign-in Xiaomi refused is not tried again and again: the log asks once to sign in anew
- A sign-in left waiting for the code is given up after 10 minutes, and the password is forgotten with it
- Errors in the log and in messages say what caused them

## [0.1.0]

- First version: sign-in to the Mi account with the picture check and the confirmation code, cameras of every Mi Home region, live view over the local network
