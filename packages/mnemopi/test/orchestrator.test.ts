import { afterEach, describe, expect, it } from "bun:test";
import { type BeamMemoryState, initBeam, type RecallResult } from "@oh-my-pi/pi-mnemopi/core/beam";
import { recall as beamRecall, recallEnhanced as beamRecallEnhanced } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { resetEmbeddingProviderForTests, setEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import {
	type OrchestratorBeam,
	OrchestratorQueryCache,
	orchestrateRecall,
} from "@oh-my-pi/pi-mnemopi/core/orchestrator";
import { PolyphonicRecallEngine } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

interface FakeBeam extends BeamMemoryState {
	linearCalls: number;
	enhancedCalls: number;
	recall: (query: string, topK?: number) => Promise<RecallResult[]>;
	recallEnhanced: (query: string, topK?: number) => Promise<RecallResult[]>;
}

function fakeBeam(): FakeBeam {
	const db = openDatabase(":memory:", { create: true, readwrite: true });
	initBeam(db);
	const beam: FakeBeam = {
		db,
		sessionId: "orchestrator-test",
		authorId: null,
		authorType: null,
		channelId: "orchestrator-test",
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
		},
		linearCalls: 0,
		enhancedCalls: 0,
		async recall(query: string, topK = 20): Promise<RecallResult[]> {
			this.linearCalls += 1;
			return [{ id: "linear", content: `${query}:${topK}`, score: 1 }];
		},
		async recallEnhanced(query: string, topK = 20): Promise<RecallResult[]> {
			this.enhancedCalls += 1;
			return [{ id: "enhanced", content: `${query}:${topK}`, score: 2 }];
		},
	};
	return beam;
}

function insertWorking(
	beam: BeamMemoryState,
	id: string,
	content: string,
	options: { sessionId?: string; scope?: string } = {},
): void {
	const now = new Date().toISOString();
	beam.db.run(
		`INSERT INTO working_memory
			(id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, scope, created_at)
			VALUES (?, ?, 'test', ?, ?, 0.8, '{}', 'unknown', 'unknown', ?, ?)`,
		[id, content, now, options.sessionId ?? beam.sessionId, options.scope ?? "global", now],
	);
}

const previousPolyphonic = process.env.MNEMOPI_POLYPHONIC_RECALL;
const previousEnhancedRecall = process.env.MNEMOPI_ENHANCED_RECALL;

afterEach(() => {
	// A leaked embedding provider would silently change every later test in the file, so reset it
	// here rather than only in the block that installs one.
	resetEmbeddingProviderForTests();
	if (previousPolyphonic === undefined) delete process.env.MNEMOPI_POLYPHONIC_RECALL;
	else process.env.MNEMOPI_POLYPHONIC_RECALL = previousPolyphonic;
	if (previousEnhancedRecall === undefined) delete process.env.MNEMOPI_ENHANCED_RECALL;
	else process.env.MNEMOPI_ENHANCED_RECALL = previousEnhancedRecall;
});

