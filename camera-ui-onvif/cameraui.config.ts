import type { CameraUiBuildOptions } from '@camera.ui/cli';

const mode = process.env.MODE || 'production';

const config: CameraUiBuildOptions = {
  input: ['src/index.ts'],
  mode: mode === 'development' ? 'development' : 'production',
  external: [],
  additionalFiles: ['i18n'],
};

export default config;
