import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
	body: PromptCacheDiagnosticRequestInfo["body"],
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
	markerText = "marker",
): string {
	const marker = { cache_control: { type: "ephemeral", ttl }, type: "text", text: markerText };
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
	cacheWrite: number | null = cacheRead === null ? null : 0,
): void {
	const attempt = journal.begin(requestInfo(body, overrides));
	attempt.observeResponse({ status: 200, requestId: `req-${attempt.sequence}` });
	attempt.complete({ input: 100, cacheRead, cacheWrite, output: 4 });
}

function makeMessageMarkerBody(
	markerInFirstBlock = false,
	markerText = "marked",
	afterMarkerText = "after-marker",
): string {
	const marker = { cache_control: { type: "ephemeral", ttl: "5m" }, type: "text", text: markerText };
	const assistantContent = markerInFirstBlock
		? [marker, { type: "text", text: afterMarkerText }]
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

function makeRollingMessageBody(messages: Message[]): string {
	const decoratedMessages = messages.map((message, index) => {
		if (index < messages.length - 2) return message;
		const content = [...message.content];
		const lastBlock = content.at(-1);
		if (lastBlock === undefined) return message;
		content[content.length - 1] = {
			...lastBlock,
			cache_control: { type: "ephemeral", ttl: "5m" },
		};
		return { ...message, content };
	});
	return makeBody(decoratedMessages);
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

	test("uses an independent HMAC key for each journal", () => {
		const body = makeBody();
		const first = new PromptCacheDebugJournal();
		const second = new PromptCacheDebugJournal();
		complete(first, body, 700);
		complete(second, body, 700);

		expect(second.records[0]!.request.digest).not.toBe(first.records[0]!.request.digest);
		expect(second.records[0]!.cache.scopeDigest).not.toBe(first.records[0]!.cache.scopeDigest);
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
		const markerMessage: Message = {
			role: "user",
			content: [{ type: "text", text: "cache-through-here", cache_control: { type: "ephemeral", ttl: "5m" } }],
		};
		const cachedMessages: Message[] = [...BASE_MESSAGES, markerMessage];
		complete(journal, makeBody(cachedMessages), 700);
		const previousSecondMessage = journal.records[0]!.request.segments.find(
			segment => segment.kind === "message" && segment.index === 1,
		);
		if (previousSecondMessage === undefined) throw new Error("expected cached middle message segment");
		const changedMessages: Message[] = [
			BASE_MESSAGES[0]!,
			{ role: "assistant", content: [{ type: "text", text: "changed-second" }] },
			markerMessage,
		];
		complete(journal, makeBody(changedMessages), 2);

		const record = journal.records[1]!;
		const currentSecondMessage = record.request.segments.find(
			segment => segment.kind === "message" && segment.index === 1,
		);
		if (currentSecondMessage === undefined) throw new Error("expected rewritten middle message segment");
		expect(currentSecondMessage.semanticDigest).not.toBe(previousSecondMessage.semanticDigest);
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
		expect(journal.records[1]!.request.stablePrefixDigest).not.toBe(journal.records[0]!.request.stablePrefixDigest);
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
		expect(journal.records[1]!.context.mutation).toBe("breakpoint-movement");
		expect(journal.records[1]!.cache.markers[0]!.location).not.toEqual(
			journal.records[0]!.cache.markers[0]!.location,
		);
	});

	test("gives breakpoint movement precedence over a changed message history", () => {
		const journal = new PromptCacheDebugJournal();
		complete(journal, makeMessageMarkerBody(), 700);
		complete(journal, makeMessageMarkerBody(true, "changed-marked", "stable-after"), 2);

		expect(journal.records[1]!.context.messageLogDivergenceIndex).toBe(1);
		expect(journal.records[1]!.context.mutation).toBe("breakpoint-movement");
		expect(journal.records[1]!.reset.cause).toBe("breakpoint-movement");
	});

	test("attributes an uncached suffix rewrite to TTL expiry", () => {
		let now = 0;
		const journal = new PromptCacheDebugJournal({ now: () => now });
		const firstBody = makeMessageMarkerBody(true, "marked", "stable-after");
		const changedSuffixBody = makeMessageMarkerBody(true, "marked", "changed-after");
		complete(journal, firstBody, 700);
		now = 300_001;
		complete(journal, changedSuffixBody, 2);

		expect(journal.records[1]!.reset.cause).toBe("ttl-expiry");
		expect(journal.records[1]!.request.cachePrefixDigests).toContain(
			journal.records[0]!.request.cachePrefixDigests.at(-1)!,
		);
	});

	test("attributes a rewrite before the final cache breakpoint to prefix mutation", () => {
		let now = 0;
		const journal = new PromptCacheDebugJournal({ now: () => now });
		const firstBody = makeMessageMarkerBody(true, "marked", "stable-after");
		const changedPrefixBody = makeMessageMarkerBody(true, "changed-marked", "stable-after");
		complete(journal, firstBody, 700);
		now = 300_001;
		complete(journal, changedPrefixBody, 2);

		expect(journal.records[1]!.reset.cause).toBe("prefix-mutation");
		expect(journal.records[1]!.request.cachePrefixDigests).not.toContain(
			journal.records[0]!.request.cachePrefixDigests.at(-1)!,
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
		expect(journal.records[0]!.context.compaction).toBe("absent");
	});

	test("keeps the stable cacheable prefix on the request head", () => {
		const journal = new PromptCacheDebugJournal();
		const body = makeBody();
		complete(journal, body, 700);

		const record = journal.records[0]!;
		expect(record.request.stablePrefixBytes).not.toBeNull();
		expect(record.request.stablePrefixBytes!).toBeLessThan(record.request.bytes!);
		expect(record.request.stablePrefixDigest).not.toBeNull();
	});

	test("normalizes cache marker metadata out of the stable prefix digest", () => {
		const journal = new PromptCacheDebugJournal();
		complete(journal, makeBody(BASE_MESSAGES, "stable-system", "5m"), 700, { ttlMs: undefined });
		complete(journal, makeBody(BASE_MESSAGES, "stable-system", "1h"), 2, { ttlMs: undefined });

		expect(journal.records[1]!.request.stablePrefixDigest).toBe(journal.records[0]!.request.stablePrefixDigest);
		expect(journal.records[1]!.reset.cause).toBe("retention-change");
	});

	test("takes the no-marker fast path without deriving cache-prefix state", () => {
		const journal = new PromptCacheDebugJournal();
		const body = JSON.stringify({
			model: "test-model",
			max_tokens: 64,
			system: [{ type: "text", text: "stable-system" }],
			tools: [{ name: "lookup", description: "stable-tool" }],
			messages: BASE_MESSAGES,
		});
		complete(journal, body, 700);

		expect(journal.records[0]!.request.markers).toEqual([]);
		expect(journal.records[0]!.request.cachePrefixDigests).toEqual([]);
		expect(journal.records[0]!.request.stablePrefixDigest).toBeNull();
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

	test("observes an equal-zero read with a positive write after TTL expiry", () => {
		let now = 0;
		const journal = new PromptCacheDebugJournal({ now: () => now });
		const body = makeBody();
		complete(journal, body, 0, {}, 100);
		now = 300_001;
		complete(journal, body, 0, {}, 100);

		expect(journal.records[1]!.reset).toMatchObject({ observed: true, cause: "ttl-expiry" });
	});

	test("measures TTL from the previous request start", () => {
		const nowValues = [0, 299_000, 300_001, 300_002];
		let nowIndex = 0;
		const journal = new PromptCacheDebugJournal({ now: () => nowValues[nowIndex++] ?? 300_002 });
		const body = makeBody();
		complete(journal, body, 0, {}, 100);
		complete(journal, body, 0, {}, 100);

		expect(journal.records[1]!.reset).toMatchObject({ observed: true, cause: "ttl-expiry" });
	});

	test("does not let rolling message markers shadow head TTL expiry", () => {
		let now = 0;
		const journal = new PromptCacheDebugJournal({ now: () => now });
		const initialMessages = [...BASE_MESSAGES, { role: "user", content: [{ type: "text", text: "third" }] }];
		const initialBody = makeRollingMessageBody(initialMessages);
		const appendedBody = makeRollingMessageBody([
			...initialMessages,
			{ role: "assistant", content: [{ type: "text", text: "fourth" }] },
		]);

		complete(journal, initialBody, 700);
		const previousRollingSegment = journal.records[0]!.request.segments.find(
			segment => segment.kind === "message" && segment.index === 1,
		);
		if (previousRollingSegment === undefined) throw new Error("expected prior rolling message segment");
		now = 1;
		complete(journal, appendedBody, 800);
		const currentRollingSegment = journal.records[1]!.request.segments.find(
			segment => segment.kind === "message" && segment.index === 1,
		);
		if (currentRollingSegment === undefined) throw new Error("expected current rolling message segment");
		expect(currentRollingSegment.digest).not.toBe(previousRollingSegment.digest);
		expect(currentRollingSegment.semanticDigest).toBe(previousRollingSegment.semanticDigest);
		expect(journal.records[1]!.request.firstDivergentSegmentDigest).not.toBeNull();
		const rollingMarkers = journal.records[1]!.cache.markers.filter(marker => marker.kind === "message");
		expect(rollingMarkers).toHaveLength(2);
		expect(journal.records[1]!.request.cachePrefixDigests).toContain(
			journal.records[0]!.request.cachePrefixDigests.at(-1)!,
		);
		expect(journal.records[1]!.reset.observed).toBe(false);
		expect(journal.records[1]!.context.mutation).toBe("append");
		expect(journal.records[1]!.context.messageLogDivergenceIndex).toBeNull();

		now = 300_002;
		complete(journal, appendedBody, 2);
		expect(journal.records[2]!.reset.cause).toBe("ttl-expiry");
	});

	test("preserves a rolled cache prefix through a multi-message append", () => {
		let now = 0;
		const journal = new PromptCacheDebugJournal({ now: () => now });
		const initialMessages = [...BASE_MESSAGES];
		const appendedMessages = [
			...initialMessages,
			{ role: "user", content: [{ type: "text", text: "third" }] },
			{ role: "assistant", content: [{ type: "text", text: "fourth" }] },
		];
		complete(journal, makeRollingMessageBody(initialMessages), 700);
		now = 300_001;
		complete(journal, makeRollingMessageBody(appendedMessages), 2);

		const previousFinalDigest = journal.records[0]!.request.cachePrefixDigests.at(-1)!;
		const current = journal.records[1]!;
		expect(current.request.cachePrefixDigests).not.toContain(previousFinalDigest);
		expect(current.reset.cause).toBe("ttl-expiry");
		expect(current.context.mutation).toBe("append");
	});

	test("includes fields after cache_control in the marked content block", () => {
		const journal = new PromptCacheDebugJournal();
		complete(journal, makeBody(), 700);
		complete(journal, makeBody(BASE_MESSAGES, "stable-system", "5m", false, false, "changed-marked-content"), 2);

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
		complete(journal, makeBody(), 2, {
			context: { branchState: { timestamp: 1, fromId: "branch-a" }, pruneState: 1 },
		});

		expect(journal.records[1]!.reset.cause).toBe("compaction-branch-replay");
		expect(journal.records[1]!.context.branchStateDigest).not.toBeNull();
		expect(journal.records[1]!.context.pruneStateDigest).not.toBeNull();
		expect(journal.toJSONL()).not.toContain("branch-a");
	});

	test("does not infer compaction from context-management options alone", () => {
		const journal = new PromptCacheDebugJournal();
		const body = makeBody(BASE_MESSAGES, "stable-system", "5m", false, true);
		complete(journal, body, 700);
		complete(journal, body, 2);

		expect(journal.records[1]!.context.compaction).toBe("absent");
		expect(journal.records[1]!.reset.cause).toBe("unknown");
	});

	test("treats a replayed compaction block as a transition only once", () => {
		const journal = new PromptCacheDebugJournal();
		const compactionBody = makeBody([{ role: "assistant", content: [{ type: "compaction" }] }]);
		complete(journal, makeBody(), 700);
		complete(journal, compactionBody, 2);
		complete(journal, compactionBody, 1);

		expect(journal.records[1]!.context.compaction).toBe("present");
		expect(journal.records[1]!.reset.cause).toBe("compaction-branch-replay");
		expect(journal.records[2]!.context.compaction).toBe("present");
		expect(journal.records[2]!.context.mutation).not.toBe("compaction");
		expect(journal.records[2]!.reset).toMatchObject({ observed: true, cause: "unknown" });
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

	test("keeps a frequently refreshed baseline through unrelated scope churn", () => {
		let now = 0;
		const journal = new PromptCacheDebugJournal({ now: () => now });
		const body = makeBody();
		complete(journal, body, 700, { sessionScope: "active" });
		for (let index = 0; index < 40; index++) {
			complete(journal, body, 700, { sessionScope: `other-${index}` });
			if (index % 4 === 3) complete(journal, body, 700, { sessionScope: "active" });
		}

		now = 300_001;
		complete(journal, body, 2, { sessionScope: "active" });

		expect(journal.records.at(-1)!.reset).toMatchObject({
			observed: true,
			cause: "ttl-expiry",
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

	test("appends retained lines and rewrites the sidecar after bounded eviction", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prompt-cache-journal-"));
		const filePath = path.join(tempDir, "journal.jsonl");
		const journal = new PromptCacheDebugJournal({ filePath, maxRecords: 2, maxBytes: 100_000 });
		const appendRecord = (cacheRead: number): void => {
			const attempt = journal.begin(requestInfo(null, { sessionScope: "sidecar-lifecycle" }));
			attempt.observeResponse({ status: 200, requestId: `req-${cacheRead}` });
			attempt.complete({ input: 1, cacheRead, cacheWrite: 0, output: 1 });
		};
		const parseSequence = (line: string): number => {
			const value: unknown = JSON.parse(line);
			if (
				typeof value !== "object" ||
				value === null ||
				!("sequence" in value) ||
				typeof value.sequence !== "number"
			) {
				throw new Error("journal record omitted a numeric sequence");
			}
			return value.sequence;
		};
		const readSequences = async (): Promise<number[]> =>
			(await Bun.file(filePath).text()).trim().split("\n").filter(Boolean).map(parseSequence);
		try {
			appendRecord(1);
			await journal.flush();
			expect(await readSequences()).toEqual([1]);

			appendRecord(2);
			await journal.flush();
			expect(await readSequences()).toEqual([1, 2]);

			appendRecord(3);
			await journal.flush();
			expect(await readSequences()).toEqual([2, 3]);
			expect((await fs.stat(filePath)).size).toBeLessThanOrEqual(100_000);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("rewrites the sidecar when attempts complete out of sequence", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prompt-cache-order-"));
		const filePath = path.join(tempDir, "journal.jsonl");
		const journal = new PromptCacheDebugJournal({ filePath, maxRecords: 4, maxBytes: 100_000 });
		const parseSequence = (line: string): number => {
			const value: unknown = JSON.parse(line);
			if (
				typeof value !== "object" ||
				value === null ||
				!("sequence" in value) ||
				typeof value.sequence !== "number"
			) {
				throw new Error("journal record omitted a numeric sequence");
			}
			return value.sequence;
		};
		const readSequences = async (): Promise<number[]> =>
			(await Bun.file(filePath).text()).trim().split("\n").filter(Boolean).map(parseSequence);
		try {
			const first = journal.begin(requestInfo(null, { sessionScope: "out-of-order" }));
			const second = journal.begin(requestInfo(null, { sessionScope: "out-of-order" }));
			second.observeResponse({ status: 200, requestId: "req-second" });
			second.complete({ input: 1, cacheRead: 2, cacheWrite: 0, output: 1 });
			await journal.flush();
			expect(await readSequences()).toEqual([2]);

			first.observeResponse({ status: 200, requestId: "req-first" });
			first.complete({ input: 1, cacheRead: 1, cacheWrite: 0, output: 1 });
			await journal.flush();
			expect(await readSequences()).toEqual([2, 1]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("swallows unwritable journal persistence failures", async () => {
		const journal = new PromptCacheDebugJournal({ filePath: "." });
		complete(journal, makeBody(), 10);
		await journal.flush();
		expect(journal.records).toHaveLength(1);
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
			expect(journal.records[0]!.bodySource).toBe("wire");

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
