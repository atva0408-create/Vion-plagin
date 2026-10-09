import { PluginInterface, PluginRole, SensorType } from '@camera.ui/sdk';

import type { PluginContract } from '@camera.ui/sdk';

export const contract: PluginContract = {
  name: 'ONNX',
  role: PluginRole.SensorProvider,
  provides: [
    SensorType.Object,
    SensorType.Face,
    SensorType.FaceEmbedder,
    SensorType.LicensePlate,
    SensorType.Clip,
    SensorType.Classifier,
    SensorType.PersonEmbedder,
    SensorType.Segmenter,
  ],
  consumes: [],
  pythonVersion: '3.11',
  interfaces: [
    PluginInterface.ObjectDetection,
    PluginInterface.FaceDetection,
    PluginInterface.FaceEmbedding,
    PluginInterface.LicensePlateDetection,
    PluginInterface.ClipDetection,
    PluginInterface.PersonEmbedding,
    PluginInterface.Segmentation,
  ],
};

export default contract;
