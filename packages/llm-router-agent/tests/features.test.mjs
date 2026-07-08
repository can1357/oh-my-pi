import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures } from '../dist/index.js';

test('detects coding and json requirements', () => {
  const features = extractFeatures({ message: 'Debug this TypeScript function and return strict JSON with fields summary and patch. ```ts\nconst x: string = 1\n```' });
  assert.equal(features.taskType, 'coding');
  assert.equal(features.hasCode, true);
  assert.equal(features.hasJsonRequirement, true);
  assert.ok(features.reasoningComplexity > 0.3);
});

test('detects simple translation as translation', () => {
  const features = extractFeatures({ message: 'Translate this sentence to French: The meeting moved to Friday.', user: { preference: 'speed' } });
  assert.equal(features.taskType, 'translation');
  assert.equal(features.userPreference, 'speed');
});
