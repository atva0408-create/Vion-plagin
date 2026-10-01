# SMTP

Turns the email a camera sends on motion into a motion event in ViON. The plugin runs a small mail server that the camera sends its alerts to.

## What it does

- Receives the alert emails of your cameras directly on the ViON server, without an outside mail service
- Gives each camera a motion sensor with its own email address; a message to that address reports motion
- Can count only emails that contain a certain text as motion
- Can end the motion when a message with another text arrives
- Accepts any username and password from the camera, so no mailbox has to be created

## What you need

- A camera that can send an email when it detects motion
- In the camera's email settings: the ViON server as mail server (SMTP), the port set in this plugin, and as recipient the address entered for that camera in ViON

## Settings

Plugin:

- **Port**: the port the mail server listens on, 25 by default
- **Disable TLS**: switch on for cameras that do not support an encrypted connection (STARTTLS)

Motion sensor of each camera:

- **Email Address**: the recipient address that stands for this camera; name and domain can be anything
- **Motion On Text**: text the message body must contain to report motion. Leave empty to report motion on any email
- **Motion Off Text**: text in the message body that ends the motion
