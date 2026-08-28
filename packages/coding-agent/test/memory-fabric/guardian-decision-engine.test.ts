import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	DEFAULT_GUARDIAN_CONFIG,
	type GuardianAction,
	type GuardianConfig,
	type GuardianContext,
	GuardianDecisionEngine,
	type GuardianMemoryRecord,
	SCORE_WEIGHTS,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/decision-engine";
import {
	type ExtractedEntities,
	type SessionEvent,
	SessionEventBus,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/event-bus";

const TS = "2024-01-01T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every event type the bus can carry, so `dispose` can be checked exhaustively. */
const ALL_EVENT_TYPES: Array<SessionEvent["type"]> = [
	"session-start",
	"user-prompt",
	"before-model",
	"plan-commit",
	"tool-call",
	"tool-result",
	"compaction",
	"resume",
	"idle",
	"session-stop",
];

function engine(config: Partial<GuardianConfig> = {}, bus = new SessionEventBus()): GuardianDecisionEngine {
	return new GuardianDecisionEngine(config, bus);
}

function entities(overrides: Partial<ExtractedEntities> = {}): ExtractedEntities {
	return { files: [], symbols: [], errors: [], taskNames: [], commands: [], ...overrides };
}

function context(overrides: Partial<GuardianContext> = {}): GuardianContext {
	return {
		entities: entities(),
		intent: "unknown",
		workingState: null,
		recentMemories: [],
		retrievedRecords: [],
		estimatedLatencyMs: 0,
		...overrides,
	};
}

function record(overrides: Partial<GuardianMemoryRecord> = {}): GuardianMemoryRecord {
	return {
		memoryId: "m1",
		type: "evidence",
		content: "",
		status: "active",
		verification: "test-observed",
		createdAt: new Date().toISOString(),
		retrievalCount: 1,
		...overrides,
	};
}

function idleEvent(): SessionEvent {
	return { type: "idle", sessionId: "s1", idleDurationMs: 1000, timestamp: TS };
}

function toolCallEvent(toolName: string): SessionEvent {
	return { type: "tool-call", sessionId: "s1", toolName, args: {}, toolCallId: "tc1", timestamp: TS };
}

function toolResultEvent(toolName: string, isError: boolean): SessionEvent {
	return {
		type: "tool-result",
		sessionId: "s1",
		toolName,
		args: {},
		result: {} as ToolResultMessage,
		toolCallId: "tc1",
		timestamp: TS,
		isError,
	};
}

/**
 * A context engineered to score 0.7692 — above the 0.75 warn threshold.
 *
 * Every term is non-zero and independently derived, so a regression in any one
 * scorer moves the total and fails the assertion below.
 */
function warnLevelContext(): GuardianContext {
	return context({
		entities: entities({
			files: ["src/main.ts"],
			symbols: ["parseConfig"],
			errors: ["Error: cannot read config"],
			taskNames: ["refactor main"],
		}),
		intent: "architecture",
		workingState: { objective: "refactor main.ts using parseConfig", constraints: ["use tabs"] },
		recentMemories: [
			record({ memoryId: "r1", verification: "model-proposed", status: "contradicted" }),
			record({ memoryId: "r2", verification: "model-proposed", status: "active" }),
		],
		retrievedRecords: [
			record({
				memoryId: "e1",
				type: "evidence",
				content: "Error: cannot read config",
				structured: { evidenceType: "test-result" },
				retrievalCount: 0,
			}),
			record({
				memoryId: "g1",
				type: "graph-assertion",
				content: "parseConfig calls loadFile",
				verification: "user-confirmed",
				retrievalCount: 0,
			}),
		],
	});
}

describe("SCORE_WEIGHTS", () => {
	it("sums to exactly 1 so scores are comparable with observe-mode thresholds", () => {
		const total = Object.values(SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
		expect(total).toBeCloseTo(1, 10);
	});
});

describe("DEFAULT_GUARDIAN_CONFIG", () => {
	it("mirrors the observe-mode ladder rather than declaring its own", () => {
		expect(DEFAULT_GUARDIAN_CONFIG.warnAgentThreshold).toBeCloseTo(0.75, 10);
		expect(DEFAULT_GUARDIAN_CONFIG.injectContextThreshold).toBeCloseTo(0.55, 10);
		expect(DEFAULT_GUARDIAN_CONFIG.retrieveSilentlyThreshold).toBeCloseTo(0.3, 10);
	});

	it("keeps the three thresholds strictly ordered", () => {
		const { retrieveSilentlyThreshold, injectContextThreshold, warnAgentThreshold } = DEFAULT_GUARDIAN_CONFIG;
		expect(retrieveSilentlyThreshold).toBeLessThan(injectContextThreshold);
		expect(injectContextThreshold).toBeLessThan(warnAgentThreshold);
	});

	it("defaults to observe, the mode a user cannot notice", () => {
		expect(DEFAULT_GUARDIAN_CONFIG.mode).toBe("observe");
	});
});

describe("GuardianDecisionEngine.computeScore", () => {
	it("returns 1 when every positive signal is saturated", () => {
		expect(
			engine().computeScore({
				taskRelevance: 1,
				decisionImpact: 1,
				agentUncertainty: 1,
				errorSimilarity: 1,
				userConstraintMatch: 1,
				graphImpact: 1,
				memoryNovelty: 1,
			}),
		).toBeCloseTo(1, 10);
	});

	it("treats missing components as zero rather than as an error", () => {
		expect(engine().computeScore({})).toBe(0);
		expect(engine().computeScore({ taskRelevance: 1 })).toBeCloseTo(SCORE_WEIGHTS.taskRelevance, 10);
	});

	it("subtracts penalties from the weighted total", () => {
		expect(engine().computeScore({ taskRelevance: 1, latencyCost: 0.1 })).toBeCloseTo(0.12, 10);
	});

	it("never returns a negative score", () => {
		expect(engine().computeScore({ latencyCost: 1, contextBloatPenalty: 1, staleMemoryPenalty: 1 })).toBe(0);
	});

	it("clamps each component before weighting it", () => {
		expect(engine().computeScore({ taskRelevance: 5 })).toBeCloseTo(SCORE_WEIGHTS.taskRelevance, 10);
		expect(engine().computeScore({ taskRelevance: -5 })).toBe(0);
	});

	it("treats a non-finite component as zero", () => {
		expect(engine().computeScore({ taskRelevance: Number.NaN })).toBe(0);

		const infinitePenalty = engine().computeScore({ taskRelevance: 1, latencyCost: Number.POSITIVE_INFINITY });
		expect(infinitePenalty).toBeCloseTo(0.22, 10);
	});
});

describe("GuardianDecisionEngine.decideAction", () => {
	it("escalates on the way up, so the highest scores get the strongest action", () => {
		const guardian = engine();
		expect(guardian.decideAction(1)).toBe("WARN_AGENT");
		expect(guardian.decideAction(0.9)).toBe("WARN_AGENT");
		expect(guardian.decideAction(0.6)).toBe("INJECT_CONTEXT");
		expect(guardian.decideAction(0.4)).toBe("RETRIEVE_SILENTLY");
		expect(guardian.decideAction(0)).toBe("CAPTURE_ONLY");
	});

	it("treats every threshold as inclusive at its exact boundary", () => {
		const guardian = engine();
		expect(guardian.decideAction(0.75)).toBe("WARN_AGENT");
		expect(guardian.decideAction(0.55)).toBe("INJECT_CONTEXT");
		expect(guardian.decideAction(0.3)).toBe("RETRIEVE_SILENTLY");
	});

	it("drops one rung just below each boundary", () => {
		const guardian = engine();
		expect(guardian.decideAction(0.7499)).toBe("INJECT_CONTEXT");
		expect(guardian.decideAction(0.5499)).toBe("RETRIEVE_SILENTLY");
		expect(guardian.decideAction(0.2999)).toBe("CAPTURE_ONLY");
	});

	it("keeps RETRIEVE_SILENTLY reachable even when two thresholds coincide", () => {
		const guardian = engine({ injectContextThreshold: 0.3, retrieveSilentlyThreshold: 0.3 });
		expect(guardian.decideAction(0.3)).toBe("INJECT_CONTEXT");
		expect(guardian.decideAction(0.29)).toBe("CAPTURE_ONLY");
	});

	it("honours custom thresholds", () => {
		const guardian = engine({ warnAgentThreshold: 0.5 });
		expect(guardian.decideAction(0.5)).toBe("WARN_AGENT");
	});
});

describe("GuardianDecisionEngine.applyMode", () => {
	const everyAction: GuardianAction[] = [
		"IGNORE",
		"CAPTURE_ONLY",
		"RETRIEVE_SILENTLY",
		"INJECT_CONTEXT",
		"WARN_AGENT",
		"CHECKPOINT_NOW",
		"QUEUE_MAINTENANCE",
	];

	it("silences everything in off mode", () => {
		const guardian = engine({ mode: "off" });
		for (const action of everyAction) {
			expect(guardian.applyMode(action)).toBe("IGNORE");
		}
	});

	it("suppresses exactly the user-visible actions in observe mode", () => {
		const guardian = engine({ mode: "observe" });
		expect(guardian.applyMode("INJECT_CONTEXT")).toBe("IGNORE");
		expect(guardian.applyMode("WARN_AGENT")).toBe("IGNORE");
		expect(guardian.applyMode("RETRIEVE_SILENTLY")).toBe("RETRIEVE_SILENTLY");
		expect(guardian.applyMode("CAPTURE_ONLY")).toBe("CAPTURE_ONLY");
		expect(guardian.applyMode("CHECKPOINT_NOW")).toBe("CHECKPOINT_NOW");
		expect(guardian.applyMode("QUEUE_MAINTENANCE")).toBe("QUEUE_MAINTENANCE");
	});

	it("downgrades a warning to an injection in suggest mode instead of dropping it", () => {
		const guardian = engine({ mode: "suggest" });
		expect(guardian.applyMode("WARN_AGENT")).toBe("INJECT_CONTEXT");
		expect(guardian.applyMode("INJECT_CONTEXT")).toBe("INJECT_CONTEXT");
	});

	it("passes every action through in active and strict mode", () => {
		for (const mode of ["active", "strict"] as const) {
			const guardian = engine({ mode });
			for (const action of everyAction) {
				expect(guardian.applyMode(action)).toBe(action);
			}
		}
	});
});

describe("GuardianDecisionEngine.decide", () => {
	it("reports the intended action alongside the permitted one", () => {
		const decision = engine({ mode: "observe" }).decide(toolCallEvent("write_file"), warnLevelContext());

		expect(decision.score).toBeCloseTo(0.7692, 6);
		expect(decision.intendedAction).toBe("WARN_AGENT");
		expect(decision.action).toBe("IGNORE");
		expect(decision.suppressed).toBe(true);
	});

	it("stops suppressing once the mode permits the action", () => {
		const decision = engine({ mode: "active" }).decide(toolCallEvent("write_file"), warnLevelContext());

		expect(decision.intendedAction).toBe("WARN_AGENT");
		expect(decision.action).toBe("WARN_AGENT");
		expect(decision.suppressed).toBe(false);
	});

	it("records a downgrade in suggest mode as suppression", () => {
		const decision = engine({ mode: "suggest" }).decide(toolCallEvent("write_file"), warnLevelContext());

		expect(decision.intendedAction).toBe("WARN_AGENT");
		expect(decision.action).toBe("INJECT_CONTEXT");
		expect(decision.suppressed).toBe(true);
	});

	it("derives every component independently", () => {
		const { components } = engine().decide(toolCallEvent("write_file"), warnLevelContext());

		expect(components.taskRelevance).toBeCloseTo(1, 10);
		expect(components.decisionImpact).toBeCloseTo(0.74, 10);
		expect(components.agentUncertainty).toBeCloseTo(0.8, 10);
		expect(components.errorSimilarity).toBeCloseTo(1, 10);
		expect(components.userConstraintMatch).toBeCloseTo(0.4, 10);
		expect(components.graphImpact).toBeCloseTo(0.2, 10);
		expect(components.memoryNovelty).toBeCloseTo(1, 10);
	});

	it("keeps decision impact distinct from error similarity", () => {
		// A destructive tool call with no error evidence at all: impact must
		// still be high while similarity stays at zero.
		const decision = engine().decide(
			toolCallEvent("delete_file"),
			context({ intent: "architecture", entities: entities({ files: ["a.ts", "b.ts"] }) }),
		);

		expect(decision.components.decisionImpact).toBeCloseTo(0.78, 10);
		expect(decision.components.errorSimilarity).toBe(0);
	});

	it("lets a forced action outrank the score ladder", () => {
		const decision = engine().decide(idleEvent(), context(), "QUEUE_MAINTENANCE");

		expect(decision.intendedAction).toBe("QUEUE_MAINTENANCE");
		expect(decision.reasoning).toContain("event-determined");
	});

	it("still applies mode to a forced action", () => {
		const decision = engine({ mode: "off" }).decide(idleEvent(), context(), "CHECKPOINT_NOW");

		expect(decision.intendedAction).toBe("CHECKPOINT_NOW");
		expect(decision.action).toBe("IGNORE");
		expect(decision.suppressed).toBe(true);
	});

	it("passes the trigger, entities and intent straight through", () => {
		const ents = entities({ files: ["x.ts"] });
		const decision = engine().decide(toolCallEvent("read_file"), context({ entities: ents, intent: "testing" }));

		expect(decision.trigger).toBe("tool-call");
		expect(decision.entities).toBe(ents);
		expect(decision.intent).toBe("testing");
	});

	it("names the strongest signals in its reasoning", () => {
		const decision = engine().decide(toolCallEvent("write_file"), warnLevelContext());
		expect(decision.reasoning).toContain("taskRelevance=1.00");
		expect(decision.reasoning).toContain("WARN_AGENT");
	});

	it("omits signals that did not clear the reporting floor", () => {
		const decision = engine().decide(idleEvent(), context({ recentMemories: [record()] }));
		// Only decisionImpact (0.20) and agentUncertainty (0.30) are above 0.1.
		expect(decision.reasoning).toContain("agentUncertainty=0.30");
		expect(decision.reasoning).toContain("decisionImpact=0.20");
		expect(decision.reasoning).not.toContain("taskRelevance");
	});
});

describe("GuardianDecisionEngine scoring components", () => {
	it("treats an absent objective as zero task relevance rather than crashing", () => {
		const decision = engine().decide(
			toolCallEvent("write_file"),
			context({ workingState: null, entities: entities({ files: ["src/main.ts"] }) }),
		);
		expect(decision.components.taskRelevance).toBe(0);
	});

	it("scores an empty working state object the same as a null one", () => {
		const decision = engine().decide(
			toolCallEvent("write_file"),
			context({ workingState: {}, entities: entities({ files: ["src/main.ts"] }) }),
		);
		expect(decision.components.taskRelevance).toBe(0);
	});

	it("weights task names above files above symbols", () => {
		const workingState = { objective: "refactor parser in src/main.ts with parseConfig" };

		function relevanceOf(ents: Partial<ExtractedEntities>): number {
			const ctx = context({ workingState, entities: entities(ents) });
			return engine().decide(idleEvent(), ctx).components.taskRelevance;
		}

		expect(relevanceOf({ taskNames: ["parser"] })).toBeCloseTo(0.5, 10);
		expect(relevanceOf({ files: ["src/main.ts"] })).toBeCloseTo(0.3, 10);
		expect(relevanceOf({ symbols: ["parseConfig"] })).toBeCloseTo(0.2, 10);
	});

	it("treats no memory at all as genuinely uncertain", () => {
		const decision = engine().decide(idleEvent(), context({ recentMemories: [] }));
		expect(decision.components.agentUncertainty).toBeCloseTo(0.5, 10);
	});

	it("reads contradiction from status, where it actually lives", () => {
		const settledCtx = context({ recentMemories: [record({ status: "active" })] });
		const disputedCtx = context({ recentMemories: [record({ status: "contradicted" })] });

		const settled = engine().decide(idleEvent(), settledCtx);
		const disputed = engine().decide(idleEvent(), disputedCtx);

		expect(settled.components.agentUncertainty).toBeCloseTo(0.3, 10);
		expect(disputed.components.agentUncertainty).toBeCloseTo(0.4, 10);
	});

	it("raises uncertainty as the share of model-proposed records grows", () => {
		const halfCtx = context({
			recentMemories: [
				record({ memoryId: "a", verification: "model-proposed" }),
				record({ memoryId: "b", verification: "user-confirmed" }),
			],
		});

		expect(engine().decide(idleEvent(), halfCtx).components.agentUncertainty).toBeCloseTo(0.5, 10);
	});

	it("treats an error with nothing to compare against as a weak reason to look", () => {
		const decision = engine().decide(
			idleEvent(),
			context({ entities: entities({ errors: ["Error: boom"] }), retrievedRecords: [] }),
		);
		expect(decision.components.errorSimilarity).toBeCloseTo(0.3, 10);
	});

	it("only compares errors against observed outcomes", () => {
		const notEvidence = engine().decide(
			idleEvent(),
			context({
				entities: entities({ errors: ["Error: cannot read config"] }),
				retrievedRecords: [record({ type: "decision", content: "Error: cannot read config" })],
			}),
		);
		expect(notEvidence.components.errorSimilarity).toBe(0);

		const evidence = engine().decide(
			idleEvent(),
			context({
				entities: entities({ errors: ["Error: cannot read config"] }),
				retrievedRecords: [
					record({
						type: "evidence",
						content: "Error: cannot read config",
						structured: { evidenceType: "build-result" },
					}),
				],
			}),
		);
		expect(evidence.components.errorSimilarity).toBeCloseTo(1, 10);
	});

	it("scores a constraint higher immediately before something is done", () => {
		const working = { objective: "ship it", constraints: ["never force push"] };
		const beforeAct = engine().decide(toolCallEvent("bash"), context({ workingState: working }));
		const otherwise = engine().decide(idleEvent(), context({ workingState: working }));

		expect(beforeAct.components.userConstraintMatch).toBeCloseTo(0.4, 10);
		expect(otherwise.components.userConstraintMatch).toBeCloseTo(0.2, 10);
	});

	it("scores graph impact only when a symbol actually appears in an assertion", () => {
		const hit = engine().decide(
			idleEvent(),
			context({
				entities: entities({ symbols: ["parseConfig"] }),
				retrievedRecords: [record({ type: "graph-assertion", content: "parseConfig calls loadFile" })],
			}),
		);
		const miss = engine().decide(
			idleEvent(),
			context({
				entities: entities({ symbols: ["parseConfig"] }),
				retrievedRecords: [record({ type: "graph-assertion", content: "unrelated thing" })],
			}),
		);

		expect(hit.components.graphImpact).toBeCloseTo(0.2, 10);
		expect(miss.components.graphImpact).toBe(0);
	});

	it("counts never-surfaced records as novel", () => {
		const decision = engine().decide(
			idleEvent(),
			context({ retrievedRecords: [record({ retrievalCount: 0 }), record({ retrievalCount: 4 })] }),
		);
		expect(decision.components.memoryNovelty).toBeCloseTo(0.5, 10);
	});

	it("penalises old unconfirmed records but never user-confirmed ones", () => {
		const old = new Date(Date.now() - 200 * DAY_MS).toISOString();

		const unconfirmed = engine().decide(
			idleEvent(),
			context({ retrievedRecords: [record({ createdAt: old, verification: "model-proposed" })] }),
		);
		const confirmed = engine().decide(
			idleEvent(),
			context({ retrievedRecords: [record({ createdAt: old, verification: "user-confirmed" })] }),
		);

		expect(unconfirmed.components.staleMemoryPenalty).toBeCloseTo(0.3, 10);
		expect(confirmed.components.staleMemoryPenalty).toBe(0);
	});

	it("does not treat an unparseable timestamp as evidence of staleness", () => {
		const decision = engine().decide(
			idleEvent(),
			context({ retrievedRecords: [record({ createdAt: "not a date", verification: "model-proposed" })] }),
		);
		expect(decision.components.staleMemoryPenalty).toBe(0);
	});

	it("saturates the latency and bloat penalties", () => {
		const decision = engine().decide(
			idleEvent(),
			context({ estimatedLatencyMs: 60_000, currentContextTokens: 1_000_000 }),
		);
		expect(decision.components.latencyCost).toBeCloseTo(0.3, 10);
		expect(decision.components.contextBloatPenalty).toBeCloseTo(0.2, 10);
	});
});

describe("GuardianDecisionEngine event handling", () => {
	it("records an intervention for an event it is subscribed to", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		bus.emit(idleEvent());
		await Bun.sleep(1);

		expect(guardian.decisionCount()).toBe(1);
		expect(guardian.getLastIntervention()?.trigger).toBe("idle");
	});

	it("forces maintenance on idle and a checkpoint on compaction and stop", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		bus.emit(idleEvent());
		bus.emit({
			type: "compaction",
			sessionId: "s1",
			trigger: "token-limit",
			tokensBefore: 10,
			summary: "s",
			timestamp: TS,
		});
		bus.emit({ type: "session-stop", sessionId: "s1", reason: "completed", timestamp: TS });
		await Bun.sleep(1);

		const actions = guardian.getInterventions().map(i => i.decision.intendedAction);
		expect(actions).toEqual(["QUEUE_MAINTENANCE", "CHECKPOINT_NOW", "CHECKPOINT_NOW"]);
	});

	it("clamps a penalty-dominated score to zero instead of going negative", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		bus.emit(idleEvent());
		await Bun.sleep(1);

		// Idle carries a 500ms budget, which outweighs everything it scores.
		expect(guardian.getLastIntervention()?.decision.score).toBe(0);
	});

	it("ignores a tool result that did not fail", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		bus.emit(toolResultEvent("read_file", false));
		await Bun.sleep(1);

		expect(guardian.decisionCount()).toBe(0);
	});

	it("scores a failed tool result from its name alone", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		bus.emit(toolResultEvent("write_file", true));
		await Bun.sleep(1);

		const decision = guardian.getLastIntervention()?.decision;
		expect(decision?.trigger).toBe("tool-result");
		expect(decision?.entities.errors).toEqual(["Failed to run tool write_file"]);
		expect(decision?.components.errorSimilarity).toBeCloseTo(0.3, 10);
	});

	it("scores a session start against the objective it carries", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		bus.emit({
			type: "session-start",
			sessionId: "s1",
			projectId: "p1",
			timestamp: TS,
			objective: "refactor the parser",
		});
		await Bun.sleep(1);

		expect(guardian.decisionCount()).toBe(1);
		expect(guardian.getLastIntervention()?.trigger).toBe("session-start");
	});

	it("subscribes to nothing when disabled or off", () => {
		const disabledBus = new SessionEventBus();
		engine({ enabled: false }, disabledBus);
		expect(disabledBus.listenerCount("idle")).toBe(0);

		const offBus = new SessionEventBus();
		engine({ mode: "off" }, offBus);
		expect(offBus.listenerCount("idle")).toBe(0);
	});

	it("subscribes only to the triggers it was configured for", () => {
		const bus = new SessionEventBus();
		engine({ triggers: { ...DEFAULT_GUARDIAN_CONFIG.triggers, idle: false } }, bus);

		expect(bus.listenerCount("idle")).toBe(0);
		expect(bus.listenerCount("tool-call")).toBe(1);
	});

	it("releases every subscription on dispose", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);
		for (const type of ALL_EVENT_TYPES) {
			expect(bus.listenerCount(type)).toBe(1);
		}

		guardian.dispose();
		for (const type of ALL_EVENT_TYPES) {
			expect(bus.listenerCount(type)).toBe(0);
		}

		bus.emit(idleEvent());
		await Bun.sleep(1);
		expect(guardian.decisionCount()).toBe(0);
	});

	it("is safe to dispose more than once", () => {
		const guardian = engine();
		guardian.dispose();
		expect(() => {
			guardian.dispose();
		}).not.toThrow();
	});

	it("drops the oldest interventions past the retention cap", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({ maxRetainedInterventions: 3 }, bus);

		for (let i = 0; i < 5; i++) {
			bus.emit(idleEvent());
		}
		await Bun.sleep(1);

		expect(guardian.decisionCount()).toBe(3);
	});

	it("gives every intervention a distinct id", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		for (let i = 0; i < 5; i++) {
			bus.emit(idleEvent());
		}
		await Bun.sleep(1);

		const ids = guardian.getInterventions().map(i => i.id);
		expect(new Set(ids).size).toBe(5);
	});
});

