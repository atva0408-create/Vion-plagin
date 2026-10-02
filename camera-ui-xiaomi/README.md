# Xiaomi

Connects Xiaomi Mi Home cameras to ViON. You sign in with your Mi account, the plugin finds the cameras of the account and you add the ones you want. The video goes from the camera to the ViON server over your local network; the Mi Home cloud only hands out the keys for each connection.

## What it does

- Signs in to your Mi account, including the picture check and the confirmation code Xiaomi may ask for
- Finds the cameras of the account in every Mi Home region and offers them for adding
- Shows the live view of each camera, with sound where the camera has it
- Keeps a sign-in token instead of your password, so after a restart the plugin signs in again on its own

## What you need

- Cameras in the same local network as the ViON server
- An internet connection: each connection to a camera asks the Mi Home cloud for its keys
- The account and password of the Mi Home app the cameras are in
- Cameras on the common Xiaomi camera protocol. Most models since 2020 use it; some older models are not supported

## Settings

- **Mi account** and **Password**: the email, phone number or Mi ID and the password of your Mi Home account. The password is used for the sign-in only and is not stored
- **Sign in**: signs in and finds the cameras. When Xiaomi asks for the characters of a picture or for a code it sent to your phone or mailbox, a window asks you for them
- **Signed-in account**: the ID of the account the plugin is signed in to
- **Sign out**: forgets the sign-in. Added cameras stay and show video again after the next sign-in
- **Picture quality**: Standard, High, Low or Maximum. Maximum suits newer models; on older ones it can break the picture

## Good to know

- Xiaomi offers no official interface for other systems. The plugin signs in the way the Mi Home app does, so a change on the side of Xiaomi may need an update of the plugin
- Cameras with two lenses show the first lens
- A camera that gets a new address in the network is found again within a few minutes
