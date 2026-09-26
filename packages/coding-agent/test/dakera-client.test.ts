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

const client = () => new DakeraApi({ baseUrl: "http://dakera.local/" });

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
		expect((await client().update("omp", "a", "ignored")).content).toBe("updated memory");
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
		await client().update("team/proj", "m1", "updated");
		expect(requests[0]?.method).toBe("PUT");
		expect(requests[0]?.url).toBe("http://dakera.local/v1/memory/update/m1?agent_id=team%2Fproj");
		expect(requests[0]?.body).toEqual({ content: "updated" });
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
		await new DakeraApi({ baseUrl: "http://dakera.local", apiKey: "dk_secret" }).listMemories("omp");
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
