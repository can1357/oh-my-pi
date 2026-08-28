import { describe, expect, it } from "bun:test";
import type {
	CoverageReport,
	CoveredContextItem,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/coverage";
import type { HygieneGateResult } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/pipeline";
import type { ContextItem } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/types";
import {
	emitObservation,
	InMemoryObservationSink,
	type ObservationReport,
	observeContextHygiene,
	summarizeObservations,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/rollout/observe";
import {
	OBSERVE_STAGE,
	ROLLOUT_STAGES,
	rolloutStageAtLeast,
	rolloutStageIndex,
	stageMayAlterContext,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/rollout/types";
import { heuristicTokenCounter } from "@oh-my-pi/pi-coding-agent/memory-fabric/token-accounting/token-accounting";

const FIXED = new Date("2026-01-01T00:00:00.000Z");
const FIXED_ISO = FIXED.toISOString();
const clock = (): Date => FIXED;

function item(id: string, content: string): ContextItem {
	return { id, content };
}

function covered(id: string, content: string, extra: Partial<CoveredContextItem> = {}): CoveredContextItem {
	return {
		id,
		content,
		fidelity: "F2",
		allowedTransforms: ["project"],
		reason: "test",
		ruleId: "test-rule",
		matchedSignals: [],
		provenance: {
			originId: id,
			classifier: "test-classifier",
			classifierVersion: "1",
			classifiedAt: FIXED_ISO,
			ruleId: "test-rule",
		},
		preserved: false,
		noCompression: false,
		disposition: "keep",
		...extra,
	};
}

function coverageOf(items: CoveredContextItem[], overrides: Partial<CoverageReport> = {}): CoverageReport {
	return {
		items,
		results: [],
		expansions: [],
		gaps: [],
		allRequiredCovered: true,
		neverWorse: { requiredCoverableCount: 0, requiredCoveredCount: 0, violation: false },
		generatedAt: FIXED_ISO,
		failedOpen: false,
		...overrides,
	};
}

function fakeGate(
	input: ContextItem[],
	proposal: CoveredContextItem[],
	overrides: Partial<HygieneGateResult> = {},
): HygieneGateResult {
	return {
		name: "acf-context-hygiene-gate",
		version: "wire-1",
		mode: "observe",
		items: input,
		proposal,
		rejected: [],
		dedup: {
			deduper: "acf-exact-deduper",
			deduperVersion: "ch2-1",
			inputCount: input.length,
			outputCount: proposal.length,
			removedCount: Math.max(0, input.length - proposal.length),
			bytesBefore: 0,
			bytesAfter: 0,
			approxTokensBefore: 0,
			approxTokensAfter: 0,
			dedupedAt: FIXED_ISO,
			failedOpen: false,
		},
		classified: [],
		coverage: coverageOf(proposal),
		stages: [],
		failedOpen: false,
		generatedAt: FIXED_ISO,
		...overrides,
	};
}

describe("rollout stage vocabulary", () => {
	it("declares the ladder in safety order", () => {
		expect(ROLLOUT_STAGES).toEqual(["observe", "suggest", "active", "stable"]);
		expect(rolloutStageIndex(OBSERVE_STAGE)).toBe(0);
	});

	it("permits context mutation only above the observe rung", () => {
		expect(stageMayAlterContext("observe")).toBe(false);
		expect(stageMayAlterContext("suggest")).toBe(true);
		expect(stageMayAlterContext("active")).toBe(true);
		expect(stageMayAlterContext("stable")).toBe(true);
	});

	it("compares ladder positions", () => {
		expect(rolloutStageAtLeast("active", "observe")).toBe(true);
		expect(rolloutStageAtLeast("observe", "observe")).toBe(true);
		expect(rolloutStageAtLeast("observe", "active")).toBe(false);
	});
});

describe("observeContextHygiene — non-alteration invariant", () => {
	it("returns the caller's exact array reference", () => {
		const items = [item("a", "alpha"), item("b", "beta")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => fakeGate(input, [covered("a", "alpha"), covered("b", "beta")]),
		});
		expect(result.context).toBe(items);
		expect(result.report.invariantHeld).toBe(true);
		expect(result.report.contextUnchanged).toBe(true);
		expect(result.report.breaches).toEqual([]);
	});

	it("discards altered items from a misbehaving runner and flags the breach", () => {
		const items = [item("a", "alpha"), item("b", "beta")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			// Returns a DIFFERENT array — observe mode forbids this.
			runner: input => fakeGate(input, [], { items: [item("a", "alpha")] }),
		});
		expect(result.context).toBe(items);
		expect(result.context).toHaveLength(2);
		expect(result.report.invariantHeld).toBe(false);
		expect(result.report.breaches.some(text => text.includes("discarded"))).toBe(true);
	});

	it("detects in-place mutation of the caller's array", () => {
		const items = [item("a", "alpha"), item("b", "beta")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => {
				input[0] = item("a", "MUTATED");
				return fakeGate(input, [covered("a", "MUTATED"), covered("b", "beta")]);
			},
		});
		expect(result.report.contextUnchanged).toBe(false);
		expect(result.report.invariantHeld).toBe(false);
		expect(result.report.breaches.some(text => text.includes("mutated in place"))).toBe(true);
	});

	it("forces observe mode on the gate and forwards the rest of the options", () => {
		let seenMode: string | undefined;
		let seenCounter: string | undefined;
		observeContextHygiene([item("a", "alpha")], [], {
			now: clock,
			gateOptions: { counter: heuristicTokenCounter },
			runner: (input, _needs, options) => {
				seenMode = options.mode;
				seenCounter = options.counter?.name;
				return fakeGate(input, [covered("a", "alpha")]);
			},
		});
		expect(seenMode).toBe("observe");
		expect(seenCounter).toBe(heuristicTokenCounter.name);
	});

	it("hands the gate the same instant it stamps on the report", () => {
		let gateInstant: string | undefined;
		const result = observeContextHygiene([item("a", "alpha")], [], {
			now: clock,
			runner: (input, _needs, options) => {
				gateInstant = options.now?.().toISOString();
				return fakeGate(input, [covered("a", "alpha")]);
			},
		});
		expect(gateInstant).toBe(FIXED_ISO);
		expect(result.report.generatedAt).toBe(FIXED_ISO);
	});
});

