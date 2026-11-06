import { afterEach, describe, expect, it, vi } from "bun:test";
import { SupermemoryClient } from "@oh-my-pi/pi-coding-agent/supermemory/client";

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

	it("posts documents with bearer auth to /v3/documents", async () => {
		const captured = serve(() => Response.json({ id: "d1", status: "queued" }));
		const client = new SupermemoryClient("http://127.0.0.1:1/", KEY);
		const doc = await client.createDocument({ content: "fact", containerTag: "omp-global", customId: "omp-x" });
		expect(doc).toEqual({ id: "d1", status: "queued" });
		expect(captured[0]?.url).toBe("http://127.0.0.1:1/v3/documents");
		expect(captured[0]?.method).toBe("POST");
		expect(captured[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(captured[0]?.body).toEqual({ content: "fact", containerTag: "omp-global", customId: "omp-x" });
	});

	it("parses search results preferring memory over chunk and drops empty items", async () => {
		const captured = serve(() =>
			Response.json({
				results: [
					{ id: "a", memory: "memory text", chunk: "chunk text", similarity: 0.9 },
					{ id: "b", chunk: "chunk only" },
					{ id: "c" },
				],
			}),
		);
		const client = new SupermemoryClient("http://127.0.0.1:1", KEY);
		const results = await client.search({
			q: "query",
			containerTag: "omp-global",
			searchMode: "hybrid",
			limit: 5,
			threshold: 0.5,
		});
		expect(captured[0]?.url).toBe("http://127.0.0.1:1/v4/search");
		expect(captured[0]?.body).toEqual({
			q: "query",
			containerTag: "omp-global",
			searchMode: "hybrid",
			limit: 5,
			threshold: 0.5,
		});
		expect(results.map(r => [r.id, r.content])).toEqual([
			["a", "memory text"],
			["b", "chunk only"],
		]);
	});

	it("maps HTTP errors and invalid JSON without leaking the key or body", async () => {
		serve(() => new Response(`denied for ${KEY}`, { status: 401 }));
		const client = new SupermemoryClient("http://127.0.0.1:1", KEY);
		const httpError = await client.profile("omp-global").catch((error: Error) => error);
		expect(httpError).toBeInstanceOf(Error);
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
