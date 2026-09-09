import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	RawSseDebugBuffer,
	rawSseRecordLines,
	resolveRawSseDebugBuffer,
} from "@oh-my-pi/pi-coding-agent/debug/raw-sse-buffer";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

describe("RawSseDebugBuffer", () => {
	it("records response metadata and raw SSE frame lines for diagnostics", () => {
		const buffer = new RawSseDebugBuffer();

		buffer.recordResponse(
			{ status: 200, requestId: "req_123", headers: {}, metadata: { lastTransport: "sse" } },
			model,
		);
		buffer.recordEvent(
			{
				event: "content_block_delta",
				data: '{"type":"content_block_delta"}',
				raw: ["event: content_block_delta", 'data: {"type":"content_block_delta"}'],
			},
			model,
		);

		const snapshot = buffer.snapshot();
		expect(snapshot.totalEvents).toBe(1);
		expect(snapshot.records).toHaveLength(2);
		const [responseLine] = rawSseRecordLines(snapshot.records[0]);
		expect(responseLine).toContain("provider=anthropic model=claude-test");
		expect(rawSseRecordLines(snapshot.records[1])).toEqual([
			"event: content_block_delta",
			'data: {"type":"content_block_delta"}',
		]);
		expect(buffer.toRawText()).toContain("event: content_block_delta");
	});

	it("notifies subscribers when new frames arrive", () => {
		const buffer = new RawSseDebugBuffer();
		let updates = 0;
		const unsubscribe = buffer.subscribe(() => {
			updates += 1;
		});

		buffer.recordEvent({ event: null, data: "{}", raw: ["data: {}"] }, model);
		unsubscribe();
		buffer.recordEvent({ event: null, data: "{}", raw: ["data: {}"] }, model);

		expect(updates).toBe(1);
		expect(buffer.snapshot().totalEvents).toBe(2);
	});

	it("creates a fallback buffer for session objects without a preinstalled buffer", () => {
		const owner = {};
		const buffer = resolveRawSseDebugBuffer(owner);

		buffer.recordEvent({ event: "message", data: "{}", raw: ["event: message", "data: {}"] }, model);

		expect(resolveRawSseDebugBuffer(owner)).toBe(buffer);
		expect(buffer.snapshot().totalEvents).toBe(1);
	});

	it("keeps session-owned records captured before the viewer resolves the buffer", () => {
		const session = { rawSseDebugBuffer: new RawSseDebugBuffer() };
		session.rawSseDebugBuffer.recordResponse(
			{ status: 200, requestId: "req_pre_viewer", headers: {}, metadata: { lastTransport: "sse" } },
			model,
		);
		session.rawSseDebugBuffer.recordEvent(
			{ event: "message_start", data: "{}", raw: ["event: message_start", "data: {}"] },
			model,
		);
		session.rawSseDebugBuffer.recordEvent(
			{ event: "message_stop", data: "{}", raw: ["event: message_stop", "data: {}"] },
			model,
		);

		const buffer = resolveRawSseDebugBuffer(session);

		expect(buffer).toBe(session.rawSseDebugBuffer);
		expect(buffer.snapshot().totalEvents).toBe(2);
		expect(buffer.toRawText()).toContain("requestId=req_pre_viewer");
		expect(buffer.toRawText()).toContain("event: message_stop");
	});

	it("keeps oldest-first order and exact droppedRecords well past MAX_RAW_SSE_EVENTS", () => {
		const buffer = new RawSseDebugBuffer();
		// > 2x MAX_RAW_SSE_EVENTS (1000) so the head-index ring compacts at least
		// once; a corrupt slice would scramble order or counts.
		const APPENDS = 2_300;
		for (let i = 1; i <= APPENDS; i++) {
			buffer.recordEvent({ event: null, data: "{}", raw: [`data: ${i}`] }, model);
		}

		const snapshot = buffer.snapshot();
		// 1000 newest survive (sequences 1301..2300); the oldest 1300 are evicted.
		expect(snapshot.records).toHaveLength(1_000);
		expect(snapshot.droppedRecords).toBe(1_300);
		expect(snapshot.totalEvents).toBe(APPENDS);
		const last = snapshot.records[snapshot.records.length - 1];
		expect(snapshot.records[0].sequence).toBe(1_301);
		expect(last.sequence).toBe(2_300);
		// Contiguous + oldest-first across the compaction boundary.
		expect(snapshot.records.every((record, idx) => record.sequence === 1_301 + idx)).toBe(true);
		expect(rawSseRecordLines(snapshot.records[0])[0]).toBe("data: 1301");
		expect(rawSseRecordLines(last)[0]).toBe("data: 2300");
	});

	it("evicts by char budget with exact droppedChars and live char total", () => {
		const buffer = new RawSseDebugBuffer();
		// One 63_998-char line → originalChars 63_999 (≤ the 64_000 per-event cap,
		// so no trim) → 64_000 chars per record. 8 records exactly fill
		// MAX_RAW_SSE_CHARS (512_000); each further append evicts the oldest.
		const PER_RECORD_CHARS = 64_000;
		const LINE_LEN = 63_998;
		const APPENDS = 12;
		for (let i = 1; i <= APPENDS; i++) {
			const line = `data: ${i}`.padEnd(LINE_LEN, "x");
			buffer.recordEvent({ event: null, data: "{}", raw: [line] }, model);
		}

		const snapshot = buffer.snapshot();
		// 12 appended, 8 fit the budget → the oldest 4 (sequences 1..4) drop.
		expect(snapshot.records).toHaveLength(8);
		expect(snapshot.droppedRecords).toBe(4);
		expect(snapshot.droppedChars).toBe(4 * PER_RECORD_CHARS);
		expect(snapshot.records[0].sequence).toBe(5);
		expect(snapshot.records[snapshot.records.length - 1].sequence).toBe(12);
		// #totalChars is not exposed; derive live chars from the conservation
		// invariant (sum appended − droppedChars) and confirm eviction stopped
		// exactly at budget rather than over- or under-evicting.
		const liveChars = APPENDS * PER_RECORD_CHARS - snapshot.droppedChars;
		expect(liveChars).toBe(8 * PER_RECORD_CHARS);
		expect(liveChars).toBeLessThanOrEqual(512_000);
	});

	it("emits the dropped header and oldest-first body in toRawText after eviction", () => {
		const buffer = new RawSseDebugBuffer();
		const APPENDS = 1_005; // 5 past MAX_RAW_SSE_EVENTS → oldest 5 drop
		for (let i = 1; i <= APPENDS; i++) {
			buffer.recordEvent({ event: null, data: "{}", raw: [`data: ${i}`] }, model);
		}

		// Dropped records 1..5: each "data: N" is 7 chars → 9 chars/record → 45.
		const text = buffer.toRawText();
		expect(text.startsWith(": omp-debug-dropped records=5 chars=45\n\n")).toBe(true);

		// Body data lines, oldest-first, are exactly records 6..1005 — no dropped
		// record leaks and order survives the head-index window.
		const dataLines = text
			.split("\n")
			.filter(line => line.startsWith("data: "))
			.map(line => Number(line.slice("data: ".length)));
		expect(dataLines).toHaveLength(1_000);
		expect(dataLines[0]).toBe(6);
		expect(dataLines.at(-1)).toBe(1_005);
		expect(dataLines.every((n, idx) => n === 6 + idx)).toBe(true);
	});
	it("keeps head and tail of an over-budget event with the middle elided", () => {
		const buffer = new RawSseDebugBuffer();
		const line = `data: {"type":"response.completed","id":"gen-head-marker","filler":"${"x".repeat(130_000)}","usage":{"output_tokens":42}}`;
		buffer.recordEvent(
			{ event: "response.completed", data: line.slice("data: ".length), raw: ["event: response.completed", line] },
			model,
		);

		const record = buffer.snapshot().records[0];
		if (record.kind !== "event") throw new Error("expected event record");
		expect(record.truncated).toBe(true);
		expect(record.originalChars).toBe("event: response.completed".length + 1 + line.length + 1);
		expect(record.raw[0]).toBe("event: response.completed");
		const text = record.raw.join("\n");
		expect(text).toContain("gen-head-marker");
		expect(text).toContain('"usage":{"output_tokens":42}}');
		expect(text).toContain(": omp-debug-elided chars=");
		expect(record.raw.at(-1)).toBe(`: omp-debug-truncated originalChars=${record.originalChars}`);
		expect(text.length).toBeLessThanOrEqual(64_000);
	});

	it("compacts tool schemas in oversized data payloads so the JSON stays parseable", () => {
		const buffer = new RawSseDebugBuffer();
		const tools = Array.from({ length: 20 }, (_, i) => ({
			type: "function",
			name: `tool_${i}`,
			description: "d".repeat(1_000),
			parameters: { type: "object", properties: { arg: { type: "string", description: "p".repeat(4_000) } } },
		}));
		const data = JSON.stringify({
			type: "response.created",
			response: { id: "resp_1", tools, usage: { input_tokens: 7 } },
		});
		buffer.recordEvent({ event: "response.created", data, raw: [`data: ${data}`] }, model);

		const record = buffer.snapshot().records[0];
		if (record.kind !== "event") throw new Error("expected event record");
		expect(record.truncated).toBe(true);
		expect(record.raw.at(-1)).toBe(`: omp-debug-truncated originalChars=${data.length + "data: ".length + 1}`);
		const parsed = JSON.parse(record.raw[0].slice("data: ".length));
		expect(parsed.response.usage.input_tokens).toBe(7);
		expect(parsed.response.tools).toHaveLength(20);
		expect(parsed.response.tools[0].name).toBe("tool_0");
		expect(typeof parsed.response.tools[0].parameters).toBe("string");
		expect(parsed.response.tools[0].parameters).toContain("… (+");
		expect(parsed.response.tools[0].description).toHaveLength(200 + "… (+800 chars)".length);
	});
});
