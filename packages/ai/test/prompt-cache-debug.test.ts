import { describe, expect, test } from "bun:test";
import {
	PromptCacheDebugJournal,
	createPromptCacheDiagnosticController,
	isPromptCacheDebugEnabled,
	type PromptCacheDiagnosticRequestInfo,
} from "@oh-my-pi/pi-ai/utils/prompt-cache-debug";
import { withEnv } from "./helpers";

type Message = { role: string; content: Array<Record<string, unknown>> };

const BASE_MESSAGES: Message[] = [
	{ role: "user", content: [{ type: "text", text: "first" }] },
	{ role: "assistant", content: [{ type: "text", text: "second" }] },
];

function requestInfo(
	body: string,
	overrides: Partial<PromptCacheDiagnosticRequestInfo> = {},
): PromptCacheDiagnosticRequestInfo {
	return {
		body,
		endpoint: "https://api.example.test/v1/messages?query-secret=1",
		provider: "anthropic",
		model: "test-model",
		api: "anthropic-messages",
		cacheAffinity: "session-a",
		sessionScope: "logical-session-a",
		ttlMs: 300_000,
		...overrides,
	};
}

function makeBody(
	messages: Message[] = BASE_MESSAGES,
	systemText = "stable-system",
	ttl: "5m" | "1h" = "5m",
	markerInFirstSystemBlock = false,
	contextManagement = false,
): string {
	const marker = { type: "text", text: "marker", cache_control: { type: "ephemeral", ttl } };
	const system = markerInFirstSystemBlock
		? [marker, { type: "text", text: systemText }]
		: [{ type: "text", text: systemText }, marker];
	return JSON.stringify({
		model: "test-model",
		max_tokens: 64,
		system,
		tools: [{ name: "lookup", description: "stable-tool" }],
		messages,
		...(contextManagement ? { context_management: { edits: [] } } : {}),
	});
}

function complete(
	journal: PromptCacheDebugJournal,
	body: string,
	cacheRead: number | null,
	overrides: Partial<PromptCacheDiagnosticRequestInfo> = {},
): void {
	const attempt = journal.begin(requestInfo(body, overrides));
	attempt.observeResponse({ status: 200, requestId: `req-${attempt.sequence}` });
	attempt.complete({ input: 100, cacheRead, cacheWrite: cacheRead === null ? null : 0, output: 4 });
}

function makeMessageMarkerBody(markerInFirstBlock = false, markerText = "marked"): string {
	const marker = { cache_control: { type: "ephemeral", ttl: "5m" }, type: "text", text: markerText };
	const assistantContent = markerInFirstBlock
		? [marker, { type: "text", text: "after-marker" }]
		: [{ type: "text", text: "before-marker" }, marker];
	return JSON.stringify({
		model: "test-model",
		max_tokens: 64,
		system: [{ type: "text", text: "stable-system" }],
		tools: [{ name: "lookup", description: "stable-tool" }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "ordered-prefix" }] },
			{ role: "assistant", content: assistantContent },
		],
	});
}

