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