describe("orchestrateRecall", () => {
	it("delegates to the Beam linear recall surface when the polyphonic gate is off", async () => {
		const beam = fakeBeam();
		try {
			process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
			const results = await orchestrateRecall(beam, "needle", 7);
			expect(results).toEqual([{ id: "linear", content: "needle:7", score: 1 }]);
			expect(beam.linearCalls).toBe(1);
			expect(beam.enhancedCalls).toBe(0);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("delegates to enhanced recall when requested on the non-polyphonic path", async () => {
		const beam = fakeBeam();
		try {
			delete process.env.MNEMOPI_POLYPHONIC_RECALL;
			const results = await orchestrateRecall(beam, "needle", 3, { enhanced: true });
			expect(results).toEqual([{ id: "enhanced", content: "needle:3", score: 2 }]);
			expect(beam.linearCalls).toBe(0);
			expect(beam.enhancedCalls).toBe(1);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("uses polyphonic recall instead of fake Beam recall when the gate is on", async () => {
		const beam = fakeBeam();
		try {
			const engine = new PolyphonicRecallEngine({ db: beam.db });
			insertWorking(beam, "m-poly", "Alice orchestrator polyphonic memory");
			beam.db.run(
				`INSERT INTO gists (id, text, timestamp, participants_json, memory_id)
					VALUES ('gist_m-poly', 'Alice orchestrator gist', ?, ?, 'm-poly')`,
				[new Date().toISOString(), JSON.stringify(["Alice"])],
			);
			beam.caches.polyphonicEngine = engine;
			process.env.MNEMOPI_POLYPHONIC_RECALL = "1";
			const results = await orchestrateRecall(beam, "Alice", 5);
			expect(beam.linearCalls).toBe(0);
			expect(beam.enhancedCalls).toBe(0);
			expect(results[0]?.id).toBe("m-poly");
			// Weighted RRF: graph contributes voiceWeights.graph / (RRF_K + rank).
			expect(results[0]?.voice_scores).toEqual({ graph: 0.4 / 61 });
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("forceLinear bypasses the env gate for A/B callers", async () => {
		const beam = fakeBeam();
		try {
			process.env.MNEMOPI_POLYPHONIC_RECALL = "1";
			const results = await orchestrateRecall(beam, "needle", 2, { forceLinear: true });
			expect(results[0]?.id).toBe("linear");
			expect(beam.linearCalls).toBe(1);
		} finally {
			closeQuietly(beam.db);
		}
	});
});

describe("cacheDiscriminator visibility widening", () => {
	function visibilityBeam(sessionId: string): OrchestratorBeam & { close(): void } {
		const db = openDatabase(":memory:", { create: true, readwrite: true });
		initBeam(db);
		const beam: OrchestratorBeam & { close(): void } = {
			db,
			sessionId,
			authorId: null,
			authorType: null,
			channelId: sessionId,
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
			},
			// Wire the real linear recall path (not a stub) so `buildWhere`'s session-visibility
			// filter -- the thing this test is actually exercising -- runs for real.
			recall: (query, topK, options) => beamRecall(beam, query, topK, options),
			recallEnhanced: (query, topK, options) => beamRecallEnhanced(beam, query, topK, options),
			close() {
				closeQuietly(db);
			},
		};
		return beam;
	}

	it("never lets a visibility-widened call poison a session-scoped call's cache bucket", async () => {
		process.env.MNEMOPI_ENHANCED_RECALL = "1";
		process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
		const beam = visibilityBeam("session-a");
		try {
			// One beam, two sessions' rows, neither `global`-scoped -- session-a's own recall must
			// never see session-b's row unless a call explicitly widens visibility.
			insertWorking(beam, "a-1", "zylophant migration checklist engineering rollout", {
				sessionId: "session-a",
				scope: "session",
			});
			insertWorking(beam, "b-1", "zylophant migration checklist finance rollout", {
				sessionId: "session-b",
				scope: "session",
			});

			const query = "zylophant migration checklist rollout";
			// `queryEmbedding: null` opts out of auto-embedding so this only exercises the FTS +
			// `buildWhere` visibility path, not tier2/3 cosine matching.
			const scopedOptions = { queryEmbedding: null } as const;

			const scoped = await orchestrateRecall(beam, query, 5, scopedOptions);
			expect(scoped.map(result => result.id)).toEqual(["a-1"]);

			// Same query and topK as the scoped call above -- only `ignoreSessionScope` differs --
			// which is exactly the shape a poisoned shared bucket could not tell apart pre-fix.
			const widened = await orchestrateRecall(beam, query, 5, { ...scopedOptions, ignoreSessionScope: true });
			expect(widened.map(result => result.id).sort()).toEqual(["a-1", "b-1"]);

			const cache = beam.caches.queryCache;
			if (!(cache instanceof OrchestratorQueryCache)) throw new Error("expected an OrchestratorQueryCache");
			// Two distinct discriminators must mean two distinct physical buckets, each holding its
			// own entry for the identical query text.
			expect(cache.stats().size).toBe(2);

			// Repeating the scoped call byte-identically must still be a cache hit, and it must
			// still be scoped to session-a only -- unaffected by the widened call in between.
			const repeat = await orchestrateRecall(beam, query, 5, scopedOptions);
			expect(repeat).toEqual(scoped);
			expect(cache.stats().hits).toBeGreaterThanOrEqual(1);
		} finally {
			beam.close();
		}
	});

	it("separates cache buckets by length-normalization mode", async () => {
		process.env.MNEMOPI_ENHANCED_RECALL = "1";
		process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
		const beam = visibilityBeam("session-a");
		try {
			insertWorking(beam, "long", `quokka protocol ${"background ".repeat(500)}`, {
				sessionId: "session-a",
				scope: "session",
			});
			insertWorking(beam, "short", "quokka protocol concise answer", {
				sessionId: "session-a",
				scope: "session",
			});
			const common = { queryEmbedding: null } as const;

			await orchestrateRecall(beam, "quokka protocol", 2, {
				...common,
				lengthNormalization: "none",
			} as never);
			await orchestrateRecall(beam, "quokka protocol", 2, {
				...common,
				lengthNormalization: "log",
			} as never);
			await orchestrateRecall(beam, "quokka protocol", 2, {
				...common,
				lengthNormalization: "log",
				scoreFloor: 1,
			} as never);

			const cache = beam.caches.queryCache;
			if (!(cache instanceof OrchestratorQueryCache)) throw new Error("expected an OrchestratorQueryCache");
			expect(cache.stats().size).toBe(3);
		} finally {
			beam.close();
		}
	});

	it("separates cache buckets by contentPreviewChars", async () => {
		// QueryCache tier 1 keys on the normalized query alone and returns BEFORE the embedding is
		// consulted, so a 100-char-preview call and a clipping-disabled call would otherwise share a
		// bucket and the second would be served the first one's truncated rows.
		process.env.MNEMOPI_ENHANCED_RECALL = "1";
		process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
		const beam = visibilityBeam("session-preview");
		try {
			insertWorking(beam, "prev", `quokka protocol ${"detail ".repeat(80)}`, {
				sessionId: "session-preview",
				scope: "session",
			});
			const common = { queryEmbedding: null } as const;
			await orchestrateRecall(beam, "quokka protocol", 2, { ...common } as never);
			await orchestrateRecall(beam, "quokka protocol", 2, { ...common, contentPreviewChars: 100 } as never);
			await orchestrateRecall(beam, "quokka protocol", 2, { ...common, contentPreviewChars: 0 } as never);
			const cache = beam.caches.queryCache;
			if (!(cache instanceof OrchestratorQueryCache)) throw new Error("expected an OrchestratorQueryCache");
			expect(cache.stats().size).toBe(3);
		} finally {
			beam.close();
		}
	});

	it("does NOT partition buckets by the AUTO-DERIVED embedding (provider-backed)", async () => {
		// The discriminator must key on the CALLER's input, never the resolved embedding. Keying on
		// the resolved value gives every distinct query text its own physical bucket and destroys the
		// cross-query similarity matching QueryCache tier 2/3 exists to provide.
		//
		// This needs a real provider: with none configured embedQuery returns null for EVERY query,
		// so all auto calls resolve identically and the test could not tell correct keying from
		// per-query fragmentation. The provider below returns a DISTINCT, non-null vector per query
		// text, which is what makes the bug observable.
		process.env.MNEMOPI_ENHANCED_RECALL = "1";
		process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
		// EmbeddingOutput is AsyncIterable<number[][]>, so the provider MUST be an async generator.
		// Returning a plain array type-checks under a loose cast but is unusable at runtime: embed()
		// yields nothing, embedQuery returns null for every query, and both auto calls then resolve
		// identically — which would make this test unable to see per-query fragmentation at all.
		let embedCalls = 0;
		const embedded: string[] = [];
		const resolved: string[] = [];
		setEmbeddingProviderForTests({
			embed: async function* embedForTest(texts: readonly string[]) {
				embedCalls += 1;
				const vectors = texts.map(text => {
					embedded.push(text);
					// Explicit mapping, not a hash: two orthogonal vectors, so cosine similarity is 0
					// and tier 2/3 cannot conflate the two queries. A hash-mod-N scheme could collide
					// and silently make the two resolved vectors identical, which is the one condition
					// under which this test stops being able to see per-query fragmentation.
					// "quokka protocol" and its restatement share ONE vector; the third text is
					// orthogonal. The shared pair is what lets the tier-2/3 assertion below prove the
					// resolved embedding actually reached the cache.
					const vector: number[] = text === "entirely different question" ? [0, 1] : [1, 0];
					resolved.push(vector.join(","));
					return vector;
				});
				yield vectors;
			},
			available: () => true,
		});
		const beam = visibilityBeam("session-auto");
		try {
			insertWorking(beam, "auto", "quokka protocol auto embedding", { sessionId: "session-auto", scope: "session" });
			// All three calls leave queryEmbedding UNDEFINED, so each auto-derives its own vector.
			await orchestrateRecall(beam, "quokka protocol", 2, {} as never);
			await orchestrateRecall(beam, "entirely different question", 2, {} as never);
			// Third text, DIFFERENT wording but the SAME resolved vector as the first query.
			await orchestrateRecall(beam, "quokka protocol restated differently", 2, {} as never);
			const cache = beam.caches.queryCache;
			if (!(cache instanceof OrchestratorQueryCache)) throw new Error("expected an OrchestratorQueryCache");
			// Non-vacuity: the provider really auto-derived a vector for BOTH distinct query texts.
			expect(embedCalls).toBeGreaterThanOrEqual(2);
			expect(new Set(embedded).size).toBeGreaterThanOrEqual(2);
			// And the vectors really were DISTINCT — otherwise identical resolved values would make
			// correct keying and per-query fragmentation indistinguishable.
			expect(new Set(resolved).size).toBeGreaterThanOrEqual(2);
			// ONE bucket despite two different resolved vectors. stats().size counts ENTRIES, so only
			// bucketCount distinguishes this from two single-entry buckets.
			expect(cache.bucketCount).toBe(1);
			// NON-VACUITY, the assertion that matters: the third query has different text but the same
			// resolved vector as the first, so it can only be served through embedding-similarity
			// matching. A provider whose output never reaches the orchestrator (for example returning a
			// plain array where AsyncIterable is required) yields null embeddings, produces no such hit,
			// and fails here. Counting provider invocations cannot detect that, because the function is
			// still called -- only its result is discarded.
			const stats = cache.stats();
			expect(stats.tier2_hits + stats.tier3_hits).toBeGreaterThanOrEqual(1);
		} finally {
			beam.close();
			resetEmbeddingProviderForTests();
		}
	});

	it("keeps every caller embedding state in its own bucket", async () => {
		// undefined = auto-derive, null = explicitly FTS-only, number[] = caller-supplied. These
		// produce different result sets, so collapsing any two of them serves wrong rows.
		process.env.MNEMOPI_ENHANCED_RECALL = "1";
		process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
		const beam = visibilityBeam("session-embed");
		try {
			insertWorking(beam, "emb", "quokka protocol embedding discrimination", {
				sessionId: "session-embed",
				scope: "session",
			});
			const a = new Array(8).fill(0).map((_, index) => (index === 0 ? 1 : 0));
			const b = new Array(8).fill(0).map((_, index) => (index === 1 ? 1 : 0));
			await orchestrateRecall(beam, "quokka protocol", 2, {} as never); // auto
			await orchestrateRecall(beam, "quokka protocol", 2, { queryEmbedding: null } as never); // FTS-only
			await orchestrateRecall(beam, "quokka protocol", 2, { queryEmbedding: a } as never);
			await orchestrateRecall(beam, "quokka protocol", 2, { queryEmbedding: b } as never);
			// An EMPTY array is a fourth state: not auto, not FTS-only, and not a usable vector.
			await orchestrateRecall(beam, "quokka protocol", 2, { queryEmbedding: [] } as never);
			// The SAME vector again must reuse its bucket rather than creating a sixth.
			await orchestrateRecall(beam, "quokka protocol", 2, { queryEmbedding: a } as never);
			const cache = beam.caches.queryCache;
			if (!(cache instanceof OrchestratorQueryCache)) throw new Error("expected an OrchestratorQueryCache");
			expect(cache.bucketCount).toBe(5);
		} finally {
			beam.close();
		}
	});

	it("separates cache buckets by poolFloor, so an A/B never serves the other arm's rows", async () => {
		// poolFloor was added as a forwarded orchestrateRecall option without a discriminator term,
		// so two calls differing ONLY in poolFloor shared a bucket and the second was served the
		// first arm's rows — silently wrong in exactly the A/B comparison the knob exists for.
		process.env.MNEMOPI_ENHANCED_RECALL = "1";
		process.env.MNEMOPI_POLYPHONIC_RECALL = "1";
		const beam = visibilityBeam("session-pool");
		try {
			insertWorking(beam, "pool-a", "quokka protocol primary answer row", {
				sessionId: "session-pool",
				scope: "session",
			});
			insertWorking(beam, "pool-b", "quokka protocol secondary answer row", {
				sessionId: "session-pool",
				scope: "session",
			});
			const common = { queryEmbedding: null } as const;

			await orchestrateRecall(beam, "quokka protocol", 2, { ...common } as never);
			await orchestrateRecall(beam, "quokka protocol", 2, { ...common, poolFloor: 0.05 } as never);
			await orchestrateRecall(beam, "quokka protocol", 2, { ...common, poolFloor: 0.2 } as never);
			// An explicit 0 must land in the SAME bucket as absent: 0 is the inert value.
			await orchestrateRecall(beam, "quokka protocol", 2, { ...common, poolFloor: 0 } as never);

			const cache = beam.caches.queryCache;
			if (!(cache instanceof OrchestratorQueryCache)) throw new Error("expected an OrchestratorQueryCache");
			expect(cache.stats().size).toBe(3);
		} finally {
			beam.close();
		}
	});
});
