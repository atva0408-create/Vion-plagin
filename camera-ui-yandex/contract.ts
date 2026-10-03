import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'Yandex',
  role: PluginRole.CameraAndSensorProvider,
  provides: [
    SensorType.Motion,
    SensorType.Contact,
    SensorType.Leak,
    SensorType.Smoke,
    SensorType.Gas,
    SensorType.Vibration,
    SensorType.Doorbell,
    SensorType.Temperature,
    SensorType.Humidity,
    SensorType.Illuminance,
    SensorType.CarbonDioxide,
    SensorType.Switch,
    SensorType.Light,
  ],
  consumes: [],
  interfaces: [PluginInterface.SensorDiscovery, PluginInterface.Notifier, PluginInterface.DiscoveryProvider, PluginInterface.AssistantTools],
};

export default contract;
