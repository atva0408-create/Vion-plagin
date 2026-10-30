## [0.2.2]

- A speech model of the door agent is no longer unloaded while a phrase is being said or recognized with it, and the objects of a recognition are kept until it ends
- The voice activity of the agent's listening is reset between phrases before the sample counters of sherpa-onnx overflow (2^31 samples, 37 hours), as in VOICE 0.5.5

## [0.2.1]

- The name is written VION

## [0.2.0]

- Rights per camera: a user limited to some cameras (Settings → Users) uses the panels of those cameras — their calls, doors, visits, guest codes and instructions — and nothing of the others; answering a call or speaking to a visitor needs the right to talk. Before, the server shut such a user out of the whole intercom, their own cameras' panels too. Every notice about a panel carries its camera, so the server tells only those who see it. Needs VION 2.6.15

## [0.1.0]

- First version: calls from door panels to the web interface and the phones (the first who answers gets the call), the door agent that talks to visitors by the owner's instructions, modes of the house, opening by a person, a rule of the people directory, a guest code or an instruction, with a door log, the archive of visits with filters and search, the assistant's tools. Panels: RUBITEK (Action URL, or SIP directly by IP), Dahua, Hikvision, any panel that calls an address, any camera with a doorbell; new models from the catalog
