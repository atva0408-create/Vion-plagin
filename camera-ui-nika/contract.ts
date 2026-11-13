import { PluginCapability, PluginInterface, PluginRole } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'NIKA',
  role: PluginRole.Service,
  provides: [],
  consumes: [],
  // a notifier: NIKA says the notices of VION; tools: the assistant sets the link up in words; publishing: a parent
  // is asked to confirm what NIKA was asked to allow
  interfaces: [PluginInterface.Notifier, PluginInterface.AssistantTools],
  capabilities: [PluginCapability.PublishNotifications],
};

export default contract;
