import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneDefaultConfig, decisionTelemetry, extractFeatures, LLMRouter, readStepContextMetadata, stepContextToContextTrace, stepContextToMetadata, stepContextToRequestInput, writeTrace } from '../dist/index.js';

test('StepContext adapter preserves original RequestInput fields and adds metadata', () => {
  const request = {
    message: '/improve https://github.com/kingkillery/speech-to-speech/tree/main/scripts <--- using thisU',
    system: 'Use the improve workflow.',
    tags: ['audit', 'scripts'],
    user: { id: 'u1', tier: 'internal', preference: 'quality' },
    runtime: { latencyBudgetMs: 1500, queueDepth: 2 },
    metadata: { requestId: 'req-1', source: 'test' },
  };
  const original = structuredClone(request);

  const adapted = stepContextToRequestInput({
    request,
    step: { id: 'step-7', index: 7, kind: 'tool_call', agentRole: 'advisor', risk: 'medium', irreversible: false },
    trajectory: { conversationTurns: 4, recentFailures: 1, lastVerifier: 'uncertain', escalationCount: 2 },
    cache: { stablePrefixHash: 'prefix-123', estimatedCacheHit: true, providerAffinity: 'openai' },
    budgets: { latencyMs: 500, costUsd: 0.01, remainingTokens: 8192 },
  });

  assert.deepEqual(request, original);
  assert.equal(adapted.message, request.message);
  assert.equal(adapted.system, request.system);
  assert.deepEqual(adapted.tags, request.tags);
  assert.deepEqual(adapted.user, request.user);
  assert.equal(adapted.runtime.latencyBudgetMs, 1500);
  assert.equal(adapted.runtime.costBudgetUsd, 0.01);
  assert.equal(adapted.metadata.requestId, 'req-1');
  assert.equal(adapted.metadata.source, 'test');
  assert.deepEqual(adapted.metadata.stepContext, {
    stepId: 'step-7',
    stepIndex: 7,
    stepKind: 'tool_call',
    agentRole: 'advisor',
    stepRisk: 'medium',
    irreversible: false,
    conversationTurns: 4,
    recentFailures: 1,
    lastVerifier: 'uncertain',
    escalationCount: 2,
    stablePrefixHash: 'prefix-123',
    estimatedCacheHit: true,
    providerAffinity: 'openai',
    remainingTokens: 8192,
  });
});

test('StepContext metadata omits undefined fields', () => {
  const metadata = stepContextToMetadata({ request: { message: 'hello' }, step: {} });
  assert.deepEqual(metadata, {});
});

test('feature extraction maps StepContext metadata fields', () => {
  const features = extractFeatures({
    message: 'Operate this page and verify the form state.',
    metadata: {
      stepContext: {
        stepKind: 'browser',
        stepRisk: 'high',
        stepIndex: 4,
        agentRole: 'browser-operation',
        recentFailures: 2,
        lastVerifier: 'fail',
        escalationCount: 1,
        estimatedCacheHit: false,
        providerAffinity: 'openai-codex',
        remainingTokens: 9000,
      },
    },
  });

  assert.equal(features.stepKind, 'browser');
  assert.equal(features.stepRisk, 'high');
  assert.equal(features.stepIndex, 4);
  assert.equal(features.agentRole, 'browser-operation');
  assert.equal(features.recentFailures, 2);
  assert.equal(features.lastVerifier, 'fail');
  assert.equal(features.lastVerifierFailed, true);
  assert.equal(features.escalationCount, 1);
  assert.equal(features.estimatedCacheHit, false);
  assert.equal(features.providerAffinity, 'openai-codex');
  assert.equal(features.remainingTokens, 9000);
  assert.ok(features.signals.includes('step:browser'));
  assert.ok(features.signals.includes('risk:high'));
  assert.ok(features.signals.includes('verifier-failed'));
  assert.ok(features.signals.includes('cache-miss'));
});

test('decision telemetry records compact StepContext trace', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const input = stepContextToRequestInput({
    request: { message: 'Open http://127.0.0.1:9080/login and report fields.' },
    step: { index: 2, kind: 'browser', agentRole: 'browser-operation', risk: 'low', irreversible: false },
    trajectory: {
      conversationTurns: 7,
      recentToolCalls: [{ text: 'browser observe', tokenEstimate: 8, savedContextTokensEstimate: 20, keepFields: ['status'], droppedFields: ['html'] }],
      recentFailures: 1,
      lastVerifier: 'uncertain',
      escalationCount: 0,
    },
    cache: { stablePrefixHash: 'abc123', estimatedCacheHit: true, providerAffinity: 'openai-codex' },
  });

  const decision = router.decide(input);
  const record = decisionTelemetry(decision, {}, input);
  assert.equal(record.contextTrace.stepKind, 'browser');
  assert.equal(record.contextTrace.stepRisk, 'low');
  assert.equal(record.contextTrace.stepIndex, 2);
  assert.equal(record.contextTrace.agentRole, 'browser-operation');
  assert.equal(record.contextTrace.conversationTurns, 7);
  assert.equal(record.contextTrace.recentFailures, 1);
  assert.equal(record.contextTrace.lastVerifier, 'uncertain');
  assert.equal(record.contextTrace.recentToolCallCount, 1);
  assert.equal(record.contextTrace.estimatedCacheHit, true);
  assert.equal(record.contextTrace.stablePrefixHash, 'abc123');
  assert.equal(record.contextTrace.providerAffinity, 'openai-codex');
});

test('StepContext normalizer ignores malformed fields consistently', () => {
  const metadata = {
    stepContext: {
      stepKind: 'not-a-kind',
      stepRisk: 'critical',
      stepIndex: -4,
      agentRole: 123,
      irreversible: 'yes',
      conversationTurns: Number.NaN,
      recentToolCalls: 'not-an-array',
      recentFailures: -2,
      lastVerifier: 'maybe',
      escalationCount: 3,
      estimatedCacheHit: 'false',
      providerAffinity: 'openai',
      remainingTokens: 0,
    },
  };

  const normalized = readStepContextMetadata(metadata);
  assert.deepEqual(normalized, {
    stepIndex: 0,
    recentFailures: 0,
    escalationCount: 3,
    providerAffinity: 'openai',
    remainingTokens: 0,
  });
  assert.deepEqual(stepContextToContextTrace(metadata), {
    stepIndex: 0,
    recentFailures: 0,
    escalationCount: 3,
    providerAffinity: 'openai',
  });
  const features = extractFeatures({ message: 'Classify this request.', metadata });
  assert.equal(features.stepKind, undefined);
  assert.equal(features.stepRisk, undefined);
  assert.equal(features.escalationCount, 3);
  assert.ok(features.signals.includes('escalated'));
});

test('public surface exports StepContext trace helpers', () => {
  assert.equal(typeof readStepContextMetadata, 'function');
  assert.equal(typeof stepContextToContextTrace, 'function');
  assert.equal(typeof writeTrace, 'function');
});
