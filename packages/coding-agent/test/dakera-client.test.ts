import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	DakeraApi,
	DakeraError,
	decodeDakeraContent,
	formatDakeraTimestamp,
	recallHitRank,
	type DakeraRecallHit,
} from "@oh-my-pi/pi-coding-agent/dakera/client";
import { asGlobalFetch } from "./helpers/fetch-mock";

interface CapturedRequest {
	method: string;
	url: string;
	body: Record<string, unknown> | undefined;
	authorization: string | undefined;
}

const requests: CapturedRequest[] = [];

/** Serve `response` for every call and record what went out. */
function capture(response: unknown | ((request: CapturedRequest) => unknown), status = 200): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch((input, init) => {
			const captured: CapturedRequest = {
				method: String(init?.method ?? "GET"),
				url: String(input),
				body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
				authorization: new Headers(init?.headers).get("authorization") ?? undefined,
			};
			requests.push(captured);
			const payload = typeof response === "function" ? response(captured) : response;
			return new Response(JSON.stringify(payload ?? {}), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
}

// Heartbeat explicitly off: these tests assert exact request sequences, and
// intervalMs: 0 is the documented disable contract (no timers, no warm-up).
const client = () => new DakeraApi({ baseUrl: "http://dakera.local/", keepAlive: { intervalMs: 0 } });

afterEach(() => {
	vi.restoreAllMocks();
	requests.length = 0;
});

describe("DakeraApi store wire shape", () => {
	it("sends a single store as a flat record, not nested under `memory`", async () => {
		capture({ memory: { id: "m1", content: "hello" } });
		await client().store("omp", { content: "hello", memoryType: "semantic", importance: 0.5 });

		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe("http://dakera.local/v1/memory/store");
		// The engine rejects `{memory: {...}}` here with
		// 422 "missing field `content`" — only the *response* is wrapped.
		expect(requests[0]?.body).toEqual({
			agent_id: "omp",
			content: "hello",
			memory_type: "semantic",
			importance: 0.5,
		});
	});

	it("sends a batch as a flat `{agent_id, memories: [...]}` envelope", async () => {
		capture({ stored: [{ id: "m1" }, { id: "m2" }] });
		const stored = await client().storeBatch("omp", [
			{ content: "one", memoryType: "episodic", importance: 0.4, tags: ["project:alpha"] },
			{ content: "two", memoryType: "working", importance: 0.6, metadata: { context: "because" } },
		]);

		expect(requests[0]?.url).toBe("http://dakera.local/v1/memories/store/batch");
		expect(requests[0]?.body).toEqual({
			agent_id: "omp",
			memories: [
				{ agent_id: "omp", content: "one", memory_type: "episodic", importance: 0.4, tags: ["project:alpha"] },
				{
					agent_id: "omp",
					content: "two",
					memory_type: "working",
					importance: 0.6,
					metadata: { context: "because" },
				},
			],
		});
		expect(stored.map(memory => memory.id)).toEqual(["m1", "m2"]);
	});

	it("skips the request entirely for an empty batch", async () => {
		capture({ stored: [] });
		expect(await client().storeBatch("omp", [])).toEqual([]);
		expect(requests).toHaveLength(0);
	});

	it("accepts a flat memory object from deployments that do not wrap it", async () => {
		capture({ id: "m9", content: "flat" });
		const memory = await client().store("omp", { content: "flat", memoryType: "semantic", importance: 0.5 });
		expect(memory.id).toBe("m9");
	});
});

describe("DakeraApi recall", () => {
	// The server rejects an explicit null for these knobs, so unset options must
	// leave the body entirely.
	it("omits unset options and forwards the ones set", async () => {
		capture({ memories: [] });
		await client().recall("omp", "query", { topK: 4, rerank: false, since: "2026-01-01" });
		expect(requests[0]?.url).toBe("http://dakera.local/v1/memory/recall");
		expect(requests[0]?.body).toEqual({
			agent_id: "omp",
			query: "query",
			top_k: 4,
			rerank: false,
			since: "2026-01-01",
		});
	});

	// `per-project-tagged` scoping only isolates if the filter reaches the server;
	// an empty tag list must not be sent, as the server would read it as a filter
	// that can never match.
	it("forwards the tag filter and leaves it out when unset", async () => {
		capture({ memories: [] });
		await client().recall("omp", "query", { tags: ["project:alpha", "global:shared"] });
		expect(requests[0]?.body).toEqual({
			agent_id: "omp",
			query: "query",
			tags: ["project:alpha", "global:shared"],
		});
		await client().recall("omp", "query", { tags: [] });
		expect(requests[1]?.body).not.toHaveProperty("tags");
	});

	it("unwraps scored hits and bare memory rows into one shape", async () => {
		capture({
			memories: [
				{ memory: { id: "a", content: "first" }, smart_score: 0.62 },
				{ id: "b", content: "second" },
				{ note: "no content, ignored" },
			],
		});
		const hits = await client().recall("omp", "query");
		expect(hits.map(hit => hit.memory.id)).toEqual(["a", "b"]);
		expect(hits[0]?.smart_score).toBe(0.62);
		expect(hits[1]?.score).toBeUndefined();
	});

	it("returns no hits for a response it cannot read as a list", async () => {
		capture({ unexpected: true });
		expect(await client().recall("omp", "query")).toEqual([]);
	});
});

describe("DakeraApi z64 compressed content", () => {
	// The server's curator stores consolidated memories with `content` replaced
	// by `z64:` + base64(zstd frame), sometimes nested. Rendering injects
	// `content` verbatim into the model's `<memories>` block, so a leaked frame
	// is base64 noise the model cannot read.
	const z64 = (text: string) => "z64:" + Buffer.from(Bun.zstdCompressSync(Buffer.from(text))).toString("base64");

	it("decodes z64 bodies in recall hits, scored and bare shapes", async () => {
		capture({
			memories: [
				{ memory: { id: "a", content: z64("curated semantic memory") }, smart_score: 0.6 },
				{ id: "b", content: z64("bare row memory") },
				{ id: "c", content: "already plaintext" },
			],
		});
		const hits = await client().recall("omp", "query");
		expect(hits.map(hit => hit.memory.content)).toEqual([
			"curated semantic memory",
			"bare row memory",
			"already plaintext",
		]);
	});

	it("peels nested z64 layers down to plaintext", async () => {
		// Observed live: the curator compresses already-compressed transcript rows.
		capture({ memories: [{ id: "a", content: z64(z64("double wrapped memory")) }] });
		expect((await client().recall("omp", "query"))[0]?.memory.content).toBe("double wrapped memory");
	});

	it("decodes z64 bodies in listMemories and update responses", async () => {
		capture([{ id: "a", content: z64("listed memory") }]);
		expect((await client().listMemories("omp"))[0]?.content).toBe("listed memory");
		capture({ memory: { id: "a", content: z64("updated memory") } });
		expect((await client().update("omp", "a", { content: "ignored" })).content).toBe("updated memory");
	});

	it("leaves plaintext and undecodable z64-looking frames unchanged", () => {
		expect(decodeDakeraContent("plain")).toBe("plain");
		expect(decodeDakeraContent("z64: not a real frame")).toBe("z64: not a real frame");
		expect(decodeDakeraContent("z64:!!not-base64!!")).toBe("z64:!!not-base64!!");
	});
});

describe("DakeraApi update and forget", () => {
	// Live server answers 400 (`missing field agent_id`) unless the id travels in
	// the query string; a body-only id silently fails every in-place retain.
	it("sends `agent_id` as a query parameter on update", async () => {
		capture({ memory: { id: "m1", content: "updated" } });
		await client().update("team/proj", "m1", { content: "updated" });
		expect(requests[0]?.method).toBe("PUT");
		expect(requests[0]?.url).toBe("http://dakera.local/v1/memory/update/m1?agent_id=team%2Fproj");
		expect(requests[0]?.body).toEqual({ content: "updated" });
	});

	// Supersede and compaction annotate the matched row's importance, tags and
	// metadata in place; the wire keys must match what the store path uses.
	it("forwards content, importance, tags and metadata on update", async () => {
		capture({ memory: { id: "m1", content: "updated" } });
		await client().update("omp", "m1", {
			content: "updated",
			importance: 0.9,
			tags: ["handoff"],
			metadata: { restated_at: "2026-10-31T00:00:00Z" },
		});
		expect(requests[0]?.body).toEqual({
			content: "updated",
			importance: 0.9,
			tags: ["handoff"],
			metadata: { restated_at: "2026-10-31T00:00:00Z" },
		});
	});

	// The server rejects an explicit null / empty tag filter, so unset fields and
	// an empty tags array must leave the body entirely.
	it("omits absent fields and an empty tag list on update", async () => {
		capture({ memory: { id: "m1", content: "only content" } });
		await client().update("omp", "m1", { content: "only content", tags: [] });
		expect(requests[0]?.body).toEqual({ content: "only content" });
	});

	it("forgets by id and reports the server's count", async () => {
		capture({ deleted_count: 6 });
		const deleted = await client().forget("omp", ["m1", "m2", "m3"]);
		expect(requests[0]?.url).toBe("http://dakera.local/v1/memory/forget");
		expect(requests[0]?.body).toEqual({ agent_id: "omp", memory_ids: ["m1", "m2", "m3"] });
		expect(deleted).toBe(6);
	});

	it("skips a forget with no ids", async () => {
		capture({ deleted_count: 0 });
		expect(await client().forget("omp", [])).toBe(0);
		expect(requests).toHaveLength(0);
	});
});

describe("DakeraApi listMemories", () => {
	it("reads the bare array the endpoint returns and encodes the agent id", async () => {
		capture([{ id: "m1" }, { id: "m2" }]);
		const memories = await client().listMemories("team/proj", { limit: 50 });
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.url).toBe("http://dakera.local/v1/agents/team%2Fproj/memories?limit=50");
		expect(requests[0]?.body).toBeUndefined();
		expect(memories.map(memory => memory.id)).toEqual(["m1", "m2"]);
	});

	it("treats a non-array listing as empty", async () => {
		capture({ memories: [] });
		expect(await client().listMemories("omp", { limit: 10 })).toEqual([]);
	});
});

describe("DakeraApi auth and errors", () => {
	it("sends the bearer token and omits the header when no key is configured", async () => {
		capture({});
		await new DakeraApi({
			baseUrl: "http://dakera.local",
			apiKey: "dk_secret",
			keepAlive: { intervalMs: 0 },
		}).listMemories("omp");
		expect(requests[0]?.authorization).toBe("Bearer dk_secret");

		requests.length = 0;
		await client().listMemories("omp");
		expect(requests[0]?.authorization).toBeUndefined();
	});

	it("surfaces the server message and status on a failed request", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(() => new Response(JSON.stringify({ error: "agent not found" }), { status: 404 })),
		);
		const error = await client()
			.listMemories("ghost")
			.then(
				() => undefined,
				(err: unknown) => err,
			);
		expect(error).toBeInstanceOf(DakeraError);
		expect((error as DakeraError).statusCode).toBe(404);
		expect((error as DakeraError).message).toBe("listMemories failed: agent not found");
	});

	// A stale keep-alive socket (ECONNRESET) must not cost a read-only recall its
	// delivery: the retry loop reopens a fresh connection instead of failing the turn.
	it("retries recall after a network error instead of surfacing it", async () => {
		let calls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(() => {
				calls += 1;
				if (calls === 1) throw new TypeError("ECONNRESET: The socket connection was closed unexpectedly");
				return new Response(
					JSON.stringify({
						memories: [{ memory: { id: "m1", content: "a fact", memory_type: "semantic" } }],
					}),
				);
			}),
		);

		const hits = await client().recall("omp", "query");

		expect(hits.map(hit => hit.memory.id)).toEqual(["m1"]);
		expect(calls).toBe(2);
	});

	// The non-idempotent guard stays: a store network error may have committed,
	// so it surfaces immediately instead of risking a duplicate row.
	it("surfaces a network error on store without retrying", async () => {
		let calls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(() => {
				calls += 1;
				throw new TypeError("ECONNRESET: The socket connection was closed unexpectedly");
			}),
		);

		const error = await client()
			.storeBatch("omp", [{ content: "a fact", memoryType: "semantic", importance: 0.5 }])
			.then(
				() => undefined,
				(err: unknown) => err,
			);

		expect(error).toBeInstanceOf(DakeraError);
		expect(calls).toBe(1);
	});

	// The Retry-After delay only buys something when another attempt follows;
	// sleeping through it on the last attempt parks the caller for nothing.
	it("skips the Retry-After sleep when no attempt remains", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(
				() =>
					new Response(JSON.stringify({ error: "slow down" }), {
						status: 429,
						headers: { "Retry-After": "1" },
					}),
			),
		);
		// Two attempts with a 1ms backoff: correct behaviour sleeps the 1s
		// Retry-After once (after the first 429) and rejects at ~1s; sleeping
		// again after the final 429 lands at ~2s.
		const tight = new DakeraApi({
			baseUrl: "http://dakera.local",
			retry: { maxRetries: 2, baseDelay: 1, maxDelay: 1 },
		});
		const started = Date.now();
		await tight.listMemories("omp").then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(Date.now() - started).toBeLessThan(1_500);
	});
});

