# Apple LLM

Offers the language model built into your Mac to the ViON assistant. The model answers on the Mac where the plugin runs: no key is needed and nothing is sent to a cloud.

## What it does

- Adds Apple's on-device model to the models you can choose in the assistant settings.
- The assistant can look up events, cameras and sensors through this model.
- Answers arrive word by word, and a cancelled question stops the model at once.
- On macOS 27 the model also looks at the pictures of events.
- Everything stays on the Mac: no account, no key, no cloud.

## What you need

- A Mac with Apple Silicon and macOS 26 or newer, with ViON running on it.
- Apple Intelligence turned on in the system settings of the Mac. While macOS is still downloading the model, ViON does not offer it yet.
- macOS 27 if the model is to see pictures.

## Settings

- "Ask for structured answers": Apple refuses plain answers about people at doors, gates and windows. With this on, the model does answer such questions.
- "Relaxed safety filter": the model refuses fewer everyday camera scenes.
- "Context window (tokens)": raise it after a system update that brings a larger window.
- "Let the model use tools": when off, the model only chats and cannot look up events, cameras or sensors.
- "Send pictures to the model": works on macOS 27 only.
