import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import "./setup";
import { configureRecallFeatures } from "@oh-my-pi/pi-mnemopi/config";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import type { EpisodicGraph, RelatedMemory } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { transaction } from "../src/db";

const previousProactive = process.env.MNEMOPI_PROACTIVE_LINKING;

afterEach(() => {
	if (previousProactive === undefined) delete process.env.MNEMOPI_PROACTIVE_LINKING;
	else process.env.MNEMOPI_PROACTIVE_LINKING = previousProactive;
	configureRecallFeatures({ proactiveLinking: false });
});

function linkedIds(edges: readonly RelatedMemory[]): Set<string> {
	return new Set(edges.map(edge => edge.memoryId));
}

function graphOf(beam: BeamMemory): EpisodicGraph {
	return beam.episodicGraph as EpisodicGraph;
}

describe("proactive memory linking", () => {
	it("creates related_to edges for similar content when enabled", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "proactive-content", dbPath: ":memory:" });
		try {
			const first = beam.remember("Alice set up the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});
			const second = beam.remember("Alice configured the deployment pipeline for continuous integration", {
				importance: 0.8,
			});

			const edges = graphOf(beam).findRelatedMemories(second, 1);
			expect(linkedIds(edges).has(first)).toBe(true);
			expect(edges.some(edge => edge.memoryId === first && edge.edgeType === "related_to")).toBe(true);
			expect(linkedIds(edges).has(second)).toBe(false);
		} finally {
			beam.close();
		}
	});

	it("honors host configuration when the environment variable is unset", () => {
		delete process.env.MNEMOPI_PROACTIVE_LINKING;
		configureRecallFeatures({ proactiveLinking: true });
		const beam = new BeamMemory({ sessionId: "proactive-host-config", dbPath: ":memory:" });
		try {
			const first = beam.remember("Alice set up the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});
			const second = beam.remember("Alice configured the deployment pipeline for continuous integration", {
				importance: 0.8,
			});

			const edges = graphOf(beam).findRelatedMemories(second, 1);
			expect(linkedIds(edges).has(first)).toBe(true);
			expect(edges.some(edge => edge.memoryId === first && edge.edgeType === "related_to")).toBe(true);
		} finally {
			beam.close();
		}
	});

	it("keeps host configuration scoped to each BeamMemory instance", () => {
		delete process.env.MNEMOPI_PROACTIVE_LINKING;
		const enabled = new BeamMemory({
			sessionId: "proactive-instance-on",
			dbPath: ":memory:",
			proactiveLinking: true,
		});
		configureRecallFeatures({ proactiveLinking: false });
		const disabled = new BeamMemory({
			sessionId: "proactive-instance-off",
			dbPath: ":memory:",
			proactiveLinking: false,
		});
		try {
			const enabledFirst = enabled.remember("Alice set up the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});
			const enabledSecond = enabled.remember("Alice configured the deployment pipeline for continuous integration", {
				importance: 0.8,
			});
			const disabledFirst = disabled.remember("Alice set up the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});
			const disabledSecond = disabled.remember(
				"Alice configured the deployment pipeline for continuous integration",
				{
					importance: 0.8,
				},
			);

			expect(linkedIds(graphOf(enabled).findRelatedMemories(enabledSecond, 1)).has(enabledFirst)).toBe(true);
			expect(linkedIds(graphOf(disabled).findRelatedMemories(disabledSecond, 1)).has(disabledFirst)).toBe(false);
		} finally {
			enabled.close();
			disabled.close();
		}
	});

	it("keeps host configuration scoped to each Mnemopi instance", () => {
		delete process.env.MNEMOPI_PROACTIVE_LINKING;
		const enabled = new Mnemopi({
			sessionId: "proactive-mnemopi-on",
			dbPath: ":memory:",
			proactiveLinking: true,
		});
		configureRecallFeatures({ proactiveLinking: false });
		const disabled = new Mnemopi({
			sessionId: "proactive-mnemopi-off",
			dbPath: ":memory:",
			proactiveLinking: false,
		});
		try {
			const enabledFirst = enabled.remember("Database indexing improves query performance significantly", {
				importance: 0.8,
			});
			const enabledSecond = enabled.remember("Database indexing optimizes query performance and efficiency", {
				importance: 0.8,
			});
			const disabledFirst = disabled.remember("Database indexing improves query performance significantly", {
				importance: 0.8,
			});
			const disabledSecond = disabled.remember("Database indexing optimizes query performance and efficiency", {
				importance: 0.8,
			});

			expect(linkedIds(graphOf(enabled.beam).findRelatedMemories(enabledSecond, 1)).has(enabledFirst)).toBe(true);
			expect(linkedIds(graphOf(disabled.beam).findRelatedMemories(disabledSecond, 1)).has(disabledFirst)).toBe(
				false,
			);
		} finally {
			enabled.close();
			disabled.close();
		}
	});

	it("lets the environment variable override instance configuration", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "0";
		const disabledByEnv = new BeamMemory({
			sessionId: "proactive-env-off",
			dbPath: ":memory:",
			proactiveLinking: true,
		});
		try {
			const disabledFirst = disabledByEnv.remember("Alice set up the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});
			const disabledSecond = disabledByEnv.remember(
				"Alice configured the deployment pipeline for continuous integration",
				{
					importance: 0.8,
				},
			);
			process.env.MNEMOPI_PROACTIVE_LINKING = "1";
			const enabledByEnv = new BeamMemory({
				sessionId: "proactive-env-on",
				dbPath: ":memory:",
				proactiveLinking: false,
			});
			try {
				const enabledFirst = enabledByEnv.remember("Alice set up the CI/CD pipeline for backend deployment", {
					importance: 0.8,
				});
				const enabledSecond = enabledByEnv.remember(
					"Alice configured the deployment pipeline for continuous integration",
					{
						importance: 0.8,
					},
				);

				expect(linkedIds(graphOf(enabledByEnv).findRelatedMemories(enabledSecond, 1)).has(enabledFirst)).toBe(true);
			} finally {
				enabledByEnv.close();
			}

			expect(linkedIds(graphOf(disabledByEnv).findRelatedMemories(disabledSecond, 1)).has(disabledFirst)).toBe(
				false,
			);
		} finally {
			disabledByEnv.close();
		}
	});

	it("does not snapshot a construction-time environment override into instance defaults", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({
			sessionId: "proactive-env-snapshot",
			dbPath: ":memory:",
			proactiveLinking: false,
		});
		delete process.env.MNEMOPI_PROACTIVE_LINKING;
		try {
			const first = beam.remember("Alice set up the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});
			const second = beam.remember("Alice configured the deployment pipeline for continuous integration", {
				importance: 0.8,
			});

			expect(linkedIds(graphOf(beam).findRelatedMemories(second, 1)).has(first)).toBe(false);
		} finally {
			beam.close();
		}
	});

	it("links new memories only to memories that are still valid", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "proactive-invalidated", dbPath: ":memory:" });
		try {
			const retiredWorking = beam.remember("Alice set up the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});
			const liveWorking = beam.remember("Alice set up the CI/CD pipeline for frontend deployment", {
				importance: 0.8,
			});
			const retiredEpisodic = beam.consolidateToEpisodic(
				"Alice reviewed the CI/CD pipeline for backend deployment",
				[],
			);
			expect(beam.invalidate(retiredWorking)).toBe(true);
			expect(beam.invalidate(retiredEpisodic)).toBe(true);

			const next = beam.remember("Alice configured the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});

			const targets = new Set(
				(
					beam.db.query("SELECT DISTINCT target FROM graph_edges WHERE source = ?").all(next) as {
						target: string;
					}[]
				).map(row => row.target),
			);
			expect(targets.has(liveWorking)).toBe(true);
			expect(targets.has(retiredWorking)).toBe(false);
			expect(targets.has(retiredEpisodic)).toBe(false);
		} finally {
			beam.close();
		}
	});

	it("scores a memory id shared across tiers by the content of its live row", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "proactive-cross-tier", dbPath: ":memory:" });
		try {
			const expired = "2000-01-01T00:00:00.000Z";
			const unrelated = "Grocery list includes bananas apples oranges and milk";
			beam.importFromDict({
				working_memory: [
					{ id: "related-live-working", content: "Alice set up the CI/CD pipeline for backend deployment" },
					{ id: "related-live-episodic", content: unrelated, valid_until: expired },
					{
						id: "related-retired-working",
						content: "Alice tested the CI/CD pipeline for backend deployment",
						valid_until: expired,
					},
					{ id: "related-retired-episodic", content: unrelated },
					{
						id: "retired-in-both-tiers",
						content: "Alice checked the CI/CD pipeline for backend deployment",
						valid_until: expired,
					},
				],
				episodic_memory: [
					{ id: "related-live-working", content: unrelated, valid_until: expired },
					{ id: "related-live-episodic", content: "Alice reviewed the CI/CD pipeline for backend deployment" },
					{ id: "related-retired-working", content: unrelated },
					{
						id: "related-retired-episodic",
						content: "Alice verified the CI/CD pipeline for backend deployment",
						superseded_by: "replacement-episodic",
					},
					{
						id: "retired-in-both-tiers",
						content: "Alice checked the CI/CD pipeline for backend deployment",
						superseded_by: "replacement",
					},
				],
			});

			const next = beam.remember("Alice configured the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});

			const targets = new Set(
				(
					beam.db.query("SELECT DISTINCT target FROM graph_edges WHERE source = ?").all(next) as {
						target: string;
					}[]
				).map(row => row.target),
			);
			expect(targets.has("related-live-working")).toBe(true);
			expect(targets.has("related-live-episodic")).toBe(true);
			expect(targets.has("related-retired-working")).toBe(false);
			expect(targets.has("related-retired-episodic")).toBe(false);
			expect(targets.has("retired-in-both-tiers")).toBe(false);
		} finally {
			beam.close();
		}
	});

	it("does not link memories that are superseded but not yet expired", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "proactive-superseded", dbPath: ":memory:" });
		try {
			const future = "2999-01-01T00:00:00.000Z";
			beam.importFromDict({
				working_memory: [
					{
						id: "superseded-working",
						content: "Alice set up the CI/CD pipeline for backend deployment",
						superseded_by: "replacement-working",
					},
					{ id: "valid-working", content: "Alice set up the CI/CD pipeline for frontend deployment" },
				],
				episodic_memory: [
					{
						id: "superseded-episodic",
						content: "Alice reviewed the CI/CD pipeline for backend deployment",
						superseded_by: "replacement-episodic",
						valid_until: future,
					},
				],
			});

			const next = beam.remember("Alice configured the CI/CD pipeline for backend deployment", {
				importance: 0.8,
			});

			const targets = new Set(
				(
					beam.db.query("SELECT DISTINCT target FROM graph_edges WHERE source = ?").all(next) as {
						target: string;
					}[]
				).map(row => row.target),
			);
			expect(targets.has("valid-working")).toBe(true);
			expect(targets.has("superseded-working")).toBe(false);
			expect(targets.has("superseded-episodic")).toBe(false);
		} finally {
			beam.close();
		}
	});

	it("does not create recall-similarity edges for unrelated content", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "proactive-unrelated", dbPath: ":memory:" });
		try {
			beam.remember("Quantum entanglement in particle physics experiments", { importance: 0.8 });
			const second = beam.remember("The cat sat on the mat and purred contentedly", {
				importance: 0.8,
			});

			const relatedTo = graphOf(beam)
				.findRelatedMemories(second, 1)
				.filter(edge => edge.edgeType === "related_to");
			expect(relatedTo).toHaveLength(0);
		} finally {
			beam.close();
		}
	});

	it("creates references edges for shared extracted entities", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "proactive-entity", dbPath: ":memory:" });
		try {
			const first = beam.remember("Jane is a talented architect. Jane uses AutoCAD daily.", {
				importance: 0.8,
				extractEntities: true,
			});
			const second = beam.remember("Jane is designing the office building. Jane reviews blueprints.", {
				importance: 0.8,
				extractEntities: true,
			});

			const count = (
				beam.db
					.query(
						"SELECT COUNT(*) AS count FROM graph_edges WHERE source = ? AND target = ? AND edge_type = 'references'",
					)
					.get(second, first) as { count: number }
			).count;
			expect(count).toBeGreaterThanOrEqual(1);
		} finally {
			beam.close();
		}
	});

	it("is disabled by default and can be toggled per remember call", () => {
		delete process.env.MNEMOPI_PROACTIVE_LINKING;
		const beam = new BeamMemory({ sessionId: "proactive-gate", dbPath: ":memory:" });
		try {
			const first = beam.remember("Database indexing improves query performance significantly", {
				importance: 0.8,
			});
			process.env.MNEMOPI_PROACTIVE_LINKING = "1";
			const second = beam.remember("Database indexing optimizes query performance and efficiency", {
				importance: 0.8,
			});
			delete process.env.MNEMOPI_PROACTIVE_LINKING;
			const third = beam.remember("The weather today was sunny and warm", { importance: 0.8 });

			expect(linkedIds(graphOf(beam).findRelatedMemories(second, 1)).has(first)).toBe(true);
			expect(linkedIds(graphOf(beam).findRelatedMemories(third, 1)).has(first)).toBe(false);
		} finally {
			beam.close();
		}
	});

	it("does not duplicate edges on duplicate remember updates", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "proactive-dedup", dbPath: ":memory:" });
		try {
			const first = beam.remember("Database indexing improves query performance significantly", {
				importance: 0.8,
			});
			const second = beam.remember("Database indexing optimizes query performance and efficiency", {
				importance: 0.8,
			});
			const before = (
				beam.db
					.query(
						"SELECT COUNT(*) AS count FROM graph_edges WHERE source = ? AND target = ? AND edge_type = 'related_to'",
					)
					.get(second, first) as { count: number }
			).count;

			beam.remember("Database indexing optimizes query performance and efficiency", {
				importance: 0.8,
			});

			const after = (
				beam.db
					.query(
						"SELECT COUNT(*) AS count FROM graph_edges WHERE source = ? AND target = ? AND edge_type = 'related_to'",
					)
					.get(second, first) as { count: number }
			).count;
			expect(after).toBe(before);
		} finally {
			beam.close();
		}
	});

	// #14998: linking a retain against a large on-disk bank autocommitted every
	// edge, so the synchronous remember paid one WAL commit (fsync) per linked
	// memory and froze the TUI for seconds. Each commit appends at least one WAL
	// frame, so the frame count separates one commit from one-per-edge.
	it("links a new memory against an on-disk bank in a single commit", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const dir = TempDir.createSync("@mnemopi-proactive-commit-");
		const beam = new BeamMemory({ sessionId: "proactive-commit", dbPath: dir.join("bank.db") });
		try {
			const seeded = 60;
			const insert = beam.db.prepare(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, 'seed', ?, 'seed', 0.5)",
			);
			for (let i = 0; i < seeded; i++) {
				insert.run(`seed-${i}`, `Deployment pipeline database indexing review ${i}`, new Date().toISOString());
			}
			insert.finalize();
			beam.db.exec("PRAGMA wal_autocheckpoint=0");
			beam.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

			const id = beam.remember("Deployment pipeline database indexing review notes", { importance: 0.8 });

			const linked = beam.db
				.query("SELECT COUNT(*) AS count FROM graph_edges WHERE source = ? AND edge_type = 'related_to'")
				.get(id) as { count: number };
			expect(linked.count).toBe(seeded);
			const wal = beam.db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { log: number };
			expect(wal.log).toBeLessThan(seeded);
		} finally {
			beam.close();
			dir.removeSync();
		}
	});

	it("preserves proactive links in a caller transaction and later write rollback", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "proactive-caller-tx", dbPath: ":memory:" });
		try {
			const first = beam.remember("Alice set up the deployment pipeline");
			const second = beam.db.transaction(() => beam.remember("Alice set up the deployment pipeline for testing"))();

			const links = beam.db
				.query<{ count: number }, [string, string]>(
					"SELECT COUNT(*) AS count FROM graph_edges WHERE source = ? AND target = ?",
				)
				.get(second, first);
			expect(links?.count).toBeGreaterThan(0);

			expect(() =>
				transaction(beam.db, () => {
					beam.db.run("INSERT INTO gists (id, text) VALUES ('rolled-back', 'temporary')");
					throw new Error("rollback");
				}),
			).toThrow("rollback");
			expect(beam.db.query("SELECT id FROM gists WHERE id = 'rolled-back'").get()).toBeNull();
		} finally {
			beam.close();
		}
	});

	it("leaves graph writes inside a manually begun transaction for the caller to roll back", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "proactive-manual-tx", dbPath: ":memory:" });
		try {
			const first = beam.remember("Alice set up the deployment pipeline");
			beam.db.exec("BEGIN IMMEDIATE");
			let second: string;
			try {
				second = beam.remember("Alice set up the deployment pipeline for testing");
				const linked = beam.db
					.query<{ count: number }, [string, string]>(
						"SELECT COUNT(*) AS count FROM graph_edges WHERE source = ? AND target = ?",
					)
					.get(second, first);
				expect(linked?.count).toBeGreaterThan(0);
			} finally {
				beam.db.exec("ROLLBACK");
			}
			expect(beam.db.query("SELECT id FROM working_memory WHERE id = ?").get(second)).toBeNull();
			expect(beam.db.query("SELECT source FROM graph_edges WHERE source = ?").get(second)).toBeNull();
		} finally {
			beam.close();
		}
	});
});
