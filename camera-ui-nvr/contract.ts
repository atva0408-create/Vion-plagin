import { PluginCapability, PluginInterface, PluginRole } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'ViON NVR',
  role: PluginRole.Hub,
  provides: [],
  consumes: [],
  interfaces: [PluginInterface.NVR],
  capabilities: [PluginCapability.PublishNotifications],
};

export default contract;
