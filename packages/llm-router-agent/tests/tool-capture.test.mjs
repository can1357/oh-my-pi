import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureToolUse,
  cloneDefaultConfig,
  createToolUseCaptureRecord,
  exportToolRoutingExamplesFromTelemetry,
  summarizeToolUseTelemetry,
  ToolUseCaptureLayer,
} from '../dist/index.js';

test('tool capture redacts sensitive keys and creates context-saving summary', () => {
  const config = cloneDefaultConfig();
  const record = createToolUseCaptureRecord(config, {
    requestId: 'req_test',
    toolCallId: 'tool_test',
    toolName: 'web.search_query',
    phase: 'completed',
    args: { query: 'contract renewal pricing', token: 'should-not-survive' },
    result: { url: 'https://example.com/report', body: 'important '.repeat(600) },
    latencyMs: 42,
  });

  assert.equal(record.requestId, 'req_test');
  assert.equal(record.features.status, 'success');
  assert.equal(record.features.hasUrl, true);
  assert.equal(record.args?.redacted, true);
  assert.ok(!(record.args?.preview ?? '').includes('should-not-survive'));
  assert.ok(record.contextSummary.text.includes('web.search_query'));
  assert.ok(record.contextSummary.savedContextTokensEstimate > 0);
  assert.equal(record.trainingHint?.contextPolicy, 'drop_raw_result_keep_summary');
});

test('tool capture writes JSONL and exports tool-routing examples', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-router-tooluse-'));
  try {
    const inputPath = join(dir, 'tool-use.jsonl');
    const outputPath = join(dir, 'training.jsonl');
    const config = cloneDefaultConfig();
    config.toolCapture = { ...(config.toolCapture ?? { enabled: true }), enabled: true, path: inputPath, sampleRate: 1 };

    await captureToolUse(config, {
      requestId: 'req_1',
      toolCallId: 'tool_1',
      toolName: 'file_search.msearch',
      phase: 'completed',
      args: { queries: ['pet policy lease'], source_filter: ['file_library'] },
      result: { hits: [{ title: 'Lease', snippet: 'Pets require written approval.' }] },
      promptPreview: 'What does my lease say about pets?',
    });

    const summary = await summarizeToolUseTelemetry(inputPath);
    assert.equal(summary.total, 1);
    assert.equal(summary.byTool['file_search.msearch'], 1);

    const exported = await exportToolRoutingExamplesFromTelemetry(inputPath, { outputPath });
    assert.equal(exported.read, 1);
    assert.equal(exported.exported, 1);
    const exportedText = await readFile(outputPath, 'utf8');
    assert.ok(exportedText.includes('file_search.msearch'));
    assert.ok(exportedText.includes('contextSummary'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ToolUseCaptureLayer wraps tools and records completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-router-layer-'));
  try {
    const config = cloneDefaultConfig();
    config.toolCapture = { ...(config.toolCapture ?? { enabled: true }), enabled: true, path: join(dir, 'tool-use.jsonl'), sampleRate: 1 };
    const layer = new ToolUseCaptureLayer(config);
    const wrapped = layer.wrapTool('math.add', (a, b) => ({ sum: a + b }), { requestId: 'req_wrap' });
    const result = await wrapped(2, 3);
    assert.deepEqual(result, { sum: 5 });
    const text = await readFile(config.toolCapture.path, 'utf8');
    assert.ok(text.includes('"phase":"started"'));
    assert.ok(text.includes('"phase":"completed"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
