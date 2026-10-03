import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Xiaomi',
  role: PluginRole.CameraController,
  provides: [SensorType.PTZ],
  consumes: [],
  interfaces: [PluginInterface.DiscoveryProvider],
};

export default contract;
