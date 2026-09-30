import { PluginCapability, PluginInterface, PluginRole } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'ViON NVR',
  role: PluginRole.Hub,
  provides: [],
  consumes: [],
  // AssistantTools: the archive for the assistant (src/assistant.ts)
  interfaces: [PluginInterface.NVR, PluginInterface.AssistantTools],
  capabilities: [PluginCapability.PublishNotifications],
};

export default contract;
