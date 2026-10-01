// The model may be announced as seeing only when the helper really passes pictures on (macOS 27).
// Run: node --experimental-strip-types --test spec/vision.spec.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { takesPictures } from '../src/model.ts';

test('macOS 27 helper (reports the context size) takes pictures', () => {
  assert.equal(takesPictures({ available: true, contextSize: 8192 }), true);
});

test('macOS 26 helper (no context size in its status) does not', () => {
  assert.equal(takesPictures({ available: true }), false);
});

test('a model that is not available does not, whatever the status says', () => {
  assert.equal(takesPictures({ available: false, contextSize: 8192 }), false);
  assert.equal(takesPictures({ available: false }), false);
});
