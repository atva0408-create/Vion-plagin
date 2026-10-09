/**
 * Speech of ViON plugins, on the server and without a cloud: synthesis, recognition and voice activity (sherpa-onnx),
 * the camera's speaker (G.711 A-law RTP into its talk channel), listening through ffmpeg, the speech models from the
 * ViON mirror, and the checks of what was said and heard. VOICE and the intercom bundle it; it is not published.
 */
export * from './clock.js';
export * from './engine.js';
export * from './language.js';
export * from './listen.js';
export * from './models.js';
export * from './queue.js';
export * from './speaker.js';
export * from './text.js';
