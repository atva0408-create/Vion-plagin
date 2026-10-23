## [0.2.5]

- A short outage of Yandex Passport while the session of the app is renewed no longer erases the sign-in as the Yandex app: only a token or an account Yandex refuses asks to sign in again, an outage is tried again at the next reading
- One failed reading of the official API (a DNS hiccup) no longer makes every sensor unavailable: three readings failing in a row do, and the first that works brings them back

## [0.2.4]

- Two texts a few seconds apart to a station whose kept connection died no longer open two new connections, one of them left open for good; signing out or changing the settings while the connection is checked sends nothing more
- With the voice in the home network only, a station that did not confirm a text is tried again at the next notification instead of being refused for 3 minutes

## [0.2.3]

- ViON learns whether each station said a notification: one that is off, offline, not signed in or that Yandex did not answer is told back, and ViON 2.6.5 sends the notification another way (a zone rule's notice to Telegram). Before, a station that did not speak was counted as one that did
- A station Yandex counts as offline is not asked: it took 5 s at home and 15 s in the cloud to fail
- A text the station got in the home network and did not confirm is not said again through the cloud: the station could say it twice
- A station that did not confirm a text is not asked in the home network for 3 minutes: the next notifications go through the cloud, which tells whether it spoke
- A connection to a station kept from before is checked with a ping first: a dead one (the station restarted, the Wi-Fi dropped) no longer swallows every notification until it closes
- A station offline in a list read over a minute ago is looked up again before a notification is refused to it
- The network failing before the cloud scenario ran («fetch failed: other side closed») is tried once more after 2 s; after the scenario was asked to run, never
- ViON's assistant sees whether a station is online

## [0.2.2]

- A station speaks notifications again. Through the home network: a station that names its link-local address (169.254.x.x) first is reached on its home network address, the link-local one timed out. Through the cloud: the token of the Smart Home is read from yandex.ru/iot, yandex.ru/quasar hangs up without an answer

## [0.2.1]

- The assistant: a phrase said on a station, a command to Alice and a scenario of the Smart Home are an admin's and ask for approval in the chat, so neither a user nor a schedule nor Alice can make a station say something

## [0.2.0]

- Air conditioners, TVs and IR remotes: the mode, temperature and fan of an air conditioner, the volume, channel, input and mute of a TV and the learned buttons of an IR remote are in the settings of their switch in ViON. A remote of buttons only becomes a switch of its own that holds them
- The sign-in as the Yandex app by link in the browser: a button next to the link opens the Yandex page that confirms the sign-in, so a browser signed in to Yandex needs no phone. The QR code for the phone stays, smaller, and the window explains both ways. Needs ViON 2.3.4

## [0.1.0]

- First version: sensors, relays, lights and scenarios of the Yandex Smart Home in ViON, sign-in to the official API and by QR code, notifications said by the stations you turn on, assistant tools, cameras of the Smart Home
