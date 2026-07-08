import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput } from '../dist/index.js';

test('validates json schema required field', () => {
  const result = validateOutput('{"summary":"ok","confidence":0.9}', {
    requirements: [{ type: 'json', schema: { type: 'object', required: ['summary', 'confidence'] } }],
    onFailure: 'repair',
    maxAttempts: 1,
  });
  assert.equal(result.passed, true);
});

test('fails missing required field', () => {
  const result = validateOutput('{"summary":"ok"}', {
    requirements: [{ type: 'json', schema: { type: 'object', required: ['summary', 'confidence'] } }],
    onFailure: 'repair',
    maxAttempts: 1,
  });
  assert.equal(result.passed, false);
  assert.equal(result.recommendedAction, 'repair');
});
