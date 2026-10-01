# Home Assistant

Brings the devices of your Home Assistant into ViON and delivers ViON notifications through Home Assistant.

## What it does

- Lists the usable Home Assistant entities in the Discovered section of the Sensors page, with name, type and room; you add the ones you want
- Turns motion, occupancy, contact, doorbell, smoke, leak, gas, carbon monoxide and other supported entities into ViON sensors you can assign to cameras as detection triggers
- Brings in locks, garage doors, alarm panels, switches, lights and sirens as controls: switching them in ViON switches them in Home Assistant
- Offers the notify services of Home Assistant (companion app, Telegram and others) as notification targets under Settings > Notifications
- Keeps a sensor with its camera assignments when the entity is renamed in Home Assistant, and marks it as removed when the entity is deleted
- Never offers entities that ViON itself passed on to Home Assistant

## What you need

- A long-lived access token, created in your Home Assistant profile under Security
- Nothing to enter when ViON runs as a Home Assistant add-on: the plugin connects by itself
- For pictures in notifications and for opening an event by tapping its notification: the ViON integration for Home Assistant

## Settings

- **Home Assistant URL**: the address of your Home Assistant including the port
- **Access Token**: the long-lived access token
- **Excluded Entities**: comma-separated entity IDs that should not be offered for adding
