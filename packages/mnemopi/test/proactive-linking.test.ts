import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { configureRecallFeatures } from "@oh-my-pi/pi-mnemopi/config";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import type { EpisodicGraph, RelatedMemory } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

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
});
