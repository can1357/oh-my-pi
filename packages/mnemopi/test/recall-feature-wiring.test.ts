/**
 * `polyphonicRecall` / `enhancedRecall` must change what `recallEnhanced` returns
 * (the surface hosts such as the coding-agent call), per memory instance.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mnemopi, type MnemopiOptions } from "@oh-my-pi/pi-mnemopi/core/memory";
import {
	GRAPH_VOICE_MAX_DEPTH,
	GRAPH_VOICE_MAX_RESULTS,
	PolyphonicRecallEngine,
	type VoiceRecallResult,
} from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { VeracityConsolidator } from "@oh-my-pi/pi-mnemopi/core/veracity-consolidation";
import { currentLoopPhase, logger } from "@oh-my-pi/pi-utils";

const roots: string[] = [];
const open: Mnemopi[] = [];

function tempDbPath(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-recall-wiring-"));
	roots.push(root);
	return join(root, "mnemopi.db");
}

function memory(dbPath: string, options: MnemopiOptions = {}): Mnemopi {
	const instance = new Mnemopi({
		dbPath,
		sessionId: "bank-a",
		channelId: "bank-a",
		embeddings: false,
		llm: false,
		...options,
	});
	open.push(instance);
	return instance;
}

function contents(results: readonly { content: string }[]): string[] {
	return results.map(result => result.content);
}

afterEach(() => {
	for (const instance of open.splice(0)) instance.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("polyphonic recall wiring", () => {
	it("surfaces a graph-linked memory that linear recall cannot reach", async () => {
		const dbPath = tempDbPath();
		const writer = memory(dbPath, { proactiveLinking: true });
		writer.remember("Alice owns the durable launch checklist");
		writer.remember("The durable launch checklist lives in the Notion workspace");

		const linear = await memory(dbPath, { polyphonicRecall: false }).recallEnhanced("Alice", 10, {
			includeFacts: true,
			channelId: "bank-a",
		});
		const polyphonic = await memory(dbPath, { polyphonicRecall: true }).recallEnhanced("Alice", 10, {
			includeFacts: true,
			channelId: "bank-a",
		});

		expect(contents(linear)).toContain("Alice owns the durable launch checklist");
		expect(contents(linear)).not.toContain("The durable launch checklist lives in the Notion workspace");
		const linked = polyphonic.find(result => result.content.includes("Notion workspace"));
		expect(linked?.voice_scores?.graph).toBeGreaterThan(0);
		// Fused scores are rescaled to 0..1 so banks stay comparable when results are merged.
		expect(linked?.score).toBeGreaterThan(0);
		expect(linked?.score).toBeLessThanOrEqual(1);
	});

	it("keeps fused scores within 0..1 when one memory has many graph hits", async () => {
		const dbPath = tempDbPath();
		const writer = memory(dbPath, { proactiveLinking: true, polyphonicRecall: true });
		const id = writer.remember(
			"Alice is a builder. Alice has a garden. Alice uses Rust daily. Alice works at Acme. Alice owns the launch checklist.",
			{ extractEntities: true },
		);
		writer.remember("Alice owns the durable launch checklist");
		expect(writer.beam.db.query("SELECT COUNT(*) AS n FROM facts WHERE source_msg_id = ?").get(id)).toEqual({
			n: 4,
		});

		const results = await writer.recallEnhanced("Alice", 10, { includeFacts: true, channelId: "bank-a" });

		const dense = results.find(result => result.id === id);
		// One gist and four facts name Alice; the graph voice still counts the memory once.
		expect(dense?.voice_scores?.graph).toBeGreaterThan(0);
		expect(dense?.voice_scores?.graph).toBeLessThanOrEqual(1 / 61);
		for (const result of results) {
			expect(result.score).toBeGreaterThan(0);
			expect(result.score).toBeLessThanOrEqual(1);
		}
	});

	it("backfills consolidated facts written while the flag was off, once", async () => {
		const dbPath = tempDbPath();
		const writer = memory(dbPath);
		const id = writer.remember("Our primary database keeps the billing ledger", { veracity: "stated" });
		// The extraction text names the subject the stored content never mentions (cf. `extractText`).
		writer.beam.extractAndStoreFacts("PostgreSQL runs the billing ledger", 0, id);
		writer.sleep();
		const tables = writer.beam.db
			.query("SELECT name FROM sqlite_master WHERE name IN ('consolidated_facts', 'conflicts')")
			.all();
		expect(tables).toEqual([]);

		const linear = await memory(dbPath, { polyphonicRecall: false }).recallEnhanced("PostgreSQL", 10);
		const polyphonic = await memory(dbPath, { polyphonicRecall: true }).recallEnhanced("PostgreSQL", 10);
		await memory(dbPath, { polyphonicRecall: true }).recallEnhanced("PostgreSQL", 10);

		expect(linear.map(result => result.id)).not.toContain(id);
		const hit = polyphonic.find(result => result.id === id);
		expect(hit?.voice_scores?.fact).toBeGreaterThan(0);
		expect(hit?.content).toBe("Our primary database keeps the billing ledger");
		// A second engine on the same bank does not count the backfilled mention again.
		expect(writer.beam.db.query("SELECT subject, mention_count, sources_json FROM consolidated_facts").all()).toEqual(
			[{ subject: "PostgreSQL", mention_count: 1, sources_json: JSON.stringify([id]) }],
		);
	});

	it("does not record contradictions between facts of a multi-valued relation", async () => {
		const dbPath = tempDbPath();
		const writer = memory(dbPath, { polyphonicRecall: true });
		for (const tool of ["Rust", "Go", "Zig", "OCaml", "Haskell", "Elixir"]) {
			const id = writer.remember(`Alice uses ${tool} for the launch tooling`);
			writer.beam.extractAndStoreFacts(`Alice uses ${tool} for the launch tooling`, 0, id);
		}

		expect(
			writer.beam.db.query("SELECT COUNT(*) AS n FROM consolidated_facts WHERE subject = 'Alice'").get(),
		).toEqual({ n: 6 });
		expect(writer.beam.db.query("SELECT COUNT(*) AS n FROM conflicts").get()).toEqual({ n: 0 });
	});

	it("retries a failed fact backfill on the next polyphonic recall", async () => {
		const dbPath = tempDbPath();
		const writer = memory(dbPath);
		const id = writer.remember("Our primary database keeps the billing ledger", { veracity: "stated" });
		writer.beam.extractAndStoreFacts("PostgreSQL runs the billing ledger", 0, id);
		const reader = memory(dbPath, { polyphonicRecall: true });
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const busy = spyOn(VeracityConsolidator.prototype, "serializedWrite").mockImplementationOnce(() => {
			throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		});
		try {
			const failed = await reader.recallEnhanced("PostgreSQL", 10);
			expect(failed.find(result => result.id === id)?.voice_scores?.fact).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);

			const retried = await reader.recallEnhanced("PostgreSQL", 10);
			expect(retried.find(result => result.id === id)?.voice_scores?.fact).toBeGreaterThan(0);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			busy.mockRestore();
			warn.mockRestore();
		}
	});

	it("returns topK rows when enough candidates exist", async () => {
		const mem = memory(":memory:", { polyphonicRecall: true });
		for (let i = 0; i < 130; i++) mem.remember(`Alice deploy runbook note ${i}`);

		// No token budget applies: 120 rows overflow the engine's default 4000-token context.
		expect(await mem.recallEnhanced("Alice deploy runbook", 120)).toHaveLength(120);
	});
});

describe("polyphonic graph voice bounds", () => {
	function countEdgeQueries(db: Database): { readonly count: number; restore(): void } {
		const query = db.query.bind(db);
		let count = 0;
		const spy = spyOn(db, "query").mockImplementation(((sql: string) => {
			if (sql.includes("graph_edges")) count++;
			return query(sql);
		}) as typeof db.query);
		return {
			get count() {
				return count;
			},
			restore: () => spy.mockRestore(),
		};
	}

	it("bounds the walk on a densely linked bank", async () => {
		const mem = memory(":memory:", { proactiveLinking: true, polyphonicRecall: true });
		for (let i = 0; i < 48; i++) mem.remember(`Alice deploy runbook note ${i}`, { extractEntities: true });

		const edgeQueries = countEdgeQueries(mem.beam.db);
		try {
			expect(await mem.recallEnhanced("Alice deploy runbook", 10)).toHaveLength(10);
		} finally {
			edgeQueries.restore();
		}
		// One batched query per hop, not one per expanded node (48 seeds × 49 nodes before).
		expect(edgeQueries.count).toBeGreaterThan(0);
		expect(edgeQueries.count).toBeLessThanOrEqual(GRAPH_VOICE_MAX_DEPTH);
	});

	it("walks two hops from each seed and caps what it reports", () => {
		const engine = new PolyphonicRecallEngine();
		try {
			const at = new Date().toISOString();
			engine.graph.storeGist(engine.graph.extractGist("Alice planned the launch", "seed"), "seed");
			engine.graph.addEdge({ source: "seed", target: "hub", edgeType: "ctx", weight: 0.9, timestamp: at });
			for (let i = 0; i < 200; i++) {
				engine.graph.addEdge({ source: "hub", target: `leaf-${i}`, edgeType: "ctx", weight: 0.5, timestamp: at });
				engine.graph.addEdge({
					source: `leaf-${i}`,
					target: `far-${i}`,
					edgeType: "ctx",
					weight: 0.5,
					timestamp: at,
				});
			}

			const edgeQueries = countEdgeQueries(engine.db);
			let results: VoiceRecallResult[];
			try {
				results = engine.graphVoice("Alice");
			} finally {
				edgeQueries.restore();
			}

			const depthOf = new Map(results.map(result => [result.memoryId, result.metadata.depth]));
			expect(depthOf.get("hub")).toBe(1);
			expect(depthOf.get("leaf-0")).toBe(2);
			expect(results).toHaveLength(GRAPH_VOICE_MAX_RESULTS);
			expect(new Set(results.map(result => result.memoryId)).size).toBe(results.length);
			expect(edgeQueries.count).toBe(GRAPH_VOICE_MAX_DEPTH);
		} finally {
			engine.close();
		}
	});
});

describe("enhanced recall cache wiring", () => {
	it("serves a repeated query from the cache and drops it after a write", async () => {
		const dbPath = tempDbPath();
		const mem = memory(dbPath, { enhancedRecall: true });
		mem.remember("The deploy runbook lives in the ops wiki");

		const first = await mem.recallEnhanced("deploy runbook", 5, { includeFacts: true, channelId: "bank-a" });
		const second = await mem.recallEnhanced("deploy runbook", 5, { includeFacts: true, channelId: "bank-a" });
		expect(second).toEqual(first);
		expect(mem.beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, misses: 1 });

		mem.remember("The deploy runbook now also covers rollbacks");
		const afterWrite = await mem.recallEnhanced("deploy runbook", 5, { includeFacts: true, channelId: "bank-a" });
		expect(contents(afterWrite)).toContain("The deploy runbook now also covers rollbacks");
		expect(mem.beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, misses: 2 });
	});

	it("reports the cache-hit and cache-miss recall-count updates to the loop watchdog", async () => {
		const dbPath = tempDbPath();
		const mem = memory(dbPath, { enhancedRecall: true });
		mem.remember("The deploy runbook lives in the ops wiki");

		// The recall-count UPDATE is synchronous and can wait out SQLite's busy timeout
		// behind another writer; without a label that stall is logged as "unknown".
		const run = mem.beam.db.run.bind(mem.beam.db);
		const phases: (string | undefined)[] = [];
		const spy = spyOn(mem.beam.db, "run").mockImplementation(((sql: string, ...params: unknown[]) => {
			phases.push(currentLoopPhase());
			return run(sql, ...(params as []));
		}) as typeof mem.beam.db.run);
		try {
			await mem.recallEnhanced("deploy runbook", 5); // miss
			await mem.recallEnhanced("deploy runbook", 5); // hit
		} finally {
			spy.mockRestore();
		}

		expect(mem.beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, misses: 1 });
		expect(phases.length).toBeGreaterThan(0);
		expect(phases.every(phase => phase === "mnemopi.recall")).toBe(true);
	});

	it("drops cached results when another connection writes to the same bank", async () => {
		const dbPath = tempDbPath();
		const mem = memory(dbPath, { enhancedRecall: true });
		mem.remember("The deploy runbook lives in the ops wiki");
		await mem.recallEnhanced("deploy runbook", 5);

		memory(dbPath).remember("The deploy runbook was rewritten by another session", { scope: "global" });

		expect(contents(await mem.recallEnhanced("deploy runbook", 5))).toContain(
			"The deploy runbook was rewritten by another session",
		);
	});

	it("drops cached results when another connection commits just before the recall-count update", async () => {
		const dbPath = tempDbPath();
		const mem = memory(dbPath, { enhancedRecall: true });
		const other = memory(dbPath);
		mem.remember("The deploy runbook lives in the ops wiki");
		await mem.recallEnhanced("deploy runbook", 5);

		// The other connection commits right before this connection bumps recall counts
		// for the cache hit, i.e. after the cache token was validated for this call.
		const run = mem.beam.db.run.bind(mem.beam.db);
		let interleaved = false;
		const spy = spyOn(mem.beam.db, "run").mockImplementation(((sql: string, ...params: unknown[]) => {
			if (!interleaved && sql.includes("recall_count = COALESCE(recall_count, 0) + 1")) {
				interleaved = true;
				other.remember("The deploy runbook was rewritten by another session", { scope: "global" });
			}
			return run(sql, ...(params as []));
		}) as typeof mem.beam.db.run);
		await mem.recallEnhanced("deploy runbook", 5);
		spy.mockRestore();
		expect(interleaved).toBe(true);

		expect(contents(await mem.recallEnhanced("deploy runbook", 5))).toContain(
			"The deploy runbook was rewritten by another session",
		);
	});

	it("never serves a ranking computed for different options", async () => {
		const dbPath = tempDbPath();
		const mem = memory(dbPath, { enhancedRecall: true });
		mem.remember("The deploy runbook lives in the ops wiki");
		mem.remember("The deploy runbook links the pager rotation");
		memory(dbPath, { sessionId: "bank-b", channelId: "bank-b" }).remember(
			"The deploy runbook for bank-b uses a canary",
		);
		const query = "deploy runbook";

		expect(await mem.recallEnhanced(query, 1)).toHaveLength(1);
		expect(await mem.recallEnhanced(query, 5)).toHaveLength(2);
		expect(contents(await mem.recallEnhanced(query, 5, { channelId: "bank-b" }))).toContain(
			"The deploy runbook for bank-b uses a canary",
		);
		await mem.recallEnhanced(query, 5, { includeFacts: true });
		await mem.recallEnhanced(query, 5, { queryTime: "2026-01-01T00:00:00.000Z" });
		expect(mem.beam.caches.queryCache?.stats()).toMatchObject({ hits: 0, misses: 5 });

		// The fuzzy word-overlap tier still matches a similar query, but only under the same options.
		await mem.recallEnhanced("deploy runbook wiki", 5);
		await mem.recallEnhanced("runbook wiki", 5);
		expect(mem.beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, tier4_hits: 1, misses: 6 });
		await mem.recallEnhanced("runbook wiki", 3);
		expect(mem.beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, misses: 7 });
	});
});
