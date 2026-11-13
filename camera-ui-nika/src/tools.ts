// i18n-skip-file: the descriptions below are read by the model of the assistant, not shown in the interface.
import { COMMAND_NAMES } from './commands.js';
import { GRANT_MODES } from './grants.js';

import type { AssistantToolSpec } from '@camera.ui/sdk';

const NIKA = { type: 'string', description: 'Name, room or id of a NIKA, as nika_status lists them; omit when there is one.' } as const;

export const ASSISTANT_TOOLS: AssistantToolSpec[] = [
  {
    name: 'nika_status',
    description:
      'NIKA, the voice assistant of the home, linked with VION: which NIKAs are connected (online or why not), which are found on the network and not ' +
      'connected, how permissions asked by voice are handled, what NIKA may ask VION, requests waiting for a parent, and the journal.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nika_connect',
    description:
      'Connect a NIKA to VION, in two calls: first with `nika` (one found on the network) or `address`; she says a 6-digit code aloud. Then ask the owner ' +
      'for the code and call again with only `code` (within 5 minutes).',
    inputSchema: {
      type: 'object',
      properties: { nika: NIKA, address: { type: 'string', description: 'Her address when she is not found, e.g. 192.168.1.50' }, code: { type: 'string' } },
      additionalProperties: false,
    },
    approval: true,
    adminOnly: true,
  },
  {
    name: 'nika_disconnect',
    description: 'Disconnect a NIKA: she and VION forget each other.',
    inputSchema: { type: 'object', properties: { nika: NIKA }, additionalProperties: false },
    approval: true,
    adminOnly: true,
  },
  {
    name: 'nika_settings',
    description:
      'Change how NIKA works with VION: `grants` confirm (a parent confirms what NIKA is asked to give, default) or direct (given at once, parents told); ' +
      '`commands` what NIKA may ask VION; `saysNotifications` whether a NIKA says VION notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        grants: { type: 'string', enum: GRANT_MODES },
        commands: { type: 'array', items: { type: 'string', enum: COMMAND_NAMES } },
        nika: NIKA,
        saysNotifications: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    approval: true,
    adminOnly: true,
  },
  {
    name: 'nika_answer',
    description: 'Answer a request NIKA was given (more time for a child), as a parent: allow or refuse. nika_status lists the requests. NIKA tells the room.',
    inputSchema: { type: 'object', properties: { request: { type: 'string' }, allow: { type: 'boolean' } }, required: ['request', 'allow'], additionalProperties: false },
    approval: true,
    adminOnly: true,
  },
  {
    name: 'nika_say',
    description: 'NIKA says a phrase aloud in her room.',
    inputSchema: { type: 'object', properties: { nika: NIKA, text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    approval: true,
    adminOnly: true,
  },
];
