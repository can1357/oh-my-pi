import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySpawnDifficulty } from '../dist/qwen-client.js';
import { normalizeRouteLabel } from '../dist/validation.js';

const CONFIG = {
  endpoint: 'http://127.0.0.1:8901/v1/chat/completions',
  timeoutMs: 250,
  systemPrompt: 'Answer with exactly one of: light, mid, heavy.',
};

function jsonResponse(label, status = 200) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: label } }],
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

test('normalizeRouteLabel accepts exact light|mid|heavy only', () => {
  assert.equal(normalizeRouteLabel(' light '), 'light');
  assert.equal(normalizeRouteLabel('MID'), 'mid');
  assert.equal(normalizeRouteLabel('Heavy\n'), 'heavy');
  assert.equal(normalizeRouteLabel('medium'), undefined);
  assert.equal(normalizeRouteLabel(''), undefined);
});

test('classifySpawnDifficulty returns exact classifier labels', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse('light');
  });

  const result = await classifySpawnDifficulty('Fix a typo.', CONFIG);
  assert.equal(result.label, 'light');
  assert.equal(result.source, 'classifier');
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(calls.length, 1);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 4);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].content, 'Fix a typo.');
});

test('malformed body falls back to mid', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{not-json', { status: 200 }));
  const result = await classifySpawnDifficulty('x', CONFIG);
  assert.equal(result.label, 'mid');
  assert.equal(result.source, 'fallback');
  assert.equal(result.reason, 'classifier_malformed');
});

test('invalid label falls back to mid', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse('maybe'));
  const result = await classifySpawnDifficulty('x', CONFIG);
  assert.equal(result.label, 'mid');
  assert.equal(result.source, 'fallback');
  assert.equal(result.reason, 'classifier_malformed');
});

test('non-2xx falls back to mid', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse('light', 503));
  const result = await classifySpawnDifficulty('x', CONFIG);
  assert.equal(result.label, 'mid');
  assert.equal(result.source, 'fallback');
  assert.equal(result.reason, 'classifier_http_error');
});

test('TLS/network failure falls back to mid', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('unable to verify the first certificate (TLS)');
  });
  const result = await classifySpawnDifficulty('x', CONFIG);
  assert.equal(result.label, 'mid');
  assert.equal(result.source, 'fallback');
  assert.equal(result.reason, 'classifier_tls_error');
});

test('internal timeout falls back to mid', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    await new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
  const result = await classifySpawnDifficulty('x', { ...CONFIG, timeoutMs: 20 });
  assert.equal(result.label, 'mid');
  assert.equal(result.source, 'fallback');
  assert.equal(result.reason, 'classifier_timeout');
});

test('caller abort before classification propagates and does not fall back', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => classifySpawnDifficulty('secret assignment', CONFIG, controller.signal),
    (error) => error && error.name === 'AbortError',
  );
});

test('caller abort during classification propagates and does not fall back', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    await new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
  const pending = classifySpawnDifficulty('secret assignment', { ...CONFIG, timeoutMs: 5_000 }, controller.signal);
  controller.abort();
  await assert.rejects(() => pending, (error) => error && error.name === 'AbortError');
});
