# Yandex Smart Home

Connects ViON to the Yandex Smart Home and the Alice stations. Sensors and relays of the hub in a Yandex station become sensors of ViON, scenarios of the Smart Home run from automations of ViON, stations say notifications aloud, and cameras of the Smart Home show in ViON.

## What it does

- **Sensors**: motion, doors and windows, leaks, smoke, gas, vibration, buttons, temperature, humidity, light level and CO₂ of the Smart Home become sensors of ViON. They can start recording and detection on the cameras and trigger automations
- **Control**: relays, sockets, switches and lights of the Smart Home become switches and lights of ViON, so automations of ViON turn them on and off
- **Scenarios**: each scenario of the Smart Home is offered as a switch. Turning it on runs the scenario, from the interface or from an automation
- **Speech on the stations**: with the sign-in as the Yandex app every station is a notification target. A station you turn on says notifications aloud: "Motion. Yard camera"
- **Assistant**: the assistant of ViON can say a phrase on a station, give Alice a command, run a scenario and read the state of the devices
- **Cameras**: cameras of the Smart Home are offered under Cameras and show their live view

## Two ways to sign in

The plugin can use either sign-in, or both together.

**Official API of the Smart Home.** The API Yandex offers to owners of a Smart Home. It reads the devices and scenarios and sends commands. It has no push: the plugin reads it at intervals (10 seconds by default). You need an app in Yandex ID with the rights iot:view and iot:control:

1. Create the app on the site of Yandex ID (oauth.yandex.ru): platform "Web services", rights "View the list of smart home devices" and "Control smart home devices"
2. Enter its **App ID** and **App secret** in the settings of the plugin and click **Sign in with Yandex ID**
3. Open ya.ru/device on a phone or computer, enter the code the window shows, then click the button in the window

Without a secret the window shows a page of Yandex ID instead: allow access there, copy the token and paste it into the window. Yandex ID shows the token there only when the app has the Redirect URI oauth.yandex.ru/verification_code (with https in front): enter it in the settings of the app on oauth.yandex.ru first.

**Yandex app (QR code).** The plugin signs in the way the Yandex apps do. This sign-in is needed for the speech on the stations, and it reports changes of the sensors at once:

1. Click **Sign in with QR code**
2. Scan the code with the Yandex app (or open the link on the phone signed in to Yandex) and confirm the sign-in
3. Click the button in the window

If you already have an x_token of the account, you can paste it into the **x_token** field instead.

## Settings

- **Read devices through**: Automatic takes the official API when it is signed in, the Yandex app otherwise
- **Reading interval**: how often the official API is read
- **Offer scenarios**: scenarios offered as switches
- **Speech on the stations**: Local goes straight to the station in the home network and says any length. Cloud goes through a scenario of the account, works wherever the station is, and says up to 100 characters. Automatic tries local first
- **Station addresses**: only if a station is not found in the network, as `Kitchen = 192.168.1.20`
- **Say on a station**: checks the speech with a phrase of your choice
- **Sign out**: forgets both sign-ins and which stations speak. Adopted sensors and cameras stay

## Adding sensors, cameras and stations

1. Sign in as above
2. Open **Sensors** in ViON: the devices of the Smart Home are offered for adoption with their rooms
3. Open **Cameras**: cameras of the Smart Home are under **Discovered**
4. In the notification settings of ViON, under Devices, the stations are listed once the plugin is signed in as the Yandex app. None of them speaks until you turn it on: switch on Active for the ones that should speak. Only an administrator of ViON can do this

## Good to know

- Only devices of your own houses are read; houses shared with you are not
- When Yandex no longer accepts a sign-in (the password was changed, the access was revoked), the plugin says so once in its log, forgets that sign-in and waits for a new one. The other sign-in, if there is one, goes on working
- A device that gives several sensors names each after itself and what it shows, in English: "Hall sensor: Motion". Rename them in ViON as you like
- The speech and the QR sign-in are not an official interface of Yandex. A change on the side of Yandex may need an update of the plugin. For the speech in the cloud the plugin keeps one scenario per station named "ViON" and the id of the station; do not delete it
- The microphone of a station is not available to other systems: Alice listens only to Yandex. To talk to ViON by voice, use the skill of ViON for Alice in the ViON cloud
- The video of a camera of the Smart Home comes from the cloud of Yandex
