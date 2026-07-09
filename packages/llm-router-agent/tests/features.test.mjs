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

test('maps StepContext metadata into feature vector', () => {
  const features = extractFeatures({
    message: '/improve https://github.com/kingkillery/speech-to-speech/tree/main/scripts <--- using thisU',
    metadata: {
      stepContext: {
        stepKind: 'tool_call',
        stepRisk: 'high',
        stepIndex: 3,
        agentRole: 'improve-executor',
        recentFailures: 2,
        lastVerifier: 'fail',
        escalationCount: 1,
        estimatedCacheHit: false,
        providerAffinity: 'openai',
        remainingTokens: 4096,
      },
    },
  });

  assert.equal(features.stepKind, 'tool_call');
  assert.equal(features.stepRisk, 'high');
  assert.equal(features.stepIndex, 3);
  assert.equal(features.agentRole, 'improve-executor');
  assert.equal(features.recentFailures, 2);
  assert.equal(features.lastVerifier, 'fail');
  assert.equal(features.lastVerifierFailed, true);
  assert.equal(features.escalationCount, 1);
  assert.equal(features.estimatedCacheHit, false);
  assert.equal(features.providerAffinity, 'openai');
  assert.equal(features.remainingTokens, 4096);
  assert.ok(features.signals.includes('step:tool_call'));
  assert.ok(features.signals.includes('risk:high'));
  assert.ok(features.signals.includes('verifier-failed'));
  assert.ok(features.signals.includes('cache-miss'));
});
