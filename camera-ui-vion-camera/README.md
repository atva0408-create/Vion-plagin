# VION Camera

The plugin of the VION smart camera. The camera announces itself in the network («_vion-camera._tcp»), so it appears in **Cameras → Found**; one press adds it. Adding pairs the camera with this VION: it gives VION a token and the password of its RTSP streams, and answers no other VION until it is removed here or reset with its button.

- **Streams.** The main stream (H.265 on the camera boards that encode it) for the recording and the full view, the sub stream (H.264, small) for the views of many cameras and the phone.
- **Not found by itself?** Type its address in the plugin settings, e.g. `192.168.1.60`.
- **Health.** VION checks every camera every 30 s and says once when one stops answering or loses its picture, and once when it is back.

Object detection on the camera itself comes in the next versions.
