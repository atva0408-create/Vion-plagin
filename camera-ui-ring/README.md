# Ring

Connects your Ring cameras and doorbells to ViON. After you sign in with your Ring account, you add the devices you want as cameras.

## What it does

- Finds the cameras and doorbells of your Ring account and offers them for adding
- Shows the live view and current pictures of each device
- Passes motion detected by Ring on to ViON as a motion event
- Shows the battery level of battery cameras, including charging and low battery
- Switches the light and the siren of devices that have them, and shows their state
- Reports each button press of doorbells wired to a chime inside the house

## What you need

- A Ring account with its email and password
- With two-factor authentication: the code Ring sends to your phone or email at sign-in
- An internet connection: the devices are reached through the Ring service

## Settings

- **Home Name**: a name of your choice for this Ring home
- **Login Email** and **Login Password**: the details of your Ring account
- **Log In**: signs in to Ring. With two-factor authentication the field **Two-Factor Code** appears; enter the code and press **Log In** again
- **Polling**: asks Ring regularly for the state of battery, light, siren and connection. Motion and doorbell events arrive immediately even when it is off
- **Location IDs**: limits the plugin to certain Ring locations. Leave empty to load the cameras of all locations
