import { PluginInterface, PluginRole } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Telegram',
  role: PluginRole.Service,
  provides: [],
  consumes: [],
  interfaces: [PluginInterface.Notifier],
};

export default contract;
