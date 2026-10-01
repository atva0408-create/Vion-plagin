# Wyze

Connects the cameras of your Wyze account to ViON, with live view and motion events.

## What it does

- Finds the cameras of your Wyze account and lists them as discovered cameras
- Adds each camera with two video streams, one in HD and one in SD quality
- Reports the motion events of the camera as a motion sensor in ViON
- Saves the login, so the plugin connects again on its own after a restart

## What you need

- A Wyze account: its email and password
- Two access keys for that account, which Wyze issues on its developer portal; they go into the fields "API ID" and "API Key"

## Settings

- **Email** and **Password**: your Wyze account
- **API ID** and **API Key**: the pair of keys from the Wyze developer portal
- **Log In**: signs in to Wyze with these details and loads the cameras of the account