describe("observeContextHygiene — removal vs reorder", () => {
	it("reports a pure removal without claiming a reorder", () => {
		const items = [item("a", "alpha"), item("b", "beta"), item("c", "gamma")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => fakeGate(input, [covered("a", "alpha"), covered("c", "gamma")]),
		});
		expect(result.report.wouldRemoveIds).toEqual(["b"]);
		expect(result.report.wouldReorder).toBe(false);
		expect(result.report.wouldChange).toBe(true);
	});

	it("reports a pure reorder without claiming a removal", () => {
		const items = [item("a", "alpha"), item("b", "beta")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => fakeGate(input, [covered("b", "beta"), covered("a", "alpha")]),
		});
		expect(result.report.wouldRemoveIds).toEqual([]);
		expect(result.report.wouldReorder).toBe(true);
		expect(result.report.wouldChange).toBe(true);
	});

	it("attributes a collapsed duplicate id to removal, not reordering", () => {
		// Regression: a Set-based diff sees "a" still present (no removal) but a
		// shorter proposal (spurious reorder) — exactly backwards.
		const items = [item("a", "alpha"), item("a", "alpha"), item("b", "beta")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => fakeGate(input, [covered("a", "alpha"), covered("b", "beta")]),
		});
		expect(result.report.wouldRemoveIds).toEqual(["a"]);
		expect(result.report.wouldReorder).toBe(false);
	});

	it("treats an injected id as a reorder-class change", () => {
		const items = [item("a", "alpha")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => fakeGate(input, [covered("a", "alpha"), covered("z", "zeta")]),
		});
		expect(result.report.wouldReorder).toBe(true);
		expect(result.report.wouldChange).toBe(true);
	});

	it("reports no change when the proposal matches the input exactly", () => {
		const items = [item("a", "alpha"), item("b", "beta")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => fakeGate(input, [covered("a", "alpha"), covered("b", "beta")]),
		});
		expect(result.report.wouldChange).toBe(false);
		expect(result.report.projected.saved).toBe(0);
	});
});

describe("observeContextHygiene — measurement and safety", () => {
	it("projects the token savings enforce would achieve", () => {
		const items = [item("a", "a".repeat(400)), item("b", "b".repeat(400))];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => fakeGate(input, [covered("a", "a".repeat(400))]),
		});
		expect(result.report.projected.before).toBe(200);
		expect(result.report.projected.after).toBe(100);
		expect(result.report.projected.saved).toBe(100);
	});

	it("flags a proposal that would drop preserved F0/F1 content", () => {
		const items = [item("a", "alpha")];
		const dropped = covered("a", "alpha", { preserved: true, disposition: "drop" });
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => fakeGate(input, [], { coverage: coverageOf([dropped]) }),
		});
		expect(result.report.preservedWouldDrop).toEqual(["a"]);
		expect(result.report.breaches.some(text => text.includes("preserved"))).toBe(true);
	});

	it("surfaces coverage gaps and never-worse violations", () => {
		const items = [item("a", "alpha")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input =>
				fakeGate(input, [covered("a", "alpha")], {
					coverage: coverageOf([covered("a", "alpha")], {
						gaps: ["need-1"],
						allRequiredCovered: false,
						neverWorse: { requiredCoverableCount: 1, requiredCoveredCount: 0, violation: true },
					}),
				}),
		});
		expect(result.report.coverageGaps).toEqual(["need-1"]);
		expect(result.report.allRequiredCovered).toBe(false);
		expect(result.report.neverWorseViolation).toBe(true);
	});
});