describe("GuardianDecisionEngine reporting", () => {
	it("counts advisories by intended action, so observe mode still reports honestly", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({ mode: "observe" }, bus);

		bus.emit(idleEvent());
		bus.emit(toolResultEvent("write_file", true));
		await Bun.sleep(1);

		expect(guardian.blockAdvisoryCount()).toBe(1);
		expect(guardian.infoAdvisoryCount()).toBe(1);
		expect(guardian.warningAdvisoryCount()).toBe(0);
		expect(guardian.decisionCount()).toBe(2);
	});

	it("counts a suppressed warning as a warning", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({ mode: "observe", warnAgentThreshold: 0 }, bus);

		bus.emit(toolResultEvent("write_file", true));
		await Bun.sleep(1);

		expect(guardian.getLastIntervention()?.decision.action).toBe("IGNORE");
		expect(guardian.warningAdvisoryCount()).toBe(1);
	});

	it("counts enabled triggers as active rules", () => {
		expect(engine().activeRuleCount()).toBe(10);
		expect(engine({ triggers: { ...DEFAULT_GUARDIAN_CONFIG.triggers, idle: false } }).activeRuleCount()).toBe(9);
	});

	it("collapses the five-state mode onto the two-state wire format", () => {
		expect(engine({ mode: "observe" }).getDecisionEngineMode()).toBe("observe");
		expect(engine({ mode: "suggest" }).getDecisionEngineMode()).toBe("observe");
		expect(engine({ mode: "off" }).getDecisionEngineMode()).toBe("observe");
		expect(engine({ mode: "active" }).getDecisionEngineMode()).toBe("enforce");
		expect(engine({ mode: "strict" }).getDecisionEngineMode()).toBe("enforce");
	});

	it("returns only the most recent interventions up to the limit", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		for (let i = 0; i < 4; i++) {
			bus.emit(idleEvent());
		}
		await Bun.sleep(1);

		expect(guardian.getInterventions(2).length).toBe(2);
		expect(guardian.getInterventions(2).at(-1)?.id).toBe(guardian.getLastIntervention()?.id);
	});

	it("attaches usefulness feedback to the intervention it names", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		bus.emit(idleEvent());
		await Bun.sleep(1);

		const id = guardian.getLastIntervention()?.id ?? "";
		guardian.recordUsefulness(id, "USED");
		expect(guardian.getLastIntervention()?.usefulness).toBe("USED");
	});

	it("ignores feedback for an unknown intervention id", () => {
		expect(() => {
			engine().recordUsefulness("does-not-exist", "USED");
		}).not.toThrow();
	});
});

