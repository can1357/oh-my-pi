import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { clipRecallContent, recall, recallEnhanced } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { createReranker, executeRerank, type RerankFunction } from "@oh-my-pi/pi-mnemopi/core/rerank";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { rerankApiKey } from "@oh-my-pi/pi-mnemopi/config";
import { mmrRerank } from "@oh-my-pi/pi-mnemopi/core/mmr";
import { orchestrateRecall } from "@oh-my-pi/pi-mnemopi/core/orchestrator";
import { POLYPHONIC_MAX_COMBINED_SCORE } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";

type TestBeam = BeamMemoryState & { close(): void };
const openBeams: TestBeam[] = [];

afterEach(() => {
	for (const beam of openBeams.splice(0, openBeams.length)) {
		beam.close();
	}
});

function makeTestBeam(config: Partial<BeamMemoryState["config"]> & { rerankFn?: RerankFunction } = {}): TestBeam {
	const db = new Database(":memory:");
	const { rerankFn, ...beamConfig } = config;
	initBeam(db);
	const beam: TestBeam = {
		db,
		sessionId: "s1",
		authorId: null,
		authorType: null,
		channelId: "s1",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
			...beamConfig,
			reranker: beamConfig.reranker ?? (rerankFn ? createReranker({ fn: rerankFn }) : undefined),
		},
		close() {
			db.close();
		},
	};
	openBeams.push(beam);
	return beam;
}

function insertWorking(
	beam: TestBeam,
	id: string,
	content: string,
	options: { timestamp?: string; importance?: number; sessionId?: string; scope?: string } = {},
): void {
	beam.db.run(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type) VALUES (?, ?, 'test', ?, ?, ?, ?, 'unknown', 'general')",
		[
			id,
			content,
			options.timestamp ?? "2026-05-30T12:00:00.000Z",
			options.sessionId ?? beam.sessionId,
			options.importance ?? 0.5,
			options.scope ?? "global",
		],
	);
}

describe("recall without a reranker", () => {
	for (const polyphonic of [false, true]) {
		it(`preserves the pre-reranker ${polyphonic ? "polyphonic" : "linear"} single-bank selection`, async () => {
			const beam = makeTestBeam({ polyphonicRecall: polyphonic });
			insertWorking(beam, "a", `deployment shared notes ${"x".repeat(600)}`, { importance: 0.9 });
			insertWorking(beam, "b", "deployment shared checklist", { importance: 0.8 });
			insertWorking(beam, "c", "deployment database backup", { importance: 0.7 });
			const options = { queryEmbedding: null, useCache: false, updateRecallCounts: false };
			const topK = 2;
			const baselineLimit = polyphonic ? topK * 2 : topK;
			const baseline = await recall(beam, "deployment", baselineLimit * 2, {
				...options,
				useSynonyms: true,
				useIntent: true,
				useMmr: true,
			});
			baseline.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
			const selected = mmrRerank(baseline, 0.7, baselineLimit);
			let expected = selected;
			if (polyphonic) {
				const fused = await orchestrateRecall(beam, "deployment", baselineLimit, {
					...options,
					baseline: selected,
					forcePolyphonic: true,
					contextBudget: Number.POSITIVE_INFINITY,
				});
				expected = fused.slice(0, topK).map(result => {
					const mapped = {
						...result,
						score: Math.round(((result.combined_score ?? 0) / POLYPHONIC_MAX_COMBINED_SCORE) * 10000) / 10000,
					};
					if (typeof mapped.truncated !== "boolean") {
						const preview = clipRecallContent(mapped.content);
						mapped.content = preview.content;
						mapped.truncated = preview.truncated;
						mapped.full_length = preview.fullLength;
					}
					return mapped;
				});
			}
			expect(await recallEnhanced(beam, "deployment", topK, options)).toEqual(expected);
		});
	}
});

