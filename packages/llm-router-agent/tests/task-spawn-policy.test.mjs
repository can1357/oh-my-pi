import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneDefaultConfig } from '../dist/defaults.js';
import { normalizeConfig, validateRouterConfig } from '../dist/config.js';
import { createTaskSpawnPolicy, isTaskSpawnEnabled } from '../dist/task-spawn-policy.js';

function baseCandidates() {
  return [
    { selector: 'pi/smol', tier: 'light', maxRequests: 8, maxRuntimeMs: 30_000 },
    { selector: 'pi/task', tier: 'mid', maxRequests: 6, maxRuntimeMs: 60_000 },
    { selector: 'pi/slow', tier: 'frontier', maxRequests: 4, maxRuntimeMs: 120_000 },
  ];
}

function input(overrides = {}) {
  return {
    correlationId: 'corr-1',
    agentName: 'explore',
    assignment: 'SECRET_ASSIGNMENT_DO_NOT_LOG',
    workClass: 'mechanical',
    autonomy: 'bound',
    eligible: baseCandidates(),
    fusionSidekick: false,
    manualModelSelection: false,
    ...overrides,
  };
}

function enabledConfig(overrides = {}) {
  const { telemetryPath, ...taskSpawnOverrides } = overrides;
  const config = cloneDefaultConfig();
  config.taskSpawn = {
    enabled: true,
    endpoint: 'http://127.0.0.1:8901/v1/chat/completions',
    timeoutMs: 250,
    systemPrompt: 'Answer with exactly one of: light, mid, heavy.',
    labelMappings: { light: 'light', mid: 'mid', heavy: 'frontier' },
    ...taskSpawnOverrides,
  };
  normalizeConfig(config);
  if (telemetryPath) {
    config.telemetry = { enabled: true, sampleRate: 1, path: telemetryPath };
  } else {
    config.telemetry = { enabled: false };
  }
  return config;
}

function jsonResponse(label, status = 200) {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content: label } }] }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

async function readTelemetry(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('taskSpawn.enabled defaults false and is the sole enable flag', () => {
  const missing = normalizeConfig(cloneDefaultConfig());
  assert.equal(missing.taskSpawn.enabled, false);
  assert.equal(isTaskSpawnEnabled(missing), false);

  const explicit = normalizeConfig(cloneDefaultConfig());
  explicit.taskSpawn = { enabled: false };
  normalizeConfig(explicit);
  assert.equal(isTaskSpawnEnabled(explicit), false);
});

test('validateRouterConfig checks endpoint, timeout bounds, and label mappings', () => {
  const config = cloneDefaultConfig();
  config.taskSpawn = {
    enabled: true,
    endpoint: 'not-a-url',
    timeoutMs: 0,
    systemPrompt: '',
    labelMappings: { light: 'light', mid: 'mid', heavy: 'nope' },
  };
  const errors = validateRouterConfig(config);
  assert.ok(errors.some((e) => e.includes('taskSpawn.endpoint')));
  assert.ok(errors.some((e) => e.includes('taskSpawn.timeoutMs')));
  assert.ok(errors.some((e) => e.includes('taskSpawn.systemPrompt')));
  assert.ok(errors.some((e) => e.includes('taskSpawn.labelMappings.heavy')));
});

test('disabled config performs zero fetches, no assignment telemetry, unchanged budgets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-router-spawn-disabled-'));
  const telemetryPath = join(dir, 'telemetry.jsonl');
  try {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async () => {
      calls.push(1);
      return jsonResponse('heavy');
    });

    const config = cloneDefaultConfig();
    config.telemetry = { enabled: true, sampleRate: 1, path: telemetryPath };
    normalizeConfig(config);
    assert.equal(isTaskSpawnEnabled(config), false);

    const policy = createTaskSpawnPolicy(config);
    const result = await policy(input());
    assert.equal(result.allow, true);
    assert.equal(result.candidateSelectors, undefined);
    assert.equal(result.maxRequests, undefined);
    assert.equal(result.maxRuntimeMs, undefined);
    assert.equal(calls.length, 0);

    const records = await readTelemetry(telemetryPath);
    assert.equal(records.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enabled policy performs one classifier call and narrows by label mapping', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-router-spawn-one-'));
  const telemetryPath = join(dir, 'telemetry.jsonl');
  try {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse('light');
    });

    const policy = createTaskSpawnPolicy(enabledConfig({ telemetryPath }));
    const result = await policy(input({ agentName: 'quick_task' }));
    assert.equal(calls.length, 1);
    assert.equal(result.allow, true);
    assert.equal(result.routeLabel, 'light');
    assert.deepEqual(result.candidateSelectors, ['pi/smol']);
    assert.equal(result.maxRequests, 8);
    assert.equal(result.maxRuntimeMs, 30_000);

    const records = await readTelemetry(telemetryPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'task_spawn');
    assert.equal(records[0].metadata.surface, 'task_spawn');
    assert.equal(records[0].metadata.agentName, 'quick_task');
    assert.equal(records[0].metadata.correlationId, 'corr-1');
    assert.equal(records[0].metadata.workClass, 'mechanical');
    assert.equal(records[0].metadata.autonomy, 'bound');
    assert.equal(records[0].metadata.routeLabel, 'light');
    assert.equal(records[0].metadata.classifierSource, 'classifier');
    assert.equal(records[0].metadata.appliedNarrowing, true);
    assert.equal(JSON.stringify(records[0]).includes('SECRET_ASSIGNMENT_DO_NOT_LOG'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('candidate intersection preserves order and never adds ineligible selectors', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse('heavy'));
  const policy = createTaskSpawnPolicy(enabledConfig());
  const result = await policy(
    input({
      eligible: [
        { selector: 'pi/slow', tier: 'frontier', maxRequests: 3, maxRuntimeMs: 90_000 },
        { selector: 'pi/task', tier: 'mid', maxRequests: 5, maxRuntimeMs: 50_000 },
        { selector: 'pi/max', tier: 'frontier', maxRequests: 2, maxRuntimeMs: 80_000 },
      ],
    }),
  );
  assert.deepEqual(result.candidateSelectors, ['pi/slow', 'pi/max']);
  assert.equal(result.maxRequests, 2);
  assert.equal(result.maxRuntimeMs, 80_000);
});

