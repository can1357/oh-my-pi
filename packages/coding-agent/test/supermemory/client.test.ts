import { afterEach, describe, expect, it, vi } from "bun:test";
import { SupermemoryClient, SupermemoryHttpError } from "@oh-my-pi/pi-coding-agent/supermemory/client";

const KEY = "sm-synthetic-key";

interface Captured {
	url: string;
	method?: string;
	headers: Headers;
	body: unknown;
}

function serve(respond: (init: RequestInit | undefined) => Promise<Response> | Response): Captured[] {
	const captured: Captured[] = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			captured.push({
				url: String(input),
				method: init?.method,
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body ?? "null")),
			});
			return respond(init);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return captured;
}

describe("SupermemoryClient", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adds documents with bearer auth to the URL-encoded namespace", async () => {
		const captured = serve(() => Response.json({ id: "d1", status: "queued" }));
		const client = new SupermemoryClient("http://127.0.0.1:1/", KEY);
		const doc = await client.addDocument("team:a b", { content: "fact", id: "omp-x", metadata: { source: "t" } });
		expect(doc).toEqual({ id: "d1", status: "queued" });
		expect(captured[0]?.url).toBe("http://127.0.0.1:1/ns/team%3Aa%20b/document");
		expect(captured[0]?.method).toBe("POST");
		expect(captured[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(captured[0]?.body).toEqual({ content: "fact", id: "omp-x", metadata: { source: "t" } });
	});

	it("searches with explicit mode, threshold and no query rewriting, branching memory vs chunk results", async () => {
		const captured = serve(() =>
			Response.json({
				results: [
					{ id: "a", memory: "memory text", chunk: "chunk text", similarity: 0.9, system: { updatedAt: "t1" } },
					{ id: "b", chunk: "chunk only" },
					{ id: "c" },
				],
				searchTime: 3,
			}),
		);
		const client = new SupermemoryClient("http://127.0.0.1:1", KEY);
		const results = await client.search("omp-global", {
			query: "query",
			searchMode: "hybrid",
			limit: 5,
			threshold: 0.5,
		});
		expect(captured[0]?.url).toBe("http://127.0.0.1:1/ns/omp-global/search");
		expect(captured[0]?.method).toBe("POST");
		expect(captured[0]?.body).toEqual({
			query: "query",
			searchMode: "hybrid",
			limit: 5,
			threshold: 0.5,
			rewriteQuery: false,
		});
		expect(results).toEqual([
			{ id: "a", kind: "memory", content: "memory text", similarity: 0.9, updatedAt: "t1" },
			{ id: "b", kind: "chunk", content: "chunk only", similarity: undefined, updatedAt: undefined },
		]);
	});

	it("reads profile entries as objects or plain strings from an empty-body request", async () => {
		const captured = serve(() =>
			Response.json({
				profile: {
					static: [{ id: "s1", memory: "works in design" }, "legacy string", { id: "s2" }],
					dynamic: [{ id: "d1", memory: "[2026-10-01] preparing a launch" }],
					buckets: { preferences: [] },
				},
			}),
		);
		const client = new SupermemoryClient("http://127.0.0.1:1", KEY);
		const profile = await client.profile("omp-global");
		expect([captured[0]?.method, captured[0]?.url, captured[0]?.body]).toEqual([
			"POST",
			"http://127.0.0.1:1/ns/omp-global/profile",
			{},
		]);
		expect(profile).toEqual({
			static: ["works in design", "legacy string"],
			dynamic: ["[2026-10-01] preparing a launch"],
		});
	});

	it("forgets memories by id and returns per-id matches and errors", async () => {
		const captured = serve(() =>
			Response.json({
				count: 1,
				matches: [{ id: "m1", memory: "old" }],
				errors: [{ id: "m2", error: "Memory not found" }],
			}),
		);
		const client = new SupermemoryClient("http://127.0.0.1:1", KEY);
		const result = await client.forgetMemories("omp-global", ["m1", "m2"]);
		expect([captured[0]?.method, captured[0]?.url, captured[0]?.body]).toEqual([
			"DELETE",
			"http://127.0.0.1:1/ns/omp-global/memories",
			{ ids: ["m1", "m2"] },
		]);
		expect(result).toEqual({ matches: ["m1"], errors: [{ id: "m2", error: "Memory not found" }] });
	});

	it("maps HTTP errors and invalid JSON without leaking the key or body", async () => {
		serve(() => new Response(`denied for ${KEY}`, { status: 401 }));
		const client = new SupermemoryClient("http://127.0.0.1:1", KEY);
		const httpError = await client.profile("omp-global").catch((error: Error) => error);
		expect(httpError).toBeInstanceOf(SupermemoryHttpError);
		expect((httpError as SupermemoryHttpError).status).toBe(401);
		expect((httpError as Error).message).toBe("Supermemory request failed with HTTP 401.");

		vi.restoreAllMocks();
		serve(() => new Response("not json", { status: 200 }));
		const jsonError = await client.profile("omp-global").catch((error: Error) => error);
		expect((jsonError as Error).message).toBe("Supermemory returned invalid JSON.");
	});

	it("distinguishes timeout from caller abort", async () => {
		const hang = (init: RequestInit | undefined) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			return promise;
		};
		serve(hang);
		const client = new SupermemoryClient("http://127.0.0.1:1", KEY, 1_000);
		await expect(client.profile("omp-global")).rejects.toThrow("Supermemory request timed out.");

		const controller = new AbortController();
		const pending = client.profile("omp-global", controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("Supermemory request cancelled.");
	});
});