describe("observeContextHygiene — fail open", () => {
	it("returns the untouched context when the runner throws", () => {
		const items = [item("a", "alpha")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: () => {
				throw new Error("boom");
			},
		});
		expect(result.context).toBe(items);
		expect(result.report.failedOpen).toBe(true);
		expect(result.report.wouldChange).toBe(false);
		expect(result.report.inputIds).toEqual(["a"]);
		expect(result.gate.failedOpen).toBe(true);
		expect(result.gate.coverage.allRequiredCovered).toBe(false);
	});

	it("still reports in-place mutation when the runner throws afterwards", () => {
		const items = [item("a", "alpha")];
		const result = observeContextHygiene(items, [], {
			now: clock,
			runner: input => {
				input.push(item("b", "beta"));
				throw new Error("boom");
			},
		});
		expect(result.report.failedOpen).toBe(true);
		expect(result.report.contextUnchanged).toBe(false);
	});

	it("survives a throwing sink", () => {
		const throwing = {
			record(): void {
				throw new Error("sink down");
			},
		};
		expect(() =>
			observeContextHygiene([item("a", "alpha")], [], {
				now: clock,
				sink: throwing,
				runner: input => fakeGate(input, [covered("a", "alpha")]),
			}),
		).not.toThrow();
	});

	it("measures an empty context without failing", () => {
		const result = observeContextHygiene([], [], {
			now: clock,
			runner: input => fakeGate(input, []),
		});
		expect(result.report.inputCount).toBe(0);
		expect(result.report.wouldChange).toBe(false);
		expect(result.report.invariantHeld).toBe(true);
	});
});

describe("observation sinks and summaries", () => {
	it("buffers reports in memory", () => {
		const sink = new InMemoryObservationSink();
		const items = [item("a", "alpha")];
		observeContextHygiene(items, [], {
			now: clock,
			sink,
			runner: input => fakeGate(input, [covered("a", "alpha")]),
		});
		expect(sink.reports).toHaveLength(1);
		expect(sink.reports[0]?.observer).toBe("acf-rollout-observer");
		expect(sink.summary().count).toBe(1);
		sink.clear();
		expect(sink.reports).toHaveLength(0);
	});

	it("swallows sink failures in emitObservation", () => {
		const report = { projected: { saved: 0 } } as unknown as ObservationReport;
		expect(() =>
			emitObservation(report, {
				record(): void {
					throw new Error("nope");
				},
			}),
		).not.toThrow();
	});

	it("summarizes an empty batch as not safe to advance", () => {
		const summary = summarizeObservations([]);
		expect(summary.count).toBe(0);
		expect(summary.wouldChangeRate).toBe(0);
		expect(summary.meanProjectedSaved).toBe(0);
		expect(summary.safeToAdvance).toBe(false);
	});

	it("aggregates change rate and projected savings", () => {
		const sink = new InMemoryObservationSink();
		const options = { now: clock, sink };
		observeContextHygiene([item("a", "a".repeat(400))], [], {
			...options,
			runner: input => fakeGate(input, [covered("a", "a".repeat(400))]),
		});
		observeContextHygiene([item("a", "a".repeat(400)), item("b", "b".repeat(400))], [], {
			...options,
			runner: input => fakeGate(input, [covered("a", "a".repeat(400))]),
		});
		const summary = sink.summary();
		expect(summary.count).toBe(2);
		expect(summary.wouldChangeCount).toBe(1);
		expect(summary.wouldChangeRate).toBe(0.5);
		expect(summary.totalProjectedSaved).toBe(100);
		expect(summary.meanProjectedSaved).toBe(50);
		expect(summary.safeToAdvance).toBe(true);
	});

	it("refuses to advance when any observation breached an invariant", () => {
		const sink = new InMemoryObservationSink();
		observeContextHygiene([item("a", "alpha")], [], {
			now: clock,
			sink,
			runner: input => fakeGate(input, [], { items: [] }),
		});
		const summary = sink.summary();
		expect(summary.anyInvariantBreach).toBe(true);
		expect(summary.safeToAdvance).toBe(false);
	});

	it("refuses to advance when any observation failed open", () => {
		const sink = new InMemoryObservationSink();
		observeContextHygiene([item("a", "alpha")], [], {
			now: clock,
			sink,
			runner: () => {
				throw new Error("boom");
			},
		});
		expect(sink.summary().anyFailedOpen).toBe(true);
		expect(sink.summary().safeToAdvance).toBe(false);
	});
});

describe("observeContextHygiene — real gate", () => {
	it("runs the real hygiene gate without altering context", () => {
		const items = [
			item("doc-1", "The build script lives in scripts/build.ts and runs on every push."),
			item("doc-2", "Release notes are generated from the changelog directory."),
			item("doc-3", "Session transcripts are stored under the project cache directory."),
		];
		const snapshot = items.map(entry => entry.content);
		const result = observeContextHygiene(items, [], { now: clock });
		expect(result.context).toBe(items);
		expect(items.map(entry => entry.content)).toEqual(snapshot);
		expect(result.report.contextUnchanged).toBe(true);
		expect(result.report.invariantHeld).toBe(true);
		expect(result.report.failedOpen).toBe(false);
		expect(result.report.inputCount).toBe(3);
		expect(result.report.stage).toBe("observe");
		expect(result.report.gate).toBe("acf-context-hygiene-gate");
	});
});
