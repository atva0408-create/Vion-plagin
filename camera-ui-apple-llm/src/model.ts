export const MODEL_ID = 'apple-on-device';
export const MODEL_NAME = 'Apple on-device';
export const CONTEXT_TOKENS = 8192;
export const RECHECK_MS = 30_000;

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string', description: 'The answer, in the language of the question' } },
  required: ['answer'],
} as const;

/**
 * Whether the helper hands pictures to the model. Only its macOS 27 code does (helper/main.swift), and only that
 * code reports `contextSize` in its status. On macOS 26 the pictures were dropped without a word while the model was
 * announced as seeing: asked to describe an event, it made a description up from the detector's labels.
 */
export function takesPictures(status: { available: boolean; contextSize?: number }): boolean {
  return status.available && status.contextSize !== undefined;
}

export function unavailableReason(reason: string): string {
  switch (reason) {
    case 'license':
      return 'the Apple Foundation Models license is not agreed yet, run "sudo fm license" on this Mac';
    case 'deviceNotEligible':
      return 'this Mac does not support Apple Intelligence';
    case 'appleIntelligenceNotEnabled':
      return 'Apple Intelligence is off in the system settings';
    case 'modelNotReady':
      return 'macOS is still downloading the model';
    default:
      return reason || 'reason unknown';
  }
}
