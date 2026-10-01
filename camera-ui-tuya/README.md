# Tuya

Connects Tuya and Smart Life cameras to ViON. After you sign in, the plugin finds the cameras of your account and you add the ones you want; their live view runs through the Tuya service.

## What it does

- Finds the cameras of your Tuya / Smart Life account and offers them for adding
- Shows the live view of each camera
- Offers two ways to sign in: your app account, or a cloud project on the Tuya IoT platform
- When you fill in both, combines their cameras without listing one twice

## What you need

- An internet connection: the cameras are reached through the Tuya service
- Either the email and password of your Tuya / Smart Life account
- Or a cloud project on the Tuya IoT platform with your app account linked to it: its Client ID, its Client Secret and the UID of the linked account
- The region of the data center your account belongs to

## Settings

- **Email** and **Password**: the details of your Tuya / Smart Life account
- **Client ID**, **Client Secret** and **User ID**: the details of your Tuya IoT cloud project. Fill in either this group or email and password; both together work as well
- **Region**: the data center region of your Tuya account; the plugin connects to the servers of that region
- **Log In**: checks what you entered and signs in to Tuya