describe("GuardianDecisionEngine configuration", () => {
	it("hands back a copy that cannot be used to mutate the engine", () => {
		const guardian = engine();
		const config = guardian.getConfig();
		config.mode = "strict";
		config.triggers.idle = false;

		expect(guardian.getConfig().mode).toBe("observe");
		expect(guardian.getConfig().triggers.idle).toBe(true);
	});

	it("applies a threshold change immediately", () => {
		const guardian = engine();
		expect(guardian.decideAction(0.6)).toBe("INJECT_CONTEXT");

		guardian.updateConfig({ warnAgentThreshold: 0.6 });
		expect(guardian.decideAction(0.6)).toBe("WARN_AGENT");
	});

	it("applies a mode change immediately", () => {
		const guardian = engine();
		expect(guardian.applyMode("WARN_AGENT")).toBe("IGNORE");

		guardian.updateConfig({ mode: "active" });
		expect(guardian.applyMode("WARN_AGENT")).toBe("WARN_AGENT");
	});

	it("merges triggers rather than replacing the whole set", () => {
		const guardian = engine();
		guardian.updateConfig({ triggers: { ...guardian.getConfig().triggers, idle: false } });

		expect(guardian.getConfig().triggers.idle).toBe(false);
		expect(guardian.getConfig().triggers.toolCall).toBe(true);
	});

	it("does not resubscribe when triggers change, so off is the way to silence a live engine", async () => {
		const bus = new SessionEventBus();
		const guardian = engine({}, bus);

		guardian.updateConfig({ triggers: { ...guardian.getConfig().triggers, idle: false } });
		bus.emit(idleEvent());
		await Bun.sleep(1);
		expect(guardian.decisionCount()).toBe(1);

		guardian.updateConfig({ mode: "off" });
		bus.emit(idleEvent());
		await Bun.sleep(1);
		expect(guardian.getLastIntervention()?.decision.action).toBe("IGNORE");
	});
});
