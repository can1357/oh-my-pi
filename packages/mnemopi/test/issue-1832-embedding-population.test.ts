/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1832
 *
 * Before the fix:
 *   - `remember()`/`rememberBatch()` never invoked `embed()`, so the
 *     `memory_embeddings` table was always empty in production.
 *   - `recall()` never derived a query embedding from the query text,
 *     so the `dense_score` channel always read zero.
 *
 * This file pins both contracts using a deterministic in-process embedding
 * provider so the fix cannot silently regress in either direction.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import "./setup";
import { cmdRemember } from "@oh-my-pi/pi-mnemopi/cli";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import {
	type ResolvedMnemopiRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@oh-my-pi/pi-mnemopi/core/runtime-options";

interface EmbeddingRow {
	readonly memory_id: string;
	readonly embedding_json: string;
	readonly model: string | null;
}

/**
 * Deterministic fake provider: each text yields a 4-D vector based on the
 * presence of marker words. Different markers project onto orthogonal axes
 * so cosine similarity gives the expected nearest-neighbour ordering.
 */
function fakeProvider() {
	let callCount = 0;
	const provider = {
		// fastembed shape: async generator yielding batches of rows.
		async *embed(texts: readonly string[]) {
			callCount += 1;
			yield texts.map(text => {
				const lower = text.toLowerCase();
				if (lower.includes("alpha")) return [1, 0, 0, 0];
				if (lower.includes("beta")) return [0, 1, 0, 0];
				if (lower.includes("gamma")) return [0, 0, 1, 0];
				return [0, 0, 0, 1];
			});
		},
	};
	return { provider, calls: () => callCount };
}

function withFakeMemory<T>(fn: (memory: Mnemopi, calls: () => number) => Promise<T>): Promise<T> {
	const { provider, calls } = fakeProvider();
	const memory = new Mnemopi({
		db: new Database(":memory:"),
		embeddings: { provider: provider.embed.bind(provider) },
	});
	return fn(memory, calls).finally(() => memory.close());
}

/**
 * Re-enter the per-Mnemopi runtime-options scope when reaching into `memory.beam`
 * directly (only `Mnemopi.remember`/`recall`/etc. enter it automatically).
 */
function inScope<T>(memory: Mnemopi, fn: () => T): T {
	return withMnemopiRuntimeOptions(memory.runtimeOptions, fn);
}

function readEmbeddings(memory: Mnemopi): EmbeddingRow[] {
	return memory.conn
		.query("SELECT memory_id, embedding_json, model FROM memory_embeddings ORDER BY memory_id")
		.all() as EmbeddingRow[];
}

describe("issue #1832 — embedding write/read coverage", () => {
	it("remember() writes a row to memory_embeddings after flushExtractions()", async () => {
		await withFakeMemory(async (memory, calls) => {
			const memId = memory.remember("alpha facts about migration", { source: "test", importance: 0.5 });
			await memory.flushExtractions();

			const rows = readEmbeddings(memory);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.memory_id).toBe(memId);
			// Body matches the alpha-bucket projection from the fake provider.
			expect(JSON.parse(rows[0]?.embedding_json ?? "[]")).toEqual([1, 0, 0, 0]);
			// Provider was actually invoked — not the silent no-op of the pre-fix world.
			expect(calls()).toBeGreaterThanOrEqual(1);
		});
	});

	it("remember() uses embedText for embeddings and FTS while preserving stored content", async () => {
		const embeddedTexts: string[] = [];
		const provider = async function* (texts: readonly string[]) {
			embeddedTexts.push(...texts);
			yield texts.map(text => (text.includes("clean projection") ? [1, 0, 0, 0] : [0, 1, 0, 0]));
		};
		const memory = new Mnemopi({
			db: new Database(":memory:"),
			embeddings: { provider },
		});
		try {
			const raw =
				"[role: user]\nI always prefer tabs\n[user:end]\n\n[role: assistant]\nthe parser never initializes\n[assistant:end]";
			const id = memory.remember(raw, {
				source: "coding-agent-transcript",
				memoryType: "episode",
				embedText: "clean projection about parser",
			});
			await memory.flushExtractions();

			expect(memory.get(id)).toMatchObject({ content: raw });
			expect(embeddedTexts).toEqual(["clean projection about parser"]);
			expect(memory.conn.query("SELECT id FROM fts_working WHERE fts_working MATCH ?").all("clean")).toEqual([
				{ id },
			]);
			expect(memory.conn.query("SELECT id FROM fts_working WHERE fts_working MATCH ?").all("role")).toEqual([]);
			expect(JSON.parse(readEmbeddings(memory)[0]?.embedding_json ?? "[]")).toEqual([1, 0, 0, 0]);
			const ftsOnlyRecall = await memory.recall("clean", 5, { queryEmbedding: null });
			expect(ftsOnlyRecall[0]).toMatchObject({ id, content: raw });
		} finally {
			memory.close();
		}
	});

	it("rememberBatch() writes one embedding row per item in a single provider call", async () => {
		await withFakeMemory(async (memory, calls) => {
			const ids = inScope(memory, () =>
				memory.beam.rememberBatch([
					{ content: "alpha launch checklist" },
					{ content: "beta migration plan" },
					{ content: "gamma postmortem" },
				]),
			);
			await memory.flushExtractions();

			const rows = readEmbeddings(memory);
			expect(rows.map(row => row.memory_id).sort()).toEqual([...ids].sort());
			expect(calls()).toBe(1);
			const byId = new Map(rows.map(row => [row.memory_id, JSON.parse(row.embedding_json) as number[]]));
			expect(byId.get(ids[0] ?? "")).toEqual([1, 0, 0, 0]);
			expect(byId.get(ids[1] ?? "")).toEqual([0, 1, 0, 0]);
			expect(byId.get(ids[2] ?? "")).toEqual([0, 0, 1, 0]);
		});
	});

	it("recall() auto-derives queryEmbedding and surfaces a non-zero dense_score", async () => {
		await withFakeMemory(async (memory, calls) => {
			memory.remember("alpha launch checklist", { source: "test" });
			memory.remember("beta migration plan", { source: "test" });
			memory.remember("gamma postmortem", { source: "test" });
			await memory.flushExtractions();
			const callsAfterEmbedding = calls();

			const results = await memory.recall("alpha", 3);
			const alphaHit = results.find(row => row.content === "alpha launch checklist");

			expect(alphaHit).toBeDefined();
			expect(typeof alphaHit?.dense_score).toBe("number");
			expect(alphaHit?.dense_score ?? 0).toBeGreaterThan(0);
			// recall() must have invoked the provider for the query text (a single
			// embedQuery for "alpha") — proving auto-derive ran.
			expect(calls()).toBeGreaterThan(callsAfterEmbedding);
		});
	});

	it("recall() honours an explicit queryEmbedding: null (FTS-only) without auto-derive", async () => {
		await withFakeMemory(async (memory, calls) => {
			memory.remember("alpha launch checklist", { source: "test" });
			await memory.flushExtractions();
			const callsAfterEmbedding = calls();

			const results = await memory.recall("alpha", 3, { queryEmbedding: null });
			expect(results.length).toBeGreaterThan(0);
			// dense_score collapses to 0 when no query vector is computed.
			expect(results[0]?.dense_score ?? 0).toBe(0);
			// And the provider is never invoked for the query side.
			expect(calls()).toBe(callsAfterEmbedding);
		});
	});

	it("updateWorking() re-embeds when content changes", async () => {
		await withFakeMemory(async memory => {
			const id = memory.remember("alpha facts about migration", { source: "test" });
			await memory.flushExtractions();

			expect(memory.update(id, "gamma postmortem")).toBe(true);
			await memory.flushExtractions();

			const rows = readEmbeddings(memory);
			expect(rows).toHaveLength(1);
			// New content lands in the gamma bucket, replacing the alpha projection.
			expect(JSON.parse(rows[0]?.embedding_json ?? "[]")).toEqual([0, 0, 1, 0]);
		});
	});

	it("consolidateToEpisodic() writes an embedding for the new episodic id", async () => {
		await withFakeMemory(async memory => {
			const wmId = memory.remember("alpha launch checklist", { source: "test" });
			await memory.flushExtractions();

			const episodicId = inScope(memory, () =>
				memory.beam.consolidateToEpisodic("gamma postmortem summary", [wmId]),
			);
			await memory.flushExtractions();

			const rows = readEmbeddings(memory);
			const episodicRow = rows.find(row => row.memory_id === episodicId);
			expect(episodicRow).toBeDefined();
			expect(JSON.parse(episodicRow?.embedding_json ?? "[]")).toEqual([0, 0, 1, 0]);
		});
	});

	it("flushes pending embeddings before close so short-lived `mnemopi store` owners persist them", async () => {
		// Repro for #1833 review comment: CLI `cmdRemember` (via `withMemory`) and MCP
		// `handleRemember` (via `withBeam`) close the SQLite handle immediately after the
		// synchronous `remember()` call. Without a drain, the background `embed()` lands
		// on a closed DB and silently drops the row. This test goes through the real CLI
		// handler so any regression of `withMemory`'s flush-before-close invariant fails
		// here, not just at the level of `flushExtractions()` itself.
		const { provider, calls } = fakeProvider();
		const dbPath = `${tmpdir()}/mnemopi-1833-${randomBytes(6).toString("hex")}.db`;
		const captured: string[] = [];
		const stdout = { write: (s: string) => captured.push(s) };
		const stderr = { write: (s: string) => captured.push(s) };
		const runtimeOptions: ResolvedMnemopiRuntimeOptions = {
			embeddings: { provider },
		};

		await withMnemopiRuntimeOptions(runtimeOptions, async () => {
			const exit = await cmdRemember(["alpha checklist for short-lived owner", "cli", "0.5"], {
				dbPath,
				stdout,
				stderr,
			});
			expect(exit).toBe(0);
		});

		// Re-open as a separate session to verify the embedding survived `withMemory`'s close.
		const fresh = new BeamMemory({ dbPath });
		try {
			const rows = fresh.db.query("SELECT memory_id, embedding_json FROM memory_embeddings").all() as {
				memory_id: string;
				embedding_json: string;
			}[];
			expect(rows).toHaveLength(1);
			expect(JSON.parse(rows[0]?.embedding_json ?? "[]")).toEqual([1, 0, 0, 0]);
			expect(calls()).toBeGreaterThanOrEqual(1);
		} finally {
			fresh.close();
			rmSync(dbPath, { force: true });
		}
	});

	it("scopes embedQuery() cache per provider so two Mnemopi runtimes do not cross-contaminate", async () => {
		// Repro for #1833 review comment: `embedQuery()` caches by query text only, so a
		// second `Mnemopi` in the same process with a different provider would read back
		// the first runtime's vector and score against it. Each Mnemopi here exposes a
		// distinct projection for the same query token; recall MUST return that runtime's
		// own projection, never the sibling's cached one.
		const alphaProvider = {
			async *embed(texts: readonly string[]) {
				yield texts.map(() => [1, 0]);
			},
		};
		const betaProvider = {
			async *embed(texts: readonly string[]) {
				yield texts.map(() => [0, 1]);
			},
		};

		const alpha = new Mnemopi({
			db: new Database(":memory:"),
			embeddings: { provider: alphaProvider },
		});
		const beta = new Mnemopi({
			db: new Database(":memory:"),
			embeddings: { provider: betaProvider },
		});

		try {
			alpha.remember("shared query text", { source: "test" });
			beta.remember("shared query text", { source: "test" });
			await alpha.flushExtractions();
			await beta.flushExtractions();

			// Drive recall on alpha first to seed the cache, then beta. Pre-fix, beta
			// would read alpha's `[1, 0]` vector back out of `queryCache` and score
			// itself against the wrong projection.
			const alphaResults = await alpha.recall("shared query text", 1);
			const betaResults = await beta.recall("shared query text", 1);

			// Each runtime stored its own projection: alpha hits [1,0]·[1,0] = 1,
			// beta hits [0,1]·[0,1] = 1. Without scoped keys, beta's dense_score
			// collapses to [1,0]·[0,1] = 0.
			expect(alphaResults[0]?.dense_score ?? 0).toBeCloseTo(1, 5);
			expect(betaResults[0]?.dense_score ?? 0).toBeCloseTo(1, 5);
		} finally {
			alpha.close();
			beta.close();
		}
	});
});