describe("Cross-encoder rerank in Mnemopi recall", () => {
	it("reorders candidates by rerank relevance score", async () => {
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async (_query, documents) => {
				return documents.map((doc, idx) => ({
					index: idx,
					relevanceScore: doc.includes("target priority") ? 0.99 : 0.05,
				}));
			},
		});

		insertWorking(beam, "mem-1", "general deployment notes with python");
		insertWorking(beam, "mem-2", "deployment plan: the target priority documentation is here");
		insertWorking(beam, "mem-3", "database backup procedures for deployment");

		const results = await recallEnhanced(beam, "deployment", 3, { useCache: false });
		expect(results.length).toBeGreaterThanOrEqual(2);
		expect(results[0]?.id).toBe("mem-2");
		expect(results[0]?.score).toBe(0.99);
	});
	it("promotes lower-ranked candidates into topK with polyphonic recall", async () => {
		const beam = makeTestBeam({
			polyphonicRecall: true,
			rerankFn: async (_query, documents) => {
				return documents.map((doc, idx) => ({
					index: idx,
					relevanceScore: doc.includes("target priority") ? 0.98 : 0.1,
				}));
			},
		});

		insertWorking(beam, "mem-1", "general deployment notes with python");
		insertWorking(beam, "mem-2", "deployment plan: the target priority documentation is here");
		insertWorking(beam, "mem-3", "database backup procedures for deployment");

		const results = await recallEnhanced(beam, "deployment", 1, { useCache: false });
		expect(results.length).toBe(1);
		expect(results[0]?.id).toBe("mem-2");
		expect(results[0]?.score).toBe(0.98);
	});

	it("works through Mnemopi facade with custom rerankFn", async () => {
		const memory = new Mnemopi({
			dbPath: ":memory:",
			noEmbeddings: true,
			polyphonicRecall: false,
			rerankFn: async (_query, documents) => {
				return documents.map((doc, idx) => ({
					index: idx,
					relevanceScore: doc.includes("promoted") ? 0.95 : 0.2,
				}));
			},
		});

		try {
			memory.remember("normal release note for deployment");
			memory.remember("promoted release note for deployment");
			const results = await memory.recallEnhanced("deployment", 1, { useCache: false });
			expect(results.length).toBe(1);
			expect(results[0]?.content).toContain("promoted");
			expect(results[0]?.score).toBe(0.95);
		} finally {
			memory.close();
		}
	});

	it("falls back to first-stage ranking if rerank function throws", async () => {
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async () => {
				throw new Error("Reranker gateway timeout (504)");
			},
		});

		insertWorking(beam, "mem-1", "primary deployment notes");
		insertWorking(beam, "mem-2", "secondary deployment notes");

		const results = await recallEnhanced(beam, "deployment", 2, { useCache: false });
		expect(results.length).toBe(2);
		expect(results.map(r => r.id)).toContain("mem-1");
	});

	it("falls back to first-stage ranking if rerank function returns null", async () => {
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async () => null,
		});

		insertWorking(beam, "mem-1", "primary deployment notes");
		insertWorking(beam, "mem-2", "secondary deployment notes");

		const results = await recallEnhanced(beam, "deployment", 2, { useCache: false });
		expect(results.length).toBe(2);
		expect(results.map(r => r.id)).toContain("mem-1");
	});
	it("preserves veracity penalty and does not promote false memories", async () => {
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async (_query, documents) => {
				return documents.map((doc, idx) => ({
					index: idx,
					relevanceScore: doc.includes("false") ? 0.99 : 0.5,
				}));
			},
		});

		insertWorking(beam, "mem-valid", "deployment documentation for cluster");
		insertWorking(beam, "mem-false", "false deployment documentation for cluster", { scope: "global" });
		beam.db.run("UPDATE working_memory SET veracity = 'false' WHERE id = 'mem-false'");

		const results = await recallEnhanced(beam, "deployment", 2, { useCache: false });
		const falseResult = results.find(r => r.id === "mem-false");
		expect(falseResult?.score).toBe(Number.NEGATIVE_INFINITY);
		expect(results[0]?.id).toBe("mem-valid");
	});

	it("scores full candidate content beyond 500-char preview cap", async () => {
		let receivedDocs: readonly string[] = [];
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async (_query, documents) => {
				receivedDocs = documents;
				return documents.map((_, idx) => ({ index: idx, relevanceScore: 0.9 }));
			},
		});

		const longContent = "deployment note prefix ".repeat(30) + " UNIQUE_DEEP_TARGET_KEYWORD";
		expect(longContent.length).toBeGreaterThan(600);
		insertWorking(beam, "mem-long", longContent);
		insertWorking(beam, "mem-other", "deployment note other");

		const results = await recallEnhanced(beam, "deployment", 2, { useCache: false });
		expect(results.length).toBe(2);
		const hit = results.find(r => r.id === "mem-long");
		expect(hit?.truncated).toBe(true);
		expect(hit?.content.length).toBeLessThan(510);
		expect("full_content" in (hit as object)).toBe(false);
		expect(receivedDocs.some(doc => doc.includes("UNIQUE_DEEP_TARGET_KEYWORD"))).toBe(true);
	});

	it("preserves head and tail via clipToWindow for oversized rerank inputs", async () => {
		let receivedDocs: readonly string[] = [];
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async (_query, documents) => {
				receivedDocs = documents;
				return documents.map((_, idx) => ({ index: idx, relevanceScore: 0.9 }));
			},
		});

		const headPart = "opening deployment context header: cluster primary setup. ";
		const filler = "filler sentence for document length expansion. ".repeat(120);
		const tailPart = " trailing deployment conclusion: final port 9090 configuration.";
		const oversized = headPart + filler + tailPart;
		expect(oversized.length).toBeGreaterThan(5000);

		insertWorking(beam, "mem-oversized", oversized);
		insertWorking(beam, "mem-other", "opening deployment context other");

		await recallEnhanced(beam, "deployment", 2, { useCache: false });
		const sentDoc = receivedDocs.find(doc => doc.includes("primary setup"));
		expect(sentDoc).toBeDefined();
		expect(sentDoc!.length).toBeLessThanOrEqual(4096);
		expect(sentDoc!).toContain("primary setup");
		expect(sentDoc!).toContain("port 9090");
		expect(sentDoc!).toContain("[...]");
	});

	it("includes subject and predicate in reranked fact documents", async () => {
		let receivedDocs: readonly string[] = [];
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async (_query, documents) => {
				receivedDocs = documents;
				return documents.map((_, idx) => ({ index: idx, relevanceScore: 0.9 }));
			},
		});

		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence) VALUES ('fact-1', 's1', 'deployment', 'port', '8080', 1)",
		);

		await recallEnhanced(beam, "deployment port", 2, { includeFacts: true, useCache: false });
		expect(receivedDocs.some(doc => doc.includes("deployment") && doc.includes("8080"))).toBe(true);
	});

	it("does not truncate facts before MMR when reranking is inactive", async () => {
		const beam = makeTestBeam({
			polyphonicRecall: false,
		});

		insertWorking(beam, "mem-dup-1", "deploy cluster nodes in europe-west1");
		insertWorking(beam, "mem-dup-2", "deploy cluster nodes in europe-west1");
		insertWorking(beam, "mem-dup-3", "deploy cluster nodes in europe-west1");
		insertWorking(beam, "mem-dup-4", "deploy cluster nodes in europe-west1");

		beam.db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence) VALUES ('fact-div', 's1', 'cluster', 'status', 'online', 1)",
		);

		const results = await recallEnhanced(beam, "deploy cluster", 2, { includeFacts: true, useCache: false });
		expect(results.length).toBe(2);
		expect(results.some(r => r.tier_label === "fact")).toBe(true);
	});

	it("rejects incomplete reranker scores to avoid mixing scales", async () => {
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async () => [
				// Only 1 score returned for 2 candidates
				{ index: 0, relevanceScore: 0.99 },
			],
		});

		insertWorking(beam, "mem-1", "primary deployment notes");
		insertWorking(beam, "mem-2", "secondary deployment notes");

		const results = await recallEnhanced(beam, "deployment", 2, { useCache: false });
		expect(results.length).toBe(2);
	});

	it("rejects duplicate reranker indices to avoid corrupting candidate scores", async () => {
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async () => [
				// Duplicate index 0 returned for 2 candidates
				{ index: 0, relevanceScore: 0.3 },
				{ index: 0, relevanceScore: 0.4 },
			],
		});

		insertWorking(beam, "mem-1", "primary deployment notes", { importance: 0.95 });
		insertWorking(beam, "mem-2", "secondary deployment notes", { importance: 0.8 });

		const results = await recallEnhanced(beam, "deployment", 2, { useCache: false });
		expect(results.length).toBe(2);
		expect(results[0]?.id).toBe("mem-1");
	});

	it("short-circuits when topK <= 0", async () => {
		let rerankCalled = false;
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async () => {
				rerankCalled = true;
				return [];
			},
		});

		insertWorking(beam, "mem-1", "primary deployment notes");
		const results = await recallEnhanced(beam, "deployment", 0, { useCache: false });
		expect(results).toEqual([]);
		expect(rerankCalled).toBe(false);
	});

	it("scores singleton candidate pools for cross-bank calibration", async () => {
		let rerankCalled = false;
		const beam = makeTestBeam({
			polyphonicRecall: false,
			rerankFn: async (_query, _documents) => {
				rerankCalled = true;
				return [{ index: 0, relevanceScore: 0.99 }];
			},
		});

		insertWorking(beam, "mem-single", "deployment documentation notes");
		const results = await recallEnhanced(beam, "deployment", 1, { useCache: false });
		expect(results.length).toBe(1);
		expect(rerankCalled).toBe(true);
		expect(results[0]?.score).toBe(0.99);
	});

	it("caches first-stage candidates but reranks on each recall", async () => {
		let calls = 0;
		const beam = makeTestBeam({
			enhancedRecall: true,
			rerankFn: async (_query, documents) => {
				calls++;
				return documents.map((_, index) => ({ index, relevanceScore: index === calls - 1 ? 0.99 : 0.1 }));
			},
		});
		insertWorking(beam, "cache-a", "deployment notes one");
		insertWorking(beam, "cache-b", "deployment notes two");
		const first = await recallEnhanced(beam, "deployment", 1);
		const second = await recallEnhanced(beam, "deployment", 1);
		expect(calls).toBe(2);
		expect(first[0]?.id).not.toBe(second[0]?.id);
		expect(beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, misses: 1 });
	});

	it("resolves cohere fallback api key against effective url", () => {
		const env = { COHERE_API_KEY: "cohere-secret-key" };
		const resolved = rerankApiKey("https://api.cohere.com/v1", env);
		expect(resolved).toBe("cohere-secret-key");
		expect(rerankApiKey("http://localhost:8080", env)).toBe("");
	});
});

