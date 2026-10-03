# Xiaomi

Connects Xiaomi Mi Home cameras to ViON. You sign in with your Mi account, the plugin finds the cameras of the account and you add the ones you want. The video goes from the camera to the ViON server over your local network; the Mi Home cloud only hands out the keys for each connection.

## What it does

- Signs in to your Mi account, including the picture check and the confirmation code Xiaomi may ask for
- Finds the cameras of the account in every Mi Home region and offers them for adding
- Shows the live view of each camera, with sound where the camera has it
- Turns cameras with a motor: arrows in the player and autotracking, once switched on for the camera; zooms and focuses cameras with a zoom lens
- Keeps the sign-in token of your Mi account instead of the password, so after a restart the plugin signs in again on its own. The token opens the whole Mi account, see **Good to know**

## What you need

- Cameras in the same local network as the ViON server
- An internet connection: each connection to a camera asks the Mi Home cloud for its keys
- The account and password of the Mi Home app the cameras are in
- Cameras on the common Xiaomi camera protocol. Most models since 2020 use it; some older models are not supported. Cameras that Xiaomi connects over MTP or Agora cannot be played yet: they are not offered for adding, and the window of the sign-in lists them

## Settings

- **Mi account** and **Password**: the email, phone number or Mi ID and the password of your Mi Home account. The password is used for the sign-in only and is not stored
- **Sign in**: signs in and finds the cameras. When Xiaomi asks for the characters of a picture or for a code it sent to your phone or mailbox, a window asks you for them
- **Signed-in account**: the ID of the account the plugin is signed in to
- **Sign out**: forgets the sign-in and deletes the sign-in token from ViON. Added cameras stay and show video again after the next sign-in
- **Picture quality**: Standard, High, Low or Maximum. Maximum suits newer models; on older ones it can break the picture

## Adding the cameras

1. Open the settings of the plugin, enter the Mi account and the password, and click **Sign in**
2. If Xiaomi asks for the characters of a picture or for a code, enter them in the window that opens. A mistyped code can be typed again in the same window; a window left waiting for 10 minutes is cancelled
3. The window then lists the cameras found
4. Open **Cameras** in ViON: the cameras are under **Discovered**. Click a camera, check its name and confirm

## Pan, tilt and zoom

For a camera with a motor (Mi 360°, C200, C300 and alike) open the camera in ViON, then **Settings**, **Autotrack**, and switch on **Pan, tilt and zoom (PTZ)**. The player then shows arrows: hold one to turn the camera, a short press turns it by one step. Autotracking can follow a person with it. The plugin turns the camera over a connection of its own, the way the Mi Home app does. This works for cameras on the CS2 protocol, which most models use, and not for cameras on TUTK; the log of the camera says so at the first step.

A camera with a zoom lens also zooms: the zoom of the player steps it in and out while held, **Home** zooms all the way out. Its focus appears next to the switch: **Focus nearer** and **Focus farther** step the focus, **Focus automatically** (or **Autofocus**) leaves it to the camera. Zoom and focus go through the Mi Home cloud, as in the app, and the plugin finds them in the MIoT description Xiaomi publishes for the model (miot-spec.org): the server needs internet when the switch is turned on. Cameras with a fixed lens (Mi 360°, C200, C300) have no zoom to drive: the picture of the player can still be enlarged with two fingers or the mouse wheel.

## Good to know

- The sign-in token is a key to your whole Mi account, not only to its cameras: whoever has it can sign in to the account without the password. ViON keeps it in the settings of the plugin, so protect the ViON server and its backups as you would the password. **Sign out** deletes it from ViON; to make a copy of it useless, change the password of the Mi account. After a change of the password Xiaomi refuses the token, and the plugin asks you to sign in again
- Xiaomi offers no official interface for other systems. The plugin signs in the way the Mi Home app does, so a change on the side of Xiaomi may need an update of the plugin
- Cameras with two lenses show the first lens
- A camera that gets a new address in the network is found again within a few minutes
