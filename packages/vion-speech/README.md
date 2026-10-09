# @vionvision/speech

Speech of ViON plugins on the server, without a cloud. Shared by **VOICE** (`camera-ui-voice`) and the **intercom**
(`camera-ui-intercom`); each bundles it (`file:` dev dependency, esbuild inlines it), it is never published.

| Module | What |
|---|---|
| `engine.ts` | `SherpaEngine`: synthesis (Piper voices), recognition (zipformer ru, Whisper en/de), Silero VAD; models load on first use and are let go after 3 idle minutes. The plugin passes the loader of `sherpa-onnx-node`, installed with the plugin |
| `models.ts` | the model packs on `<VION_MODELS_HOST>/v1/voice/`, downloaded once, checked by size and sha256, unpacked as they stream |
| `speaker.ts` | `CameraSpeaker`: PCM → G.711 A-law → RTP, 20 ms packets at the pace of real time, into the camera's talk channel |
| `listen.ts` | `FfmpegListener` (one answer in a window, VOICE), `Hearing` and `listenToCamera` (a conversation, the intercom) |
| `queue.ts` | `PhraseQueue`: one phrase at a time per camera, a limit a minute |
| `text.ts` | `isEcho`, `foreignNumber` (numbers of an LLM phrase that the facts do not have), `spokenDigits` (a code said as words) |

Licenses of the models and of the engine: `docs/VOICE_IMPLEMENTATION.md` in the ViON repository.

Checks: `npm install`, `npm run build` (types), `npm run lint`, `npm test`.