describe("executeRerank HTTP client", () => {
	it("parses OpenAI/OpenRouter wire responses", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			return Response.json({
				model: "bge-reranker-v2-m3",
				results: [
					{ index: 1, relevance_score: 0.88 },
					{ index: 0, relevance_score: 0.12 },
				],
			});
		}) as unknown as typeof fetch;

		try {
			const scores = await executeRerank("cats", ["dogs", "cats purr"], {
				apiUrl: "http://127.0.0.1:9999/v1",
			});
			expect(scores).toEqual([
				{ index: 1, relevanceScore: 0.88 },
				{ index: 0, relevanceScore: 0.12 },
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("parses Text Embeddings Inference (TEI) wire responses", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			return Response.json([
				{ index: 1, score: -0.53 },
				{ index: 0, score: -3.41 },
			]);
		}) as unknown as typeof fetch;

		try {
			const scores = await executeRerank("cats", ["dogs", "cats purr"], {
				apiUrl: "http://127.0.0.1:9999",
				model: "bge-reranker-v2-m3",
			});
			expect(scores?.[0]?.index).toBe(1);
			expect(scores?.[0]?.relevanceScore).toBeCloseTo(0.37, 2);
			expect(scores?.[1]?.index).toBe(0);
			expect(scores?.[1]?.relevanceScore).toBeCloseTo(0.03, 2);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns null on HTTP errors without throwing", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			return new Response("Gateway Timeout", { status: 504 });
		}) as unknown as typeof fetch;

		try {
			const scores = await executeRerank("cats", ["dogs", "cats purr"], {
				apiUrl: "http://127.0.0.1:9999",
				maxAttempts: 1,
			});
			expect(scores).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("honors timeout when caller supplies a cancellation signal", async () => {
		const originalFetch = globalThis.fetch;
		const callerController = new AbortController();
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => {
				reject(new DOMException("The operation was aborted.", "AbortError"));
			});
			return promise;
		}) as unknown as typeof fetch;

		try {
			const start = Date.now();
			const scores = await executeRerank("cats", ["dogs"], {
				apiUrl: "http://127.0.0.1:9999",
				signal: callerController.signal,
				timeoutMs: 25,
				maxAttempts: 1,
			});
			const elapsed = Date.now() - start;
			expect(scores).toBeNull();
			expect(elapsed).toBeLessThan(100);
			expect(callerController.signal.aborted).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