describe("recallHitRank", () => {
	const hit = (fields: Partial<DakeraRecallHit>): DakeraRecallHit => ({
		memory: { id: "x", content: "c" },
		...fields,
	});

	// Observed duplicate pair: `score` said 0.119 while the server ordered by
	// `smart_score` 0.627. Ranking on `score` alone reverses the server's order.
	it("prefers smart_score over score", () => {
		expect(recallHitRank(hit({ score: 0.119, smart_score: 0.627 }))).toBe(0.627);
		expect(recallHitRank(hit({ score: 0.9 }))).toBe(0.9);
		expect(recallHitRank(hit({ weighted_score: 0.5, score: 0.2 }))).toBe(0.5);
		expect(recallHitRank(hit({}))).toBe(0);
	});
});

describe("formatDakeraTimestamp", () => {
	it("reads server timestamps as Unix seconds", () => {
		expect(formatDakeraTimestamp(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
		expect(formatDakeraTimestamp("1700000000")).toBe("2023-11-14T22:13:20.000Z");
	});

	it("passes through anything that is already displayable", () => {
		expect(formatDakeraTimestamp("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05Z");
		expect(formatDakeraTimestamp("   ")).toBeUndefined();
		expect(formatDakeraTimestamp(undefined)).toBeUndefined();
	});
});

function healthPings(): CapturedRequest[] {
	return requests.filter(request => request.url.endsWith("/v1/health"));
}

/** Poll until at least `minCount` keep-alive pings have gone out. */
async function waitForHealthPings(minCount: number, deadlineMs = 2_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (healthPings().length >= minCount) return;
		await Bun.sleep(20);
	}
	throw new Error(`expected ${minCount} keep-alive pings within ${deadlineMs}ms, saw ${healthPings().length}`);
}

/** Poll until no request has gone out for `windowMs` — the heartbeat chain stopped. */
async function waitForQuiet(windowMs: number, deadlineMs = 2_500): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	let last = requests.length;
	let lastChange = Date.now();
	while (Date.now() < deadline) {
		await Bun.sleep(20);
		if (requests.length !== last) {
			last = requests.length;
			lastChange = Date.now();
			continue;
		}
		if (Date.now() - lastChange >= windowMs) return;
	}
	throw new Error(`client traffic did not go quiet within ${deadlineMs}ms`);
}

describe("DakeraApi keep-alive heartbeat", () => {
	// The heartbeat IS a real setTimeout chain (arm → fire → re-arm); fake
	// timers would not exercise the re-arm path this suite exists to cover, so
	// these tests poll observed request counts against generous deadlines
	// instead of using deterministic clock control.
	it("pings the engine after real traffic with the same authenticated headers", async () => {
		capture({ stored: [{ id: "m1", content: "x" }] });
		const api = new DakeraApi({
			baseUrl: "http://dakera.local",
			apiKey: "dk_x",
			keepAlive: { intervalMs: 25, maxIdleMs: 300 },
		});
		await api.store("omp", { content: "hello", memoryType: "semantic", importance: 0.5 });

		// Several pings must follow one store: the chain re-arms after each
		// successful ping, it is not a single stray request.
		await waitForHealthPings(3);
		for (const ping of healthPings()) {
			expect(ping.method).toBe("GET");
			expect(ping.url).toBe("http://dakera.local/v1/health");
			expect(ping.authorization).toBe("Bearer dk_x");
		}
		await waitForQuiet(600);
	});

	it("stops pinging once real traffic has been idle past keepAliveMaxIdleMs", async () => {
		capture({});
		const api = new DakeraApi({
			baseUrl: "http://dakera.local",
			keepAlive: { intervalMs: 25, maxIdleMs: 300 },
		});
		await api.recall("omp", "query");
		await waitForHealthPings(1);
		// Without new traffic the chain must retire itself instead of pinging forever.
		await waitForQuiet(600);
	});

	it("warms the socket up with a ping before real traffic after heartbeat dormancy", async () => {
		capture({ stored: [{ id: "m1", content: "x" }] });
		const api = new DakeraApi({
			baseUrl: "http://dakera.local",
			apiKey: "dk_x",
			keepAlive: { intervalMs: 25, maxIdleMs: 100 },
		});
		await api.store("omp", { content: "hello", memoryType: "semantic", importance: 0.5 });

		// The warm-up precedes the operation deterministically: a stale pooled
		// socket is absorbed by the cheap ping, not by the store itself.
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.url).toBe("http://dakera.local/v1/health");
		expect(requests[1]?.method).toBe("POST");
		expect(requests[1]?.url).toBe("http://dakera.local/v1/memory/store");
		await waitForQuiet(600);
	});

	it("keeps pinging through stale-socket resets and stops after repeated failures", async () => {
		const resetError = Object.assign(new TypeError("The socket connection was closed unexpectedly"), {
			code: "ECONNRESET",
		});
		capture((request: CapturedRequest) => {
			if (request.url.endsWith("/v1/health")) throw resetError;
			return { stored: [{ id: "m1", content: "x" }] };
		});
		// maxIdleMs never elapses: only the failure budget can stop this chain.
		const api = new DakeraApi({
			baseUrl: "http://dakera.local",
			keepAlive: { intervalMs: 30, maxIdleMs: 600_000 },
		});
		await api.store("omp", { content: "hello", memoryType: "semantic", importance: 0.5 });

		// A reset must not kill the heartbeat on the first failure — the next
		// real request would then hit the same stale socket it just absorbed.
		await waitForHealthPings(3);
		await waitForQuiet(500);
	});

	// Bun's fetch rejects idle-pool resets as bare TypeErrors carrying the
	// errno only in the message; the halving must fire on that shape too,
	// not just on `.code`-tagged errors.
	it("halves the interval after a stale-socket reset and recovers on success", async () => {
		let healthCalls = 0;
		capture((request: CapturedRequest) => {
			if (!request.url.endsWith("/v1/health")) return { stored: [{ id: "m1", content: "x" }] };
			healthCalls += 1;
			if (healthCalls === 1) throw new TypeError("ECONNRESET: The socket connection was closed unexpectedly");
			return {};
		});
		const api = new DakeraApi({
			baseUrl: "http://dakera.local",
			keepAlive: { intervalMs: 5_200, maxIdleMs: 600_000 },
		});
		await api.store("omp", { content: "hello", memoryType: "semantic", importance: 0.5 });

		// The first ping lands after the configured interval; the reset must
		// halve the next arm to ~2600ms. Anything at or past the full interval
		// means the adaptive branch never ran.
		await waitForHealthPings(1, 6_500);
		const afterFirst = Date.now();
		await waitForHealthPings(2, 6_500);
		expect(Date.now() - afterFirst).toBeLessThan(4_900);
	});
});
