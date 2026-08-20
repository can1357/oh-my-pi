import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils";
import "./setup";
import { currentRerankerModel, DEFAULT_RERANKER_MODEL, rerank, rerankerAvailable } from "@pk-nerdsaver-ai/pi-mnemopi";
import { initBeam } from "@pk-nerdsaver-ai/pi-mnemopi/core/beam";
import { Mnemopi } from "@pk-nerdsaver-ai/pi-mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@pk-nerdsaver-ai/pi-mnemopi/core/runtime-options";
import packageJson from "../package.json" with { type: "json" };

function openMemory(options: ConstructorParameters<typeof Mnemopi>[0] = {}): Mnemopi {
	const db = new Database(":memory:");
	initBeam(db);
	return new Mnemopi({
		db,
		sessionId: "rerank-test",
		noEmbeddings: true,
		llm: false,
		...options,
	});
}

describe("mnemopi dedicated reranker", () => {
	it("posts query documents to OpenRouter /rerank with bearer auth", async () => {
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				requests += 1;
				expect(request.method).toBe("POST");
				expect(new URL(request.url).pathname).toBe("/rerank");
				expect(request.headers.get("content-type")).toBe("application/json");
				expect(request.headers.get("authorization")).toBe("Bearer test-rerank-key");
				expect(request.headers.get("user-agent")).toBe(`${APP_NAME}/${packageJson.version}`);
				expect(request.headers.get("http-referer")).toBe("https://oh-my-pk.pkking.computer/");
				const payload: unknown = await request.json();
				expect(payload).toEqual({
					model: DEFAULT_RERANKER_MODEL,
					query: "preferred fruit",
					documents: ["bananas are yellow", "apples are crisp"],
				});
				return Response.json({
					results: [
						{ index: 1, relevance_score: 0.91 },
						{ index: 0, relevance_score: 0.12 },
					],
				});
			},
		});

		try {
			const scores = await withMnemopiRuntimeOptions(
				{
					reranker: {
						apiUrl: server.url.toString().replace(/\/+$/, ""),
						apiKey: "test-rerank-key",
						model: DEFAULT_RERANKER_MODEL,
					},
				},
				() => rerank("preferred fruit", ["bananas are yellow", "apples are crisp"]),
			);
			expect(scores).toEqual([
				{ index: 1, relevanceScore: 0.91 },
				{ index: 0, relevanceScore: 0.12 },
			]);
			expect(currentRerankerModel()).toBe(DEFAULT_RERANKER_MODEL);
			expect(requests).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	it("reorders recall candidates by rerank scores", async () => {
		const memory = openMemory({
			reranker: {
				provider: {
					rerank: async (_query, documents) =>
						documents.map((_, index) => ({
							index,
							relevanceScore: index,
						})),
				},
			},
		});
		try {
			memory.remember("alpha fruit salad");
			memory.remember("omega fruit salad");
			const localOrder = await withMnemopiRuntimeOptions({ reranker: { disabled: true } }, () =>
				memory.beam.recall("fruit salad", 5),
			);
			expect(localOrder.length).toBe(2);
			const results = await memory.recall("fruit salad", 5);
			expect(results.map(result => result.content)).toEqual([...localOrder].reverse().map(result => result.content));
			expect(results.every(result => typeof result.rerank_score === "number")).toBe(true);
			const searched = await memory.search("fruit salad", 5);
			expect(searched.map(result => result.content)).toEqual(results.map(result => result.content));
		} finally {
			memory.close();
		}
	});

	it("keeps local recall order when rerank scores are malformed", async () => {
		const memory = openMemory({
			reranker: {
				provider: {
					rerank: async () => [{ index: 0, relevanceScore: 1 }],
				},
			},
		});
		try {
			memory.remember("alpha fruit salad");
			memory.remember("omega fruit salad");
			const localOrder = await withMnemopiRuntimeOptions({ reranker: { disabled: true } }, () =>
				memory.beam.recall("fruit salad", 5),
			);
			const results = await memory.recall("fruit salad", 5);
			expect(results.map(result => result.content)).toEqual(localOrder.map(result => result.content));
			expect(results.every(result => result.rerank_score === undefined)).toBe(true);
		} finally {
			memory.close();
		}
	});

	it("keeps local recall order when the reranker request fails", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("nope", { status: 500 }),
		});
		const memory = openMemory({
			reranker: {
				apiUrl: server.url.toString().replace(/\/+$/, ""),
				apiKey: "test-rerank-key",
				model: DEFAULT_RERANKER_MODEL,
			},
		});
		try {
			memory.remember("alpha fruit salad");
			memory.remember("omega fruit salad");
			const results = await memory.recall("fruit salad", 5);
			expect(results.length).toBe(2);
			expect(results.every(result => result.rerank_score === undefined)).toBe(true);
		} finally {
			memory.close();
			server.stop(true);
		}
	});

	it("does not call the reranker when ranking is disabled", async () => {
		let called = 0;
		const scores = await withMnemopiRuntimeOptions(
			{
				reranker: {
					disabled: true,
					provider: {
						rerank: async () => {
							called += 1;
							return [{ index: 1, relevanceScore: 1 }];
						},
					},
				},
			},
			async () => {
				expect(await rerankerAvailable()).toBe(false);
				return await rerank("q", ["a", "b"]);
			},
		);
		expect(scores).toBeNull();
		expect(called).toBe(0);
	});
});
