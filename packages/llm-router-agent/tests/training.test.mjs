import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTelemetryJsonl, trainRoutePredictorFromTelemetry } from '../dist/index.js';

test('trains route-predictor weights from decision and outcome telemetry', () => {
  const records = parseTelemetryJsonl([
    JSON.stringify({
      requestId: 'r1',
      timestamp: '2026-01-01T00:00:00.000Z',
      kind: 'decision',
      route: { selectedModel: 'quality', selector: '9router/quality', confidence: 0.8, taskType: 'coding', reasons: [], fallbackChain: ['balanced'] },
      features: { taskType: 'coding', approxInputTokens: 1000, approxOutputTokens: 500, totalTokenEstimate: 1500, hasCode: true, hasJsonRequirement: false, hasRetrievalNeed: false, hasMultimodalInput: false, reasoningComplexity: 0.7, safetySensitivity: 0.1, userTier: 'default', userPreference: 'quality', signals: [] },
      metrics: { success: true }
    })
  ].join('\n'));

  const result = trainRoutePredictorFromTelemetry(records, { epochs: 3, learningRate: 0.1 });
  assert.equal(result.examples, 2);
  assert.equal(result.role, 'route-predictor');
  assert.equal(result.tier, 'local-fast');
  assert.equal(result.executionRouter, 'unchanged');
  assert.equal(result.policy.enabled, true);
  assert.ok(result.models.includes('quality'));
  assert.ok(result.policy.modelWeights.quality['has.code'] > 0);
});
