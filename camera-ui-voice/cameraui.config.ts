import type { CameraUiBuildOptions } from '@camera.ui/cli';

const mode = process.env.MODE || 'production';

const config: CameraUiBuildOptions = {
  input: ['src/index.ts'],
  mode: mode === 'development' ? 'development' : 'production',
  // native speech engine, installed with the plugin for the system it runs on (linux x64/arm64, macOS, Windows)
  external: ['sherpa-onnx-node'],
  additionalFiles: ['i18n'],
};

export default config;