test('no-mid fallback preserves deterministic eligible default', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse('???') );
  const policy = createTaskSpawnPolicy(enabledConfig());
  const eligible = [
    { selector: 'pi/smol', tier: 'light', maxRequests: 8, maxRuntimeMs: 30_000 },
    { selector: 'pi/slow', tier: 'frontier', maxRequests: 4, maxRuntimeMs: 120_000 },
  ];
  const result = await policy(input({ eligible }));
  assert.equal(result.routeLabel, 'mid');
  assert.equal(result.allow, true);
  assert.deepEqual(result.candidateSelectors, ['pi/smol', 'pi/slow']);
  assert.match(result.reasonCode, /fallback|malformed|preserve/);
});

test('judgment floor rejects light-only eligibility before fetch', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async () => {
    calls.push(1);
    return jsonResponse('mid');
  });
  const policy = createTaskSpawnPolicy(enabledConfig());
  const result = await policy(
    input({
      workClass: 'judgment',
      eligible: [{ selector: 'pi/smol', tier: 'light', maxRequests: 8, maxRuntimeMs: 30_000 }],
    }),
  );
  assert.equal(result.allow, false);
  assert.equal(result.reasonCode, 'judgment_floor');
  assert.equal(calls.length, 0);
});

test('judgment floor raises classifier light to mid and intersects', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse('light'));
  const policy = createTaskSpawnPolicy(enabledConfig());
  const result = await policy(input({ workClass: 'judgment' }));
  assert.equal(result.allow, true);
  assert.equal(result.routeLabel, 'mid');
  assert.deepEqual(result.candidateSelectors, ['pi/task']);
  assert.equal(result.reasonCode, 'judgment_floor');
});

test('sticky deny for empty eligibility', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async () => {
    calls.push(1);
    return jsonResponse('mid');
  });
  const policy = createTaskSpawnPolicy(enabledConfig());
  const result = await policy(input({ eligible: [] }));
  assert.equal(result.allow, false);
  assert.equal(result.reasonCode, 'no_eligible_candidates');
  assert.equal(calls.length, 0);
});

test('Fusion warm-sidekick and manual model selection skip classifier', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async () => {
    calls.push(1);
    return jsonResponse('heavy');
  });
  const policy = createTaskSpawnPolicy(enabledConfig());

  const fusion = await policy(input({ fusionSidekick: true }));
  assert.equal(fusion.allow, true);
  assert.equal(fusion.candidateSelectors, undefined);
  assert.equal(fusion.reasonCode, 'skip_fusion_sidekick');

  const manual = await policy(input({ manualModelSelection: true }));
  assert.equal(manual.allow, true);
  assert.equal(manual.candidateSelectors, undefined);
  assert.equal(manual.reasonCode, 'skip_manual_model_selection');
  assert.equal(calls.length, 0);
});

test('budget minima only decrease via selected candidates', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse('mid'));
  const policy = createTaskSpawnPolicy(enabledConfig());
  const result = await policy(
    input({
      eligible: [
        { selector: 'a', tier: 'mid', maxRequests: 9, maxRuntimeMs: 40_000 },
        { selector: 'b', tier: 'mid', maxRequests: 3, maxRuntimeMs: 70_000 },
        { selector: 'c', tier: 'light', maxRequests: 1, maxRuntimeMs: 10_000 },
      ],
    }),
  );
  assert.deepEqual(result.candidateSelectors, ['a', 'b']);
  assert.equal(result.maxRequests, 3);
  assert.equal(result.maxRuntimeMs, 40_000);
});

test('caller abort before/during policy propagates and never returns fallback', async (t) => {
  const policy = createTaskSpawnPolicy(enabledConfig());
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    () => policy(input(), before.signal),
    (error) => error && error.name === 'AbortError',
  );

  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    await new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
  const during = new AbortController();
  const pending = policy(input(), during.signal);
  during.abort();
  await assert.rejects(() => pending, (error) => error && error.name === 'AbortError');
});
