import { PluginCapability, PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Intercom',
  // a panel with a driver (RUBITEK, Dahua, Hikvision) gets this plugin's own doorbell and lock on the panel's camera,
  // so automations, the recorder, HomeKit and the floor plan see it like any doorbell; that takes a sensor provider
  role: PluginRole.SensorProvider,
  provides: [SensorType.Doorbell, SensorType.Lock],
  // other panels: their doorbells, locks, relays and door contacts; who is at the door: objects, faces, plates
  consumes: [
    SensorType.Doorbell,
    SensorType.Lock,
    SensorType.Switch,
    SensorType.Contact,
    SensorType.Object,
    SensorType.Face,
    SensorType.LicensePlate,
  ],
  interfaces: [PluginInterface.AssistantTools],
  capabilities: [PluginCapability.PublishNotifications],
};

export default contract;
