// MIoT descriptions of cameras for the specs: a model with a zoom lens and the C300, a motor without one.
import type { MiotSpec } from '../src/xiaomi/spec.js';

export const RW = ['read', 'write', 'notify'];

/** A camera with an optical zoom, a digital zoom, focus actions and autofocus, as a spec of such a model reads. */
export const ZOOM_CAMERA: MiotSpec = {
  type: 'urn:miot-spec-v2:device:camera:0000A01C:xiaomi-zoom01:1',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:camera-control:0000781B:xiaomi-zoom01:1',
      properties: [
        { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:xiaomi-zoom01:1', format: 'bool', access: RW },
        { iid: 7, type: 'urn:xiaomi-spec:property:digital-zoom:00000007:xiaomi-zoom01:1', format: 'uint8', access: RW, 'value-range': [10, 90, 1] },
      ],
    },
    {
      iid: 9,
      type: 'urn:xiaomi-spec:service:lens:00007801:xiaomi-zoom01:1',
      description: 'Lens',
      properties: [
        {
          iid: 1,
          type: 'urn:xiaomi-spec:property:optical-zoom:00000001:xiaomi-zoom01:1',
          description: 'Optical Zoom',
          format: 'uint8',
          access: RW,
          'value-range': [1, 30, 1],
        },
        { iid: 2, type: 'urn:xiaomi-spec:property:zoom-status:00000002:xiaomi-zoom01:1', format: 'uint8', access: ['read'], 'value-range': [0, 100, 1] },
      ],
      actions: [
        { iid: 1, type: 'urn:xiaomi-spec:action:focus-near:00002801:xiaomi-zoom01:1', description: 'Focus Near', in: [] },
        { iid: 2, type: 'urn:xiaomi-spec:action:focus-far:00002802:xiaomi-zoom01:1', description: 'Focus Far', in: [] },
        { iid: 3, type: 'urn:xiaomi-spec:action:auto-focus:00002803:xiaomi-zoom01:1', description: 'Auto Focus', in: [] },
      ],
    },
  ],
};

/** The C300: a motor, no lens to drive. */
export const C300: MiotSpec = {
  type: 'urn:miot-spec-v2:device:camera:0000A01C:xiaomi-c01a01:1',
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:camera-control:0000781B:xiaomi-c01a01:1',
      properties: [
        { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:xiaomi-c01a01:1', format: 'bool', access: RW },
        { iid: 6, type: 'urn:miot-spec-v2:property:motion-tracking:00000025:xiaomi-c01a01:1', format: 'bool', access: RW },
      ],
    },
  ],
};
