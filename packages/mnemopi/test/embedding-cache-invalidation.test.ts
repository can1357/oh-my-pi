/**
 * Regression: a recall taken while background embeddings are still generating caches an FTS-only
 * ranking. Committing the vectors changes what recall returns, but the commit did not invalidate
 * that cache, so the pre-embedding order kept being served for the whole cache TTL (one hour).
 *
 * The invalidation is deliberately gated on rows actually committing: a provider that returns a
 * short or empty matrix inserts nothing, changes no ranking, and must not discard a valid cache.
 */
import { describe, expect, it } from "bun:test";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { remember } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamEvent, BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { resetEmbeddingProviderForTests, setEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

function makeState(sessionId = "session-a", events: BeamEvent[] = []): BeamMemoryState {
	const db = openDatabase(":memory:");
	initBeam(db);
	const state: BeamMemoryState = {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "author-a",
		authorType: "user",
		channelId: "channel-a",
		useCloud: false,
		eventEmitter: event => {
			events.push(event);
		},
		pluginManager: {
			emit: event => {
				events.push({ ...event, type: `plugin:${event.type}` });
			},
		},
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
	};
	return state;
}

/** Counts invalidations and lets a test resolve the provider on demand, so ordering is provable. */
function instrument(sessionId: string): {
	beam: BeamMemoryState;
	counts: { invalidations: number };
} {
	const beam = makeState(sessionId);
	const counts = { invalidations: 0 };
	(beam.caches as { queryCache?: { invalidate: () => void } }).queryCache = {
		invalidate: () => {
			counts.invalidations += 1;
		},
	};
	beam.pendingExtractions = new Set();
	return { beam, counts };
}

describe("embedding commit invalidates the recall cache", () => {
	it("invalidates exactly once, and only AFTER the vectors are committed", async () => {
		const { beam, counts } = instrument("embed-invalidate");
		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		setEmbeddingProviderForTests({
			embed: async function* embedForTest(texts: readonly string[]) {
				await gate; // held open so the assertions below run BEFORE any commit
				yield texts.map(() => [0.1, 0.2, 0.3]);
			},
			available: () => true,
		});
		try {
			remember(beam, "a memory that will be embedded in the background", { source: "conversation" });
			counts.invalidations = 0; // remember() invalidates synchronously; measure only the commit
			const pending = [...(beam.pendingExtractions ?? [])];
			expect(pending).toHaveLength(1);
			// Provider still blocked: nothing committed, so nothing invalidated yet.
			const before = beam.db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get() as {
				count: number;
			};
			expect(before.count).toBe(0);
			expect(counts.invalidations).toBe(0);

			release();
			await Promise.all(pending);

			const after = beam.db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get() as {
				count: number;
			};
			expect(after.count).toBe(1);
			expect(counts.invalidations).toBe(1);
		} finally {
			resetEmbeddingProviderForTests();
			beam.db.close();
		}
	});

	it("does NOT invalidate when the batch commits no rows", async () => {
		const { beam, counts } = instrument("embed-no-commit");
		setEmbeddingProviderForTests({
			// Empty matrix: every item's vector is undefined, so nothing is inserted.
			embed: async function* embedForTest() {
				yield [] as number[][];
			},
			available: () => true,
		});
		try {
			remember(beam, "a memory whose embedding batch returns nothing", { source: "conversation" });
			counts.invalidations = 0;
			await Promise.all([...(beam.pendingExtractions ?? [])]);
			const stored = beam.db.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get() as {
				count: number;
			};
			expect(stored.count).toBe(0);
			// No ranking changed, so a valid cache must be left in place.
			expect(counts.invalidations).toBe(0);
		} finally {
			resetEmbeddingProviderForTests();
			beam.db.close();
		}
	});
});
