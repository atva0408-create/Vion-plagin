import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'ViON Sensor',
  role: PluginRole.CameraAndSensorProvider,
  provides: [SensorType.Motion],
  consumes: [],
  interfaces: [PluginInterface.SensorDiscovery, PluginInterface.DiscoveryProvider],
};

export default contract;