describe("prompt-cache diagnostic journal", () => {
	test("disabled construction does not enable the journal", async () => {
		await withEnv({ PI_PROMPT_CACHE_DEBUG: undefined }, async () => {
			expect(isPromptCacheDebugEnabled()).toBe(false);
			expect(
				createPromptCacheDiagnosticController({
					provider: "anthropic",
					model: "test-model",
					api: "anthropic-messages",
					endpoint: "https://api.example.test/v1/messages",
				}),
			).toBeUndefined();
		});
	});

	test("tracks a stable append and the longest equal serialized segment prefix", () => {
		const journal = new PromptCacheDebugJournal();
		const firstBody = makeBody();
		complete(journal, firstBody, 500);
		const appendedMessages = [...BASE_MESSAGES, { role: "user", content: [{ type: "text", text: "third" }] }];
		complete(journal, makeBody(appendedMessages), 600);

		const record = journal.records[1]!;
		expect(record.reset.observed).toBe(false);
		expect(record.context.mutation).toBe("append");
		expect(record.request.previousLcpTokens).toBeGreaterThan(0);
		expect(record.context.messageLogDivergenceIndex).toBeNull();
		expect(record.request.firstDivergentSegmentDigest).not.toBeNull();
	});

	test("classifies a changed middle message as a message rewrite and records its divergence", () => {
		const journal = new PromptCacheDebugJournal();
		complete(journal, makeBody(), 700);
		const changedMessages: Message[] = [
			BASE_MESSAGES[0]!,
			{ role: "assistant", content: [{ type: "text", text: "changed-second" }] },
		];
		complete(journal, makeBody(changedMessages), 2);

		const record = journal.records[1]!;
		expect(record.reset).toMatchObject({
			observed: true,
			cause: "message-rewrite-prune",
			previousSequence: 1,
			relevantSequences: [1, 2],
		});
		expect(record.context.messageLogDivergenceIndex).toBe(1);
		expect(record.request.firstDivergentSegmentDigest).not.toBeNull();
	});

	test("classifies changed prefix bytes when marker semantics stay in place", () => {
		const journal = new PromptCacheDebugJournal();
		complete(journal, makeBody(), 700);
		complete(journal, makeBody(BASE_MESSAGES, "changed-system"), 2);

		expect(journal.records[1]!.reset.cause).toBe("prefix-mutation");
		expect(journal.records[1]!.cache.markers[0]!.byteOffset).not.toBe(
			journal.records[0]!.cache.markers[0]!.byteOffset,
		);
		expect(journal.records[1]!.cache.markers[0]!.segmentIndex).toBe(
			journal.records[0]!.cache.markers[0]!.segmentIndex,
		);
	});

	test("classifies a genuine cache marker relocation", () => {
		const journal = new PromptCacheDebugJournal();
		complete(journal, makeBody(), 700);
		complete(journal, makeBody(BASE_MESSAGES, "stable-system", "5m", true), 2);

		expect(journal.records[1]!.reset.cause).toBe("breakpoint-movement");
		expect(journal.records[1]!.cache.markers[0]!.segmentIndex).not.toBe(
			journal.records[0]!.cache.markers[0]!.segmentIndex,
		);
	});

	test("classifies cache marker movement between blocks in one message", () => {
		const journal = new PromptCacheDebugJournal();
		complete(journal, makeMessageMarkerBody(), 700);
		complete(journal, makeMessageMarkerBody(true), 2);

		expect(journal.records[1]!.reset.cause).toBe("breakpoint-movement");
		expect(journal.records[1]!.cache.markers[0]!.location).not.toEqual(
			journal.records[0]!.cache.markers[0]!.location,
		);
	});

	test("ignores nested schema and tool-payload cache fields", () => {
		const journal = new PromptCacheDebugJournal();
		const body = JSON.stringify({
			model: "test-model",
			max_tokens: 64,
			tools: [
				{
					name: "lookup",
					input_schema: { properties: { cache_control: { type: "string" } } },
				},
			],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							content: [
								{ type: "text", text: "nested", cache_control: { type: "ephemeral", ttl: "5m" } },
								{ type: "compaction" },
							],
						},
					],
				},
			],
		});
		complete(journal, body, 700);

		expect(journal.records[0]!.request.markers).toEqual([]);
		expect(journal.records[0]!.context.compaction).toBe(false);
	});

	test("extends the stable cacheable prefix through ordered message content", () => {
		const journal = new PromptCacheDebugJournal();
		const body = makeMessageMarkerBody();
		complete(journal, body, 700);

		const record = journal.records[0]!;
		const nonMessageBytes = record.request.segments
			.filter(segment => segment.kind !== "message")
			.reduce((total, segment) => total + segment.bytes, 0);
		expect(record.request.stablePrefixBytes).toBeGreaterThan(nonMessageBytes);
		expect(record.request.stablePrefixDigest).not.toBeNull();
	});

	test("classifies an unchanged prefix after an idle interval as TTL expiry", () => {
		let now = 0;
		const journal = new PromptCacheDebugJournal({ now: () => now });
		const body = makeBody();
		complete(journal, body, 700);
		now = 300_001;
		complete(journal, body, 2);

		expect(journal.records[1]!.reset.cause).toBe("ttl-expiry");
		expect(journal.records[1]!.request.stablePrefixDigest).toBe(journal.records[0]!.request.stablePrefixDigest);
	});

	test("includes fields after cache_control in the marked content block", () => {
		const journal = new PromptCacheDebugJournal();
		complete(journal, makeMessageMarkerBody(), 700);
		complete(journal, makeMessageMarkerBody(false, "changed-marked-content"), 2);

		expect(journal.records[1]!.request.stablePrefixDigest).not.toBe(journal.records[0]!.request.stablePrefixDigest);
	});

	test("reports unknown when a lower read has no evidence for a more specific cause", () => {
		const journal = new PromptCacheDebugJournal();
		const body = makeBody();
		complete(journal, body, 700, { ttlMs: null });
		complete(journal, body, 2, { ttlMs: null });

		expect(journal.records[1]!.reset).toMatchObject({ observed: true, cause: "unknown" });
	});

	test("uses explicit branch metadata before treating a lower read as unknown", () => {
		const journal = new PromptCacheDebugJournal();
		complete(journal, makeBody(), 700);
		complete(journal, makeBody(), 2, { context: { branch: true, prune: true } });

		expect(journal.records[1]!.reset.cause).toBe("compaction-branch-replay");
		expect(journal.records[1]!.context.branch).toBe(true);
		expect(journal.records[1]!.context.prune).toBe(true);
	});

	test("does not infer compaction from context-management options alone", () => {
		const journal = new PromptCacheDebugJournal();
		const body = makeBody(BASE_MESSAGES, "stable-system", "5m", false, true);
		complete(journal, body, 700);
		complete(journal, body, 2);

		expect(journal.records[1]!.context.compaction).toBe(false);
		expect(journal.records[1]!.reset.cause).toBe("unknown");
	});

	test("keeps failed attempts separate from the next successful baseline", () => {
		const journal = new PromptCacheDebugJournal();
		const failed = journal.begin(requestInfo(makeBody()));
		failed.observeResponse({ status: 429, requestId: "req-failed" });
		const successful = journal.begin(requestInfo(makeBody()));
		successful.observeResponse({ status: 200, requestId: "req-success" });
		successful.complete({ input: 100, cacheRead: 2, cacheWrite: 90, output: 4 });

		expect(journal.records.map(record => record.outcome)).toEqual(["error", "success"]);
		expect(journal.records[0]!.usage).toEqual({ input: null, cacheRead: null, cacheWrite: null, output: null });
		expect(journal.records[0]!.status).toBe(429);
		expect(journal.records[1]!.reset.previousSequence).toBeNull();
	});

	test("scopes successful baselines by logical session while tracking affinity changes", () => {
		const journal = new PromptCacheDebugJournal();
		const body = makeBody();
		complete(journal, body, 700, { sessionScope: "scope-a" });
		complete(journal, body, 2, { sessionScope: "scope-b" });
		expect(journal.records[1]!.reset.previousSequence).toBeNull();
		expect(journal.records[1]!.reset.observed).toBe(false);

		complete(journal, body, 2, { sessionScope: "scope-a", cacheAffinity: "different-affinity" });
		expect(journal.records[2]!.reset).toMatchObject({
			observed: true,
			cause: "cache-key-change",
			previousSequence: 1,
			relevantSequences: [1, 3],
		});
	});

	test("bounds records and reports evictions without exceeding the byte budget", () => {
		const journal = new PromptCacheDebugJournal({ maxRecords: 2, maxBytes: 100_000 });
		const body = makeBody();
		complete(journal, body, 100);
		complete(journal, body, 90);
		complete(journal, body, 80);

		const snapshot = journal.snapshot();
		expect(snapshot.records).toHaveLength(2);
		expect(snapshot.droppedRecords).toBe(1);
		expect(new TextEncoder().encode(journal.toJSONL()).byteLength).toBeLessThanOrEqual(snapshot.maxBytes);
	});

	test("drops an oversized record without evicting retained diagnostics", () => {
		const journal = new PromptCacheDebugJournal({ maxRecords: 4, maxBytes: 5_000 });
		complete(journal, makeBody(), 100);
		const retainedSequence = journal.records[0]!.sequence;
		const oversizedMessages = Array.from({ length: 100 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: `message-${index}` }],
		}));
		complete(journal, makeBody(oversizedMessages), 90);

		expect(journal.records.map(record => record.sequence)).toEqual([retainedSequence]);
		expect(journal.snapshot().droppedRecords).toBe(1);
	});

	test("derived records omit raw body text, credentials, affinity, and endpoint paths", () => {
		const journal = new PromptCacheDebugJournal();
		const body = makeBody([{ role: "user", content: [{ type: "text", text: "credential-value" }] }]);
		complete(journal, body, 10, {
			cacheAffinity: "secret-affinity",
			endpoint: "https://api.example.test/v1/messages?query-secret=credential-value",
		});
		const serialized = journal.toJSONL();

		expect(serialized).not.toContain("credential-value");
		expect(serialized).not.toContain("secret-affinity");
		expect(serialized).not.toContain("query-secret");
		expect(serialized).toContain("https://api.example.test/path-hmac-");
		expect(serialized).not.toContain("/v1/messages");
	});

	test("correlates the exact final fetch body with the terminal response", async () => {
		await withEnv({ PI_PROMPT_CACHE_DEBUG: "1" }, async () => {
			const journal = new PromptCacheDebugJournal();
			let capturedBody: RequestInit["body"] | undefined;
			const baseFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				capturedBody = init?.body;
				return new Response(null, { status: 200, headers: { "request-id": "req-final" } });
			};
			const controller = createPromptCacheDiagnosticController({
				journal,
				provider: "anthropic",
				model: "test-model",
				api: "anthropic-messages",
				endpoint: "https://api.example.test/v1/messages",
				baseFetch,
				sessionScope: "logical-session-a",
				cacheAffinity: "session-a",
			});
			expect(controller).toBeDefined();
			const body = makeBody();
			await controller!.fetch("https://api.example.test/v1/messages?fetch-secret=1", { method: "POST", body });
			controller!.complete({ input: 100, cacheRead: 42, cacheWrite: 0, output: 4 });

			expect(capturedBody).toBe(body);
			expect(journal.records[0]!.status).toBe(200);
			expect(journal.records[0]!.request.bytes).toBe(new TextEncoder().encode(body).byteLength);
			expect(journal.records[0]!.request.digest).not.toBeNull();
			expect(journal.records[0]!.endpoint).toContain("https://api.example.test/path-hmac-");
			expect(journal.records[0]!.endpoint).not.toContain("/v1/messages");
		});
	});

	test("records a failed physical attempt when the wrapped transport throws", async () => {
		await withEnv({ PI_PROMPT_CACHE_DEBUG: "1" }, async () => {
			const journal = new PromptCacheDebugJournal();
			const controller = createPromptCacheDiagnosticController({
				journal,
				provider: "anthropic",
				model: "test-model",
				api: "anthropic-messages",
				endpoint: "https://api.example.test/v1/messages",
				baseFetch: async () => {
					throw new Error("transport-failure");
				},
				sessionScope: "logical-session-a",
			});
			await expect(
				controller!.fetch("https://api.example.test/v1/messages", { method: "POST", body: makeBody() }),
			).rejects.toThrow("transport-failure");
			expect(journal.records).toHaveLength(1);
			expect(journal.records[0]!.outcome).toBe("error");
			expect(journal.records[0]!.status).toBeNull();
			expect(journal.records[0]!.errorCode).toBe("Error");
		});
	});
});
