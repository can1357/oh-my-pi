import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMRouter, cloneDefaultConfig } from '../dist/index.js';

test('routes safety-sensitive prompt to safe profile', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide({ message: 'This involves a legal contract and private customer data. Analyze risk carefully.' });
  assert.equal(decision.selectedModel, 'safe');
  assert.ok(decision.ruleMatches.includes('safety-sensitive'));
});

test('routes speed-preference simple translation to fast profile', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide({ message: 'Translate hello world to Spanish.', user: { preference: 'speed' } });
  assert.equal(decision.selectedModel, 'fast');
  assert.ok(decision.fallbackChain.includes('balanced'));
});

test('routes high-complexity coding toward coding or quality profile', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide({ message: 'Architect and implement a TypeScript refactor with tests, edge cases, and rollback plan. ```ts\nexport function f(x:any){return x}\n```' });
  assert.ok(['coding', 'quality'].includes(decision.selectedModel));
  assert.ok(decision.validationPlan.requirements.some(r => r.type === 'non_empty'));
});

test('routes simple route-predictor work to local_fast through 9router', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide({ message: 'Classify this prompt as speed or quality.', user: { preference: 'speed' } });
  assert.equal(decision.selectedModel, 'local_fast');
  assert.equal(decision.selector, '9router/local-fast');
  assert.ok(decision.fallbackSelectors.every(selector => selector.startsWith('9router/') || selector === 'pi/smol'));
});

test('routes high-risk StepContext to quality profile', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide({
    message: 'Classify this prompt as speed or quality.',
    user: { preference: 'speed' },
    metadata: { stepContext: { stepRisk: 'high', stepKind: 'tool_call' } },
  });

  assert.equal(decision.selectedModel, 'quality');
  assert.ok(decision.ruleMatches.includes('high-risk-agent-step'));
});

test('routes failed verifier StepContext away from local_fast', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide({
    message: 'Classify this prompt as speed or quality.',
    user: { preference: 'speed' },
    metadata: { stepContext: { lastVerifier: 'fail', recentFailures: 1 } },
  });

  assert.equal(decision.selectedModel, 'quality');
  assert.ok(decision.ruleMatches.includes('failed-agent-step-retry'));
  assert.ok(decision.ruleMatches.includes('recent-agent-failure-retry'));
});

test('routes irreversible StepContext to safe profile', () => {
  const router = new LLMRouter(cloneDefaultConfig());
  const decision = router.decide({
    message: 'Prepare the terminal operation.',
    metadata: { stepContext: { irreversible: true, stepKind: 'tool_call' } },
  });

  assert.equal(decision.selectedModel, 'safe');
  assert.ok(decision.ruleMatches.includes('irreversible-agent-step'));
});
