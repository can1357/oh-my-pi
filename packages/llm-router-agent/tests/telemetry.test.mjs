import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLMRouter, cloneDefaultConfig, decisionTelemetry, stepContextToRequestInput, writeTelemetry } from '../dist/index.js';

test('telemetry persists compact StepContext trace', async () => {
  const request = stepContextToRequestInput({
    request: {
      message: '/improve https://github.com/kingkillery/speech-to-speech/tree/main/scripts <--- using thisU',
      metadata: { requestId: 'req-step-1' },
    },
    step: { id: 'step-1', index: 1, kind: 'tool_call', agentRole: 'improve-advisor', risk: 'high', irreversible: true },
    trajectory: {
      conversationTurns: 6,
      recentFailures: 2,
      lastVerifier: 'fail',
      escalationCount: 1,
      recentToolCalls: [{ text: 'read scripts tree', tokenEstimate: 12, savedContextTokensEstimate: 80, keepFields: ['text'], droppedFields: ['raw'] }],
    },
    cache: { stablePrefixHash: 'prefix-hash', estimatedCacheHit: false, providerAffinity: 'openai' },
    budgets: { remainingTokens: 4096 },
  });
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide(request);
  const record = decisionTelemetry(decision, { source: 'telemetry-test' }, request);
  const dir = await mkdtemp(join(tmpdir(), 'llm-router-step-'));
  const telemetryPath = join(dir, 'telemetry.jsonl');

  try {
    await writeTelemetry({ ...cloneDefaultConfig(), telemetry: { enabled: true, sampleRate: 1, path: telemetryPath } }, record);
    const persisted = JSON.parse((await readFile(telemetryPath, 'utf8')).trim());

    assert.equal(persisted.contextTrace.stepKind, 'tool_call');
    assert.equal(persisted.contextTrace.stepRisk, 'high');
    assert.equal(persisted.contextTrace.stepIndex, 1);
    assert.equal(persisted.contextTrace.agentRole, 'improve-advisor');
    assert.equal(persisted.contextTrace.irreversible, true);
    assert.equal(persisted.contextTrace.conversationTurns, 6);
    assert.equal(persisted.contextTrace.recentFailures, 2);
    assert.equal(persisted.contextTrace.lastVerifier, 'fail');
    assert.equal(persisted.contextTrace.escalationCount, 1);
    assert.equal(persisted.contextTrace.recentToolCallCount, 1);
    assert.equal(persisted.contextTrace.estimatedCacheHit, false);
    assert.equal(persisted.contextTrace.stablePrefixHash, 'prefix-hash');
    assert.equal(persisted.contextTrace.providerAffinity, 'openai');
    assert.equal('recentToolCalls' in persisted.contextTrace, false);
    assert.equal('stepContext' in persisted.metadata, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
