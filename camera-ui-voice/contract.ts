import { PluginCapability, PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'VOICE',
  // a hub: reads the object and face sensors of the cameras, adds none of its own
  role: PluginRole.Hub,
  provides: [],
  consumes: [SensorType.Object, SensorType.Face],
  interfaces: [PluginInterface.Notifier, PluginInterface.AssistantTools],
  capabilities: [PluginCapability.PublishNotifications],
};

export default contract;
