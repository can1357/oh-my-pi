import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	DEFAULT_GUARDIAN_CONFIG,
	type GuardianConfig,
	GuardianDecisionEngine,
	type GuardianIntervention,
	type GuardianMemoryRecord,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/decision-engine";
import {
	type ExtractedEntities,
	type SessionEvent,
	SessionEventBus,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/event-bus";
import {
	createRetrievalQuery,
	formatGuardianInjection,
	type GuardianIntegrationOptions,
	type GuardianReport,
	type GuardianRetrievalPort,
	type GuardianRetrievalQuery,
	type GuardianScope,
	GuardianSessionIntegration,
	initializeGuardian,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/integration";

const TS = "2024-01-01T00:00:00.000Z";

const SCOPE: GuardianScope = { projectId: "p1", sessionId: "s1", worktreeId: "w1" };

function memory(id: string): GuardianMemoryRecord {
	return {
		memoryId: id,
		type: "evidence",
		content: `content of ${id}`,
		status: "active",
		verification: "test-observed",
		createdAt: TS,
		retrievalCount: 0,
	};
}

function toolResultEvent(toolName: string): SessionEvent {
	return {
		type: "tool-result",
		sessionId: "s1",
		toolName,
		args: {},
		result: {} as ToolResultMessage,
		toolCallId: "tc1",
		timestamp: TS,
		isError: true,
	};
}

function idleEvent(): SessionEvent {
	return { type: "idle", sessionId: "s1", idleDurationMs: 1000, timestamp: TS };
}

function compactionEvent(): SessionEvent {
	return {
		type: "compaction",
		sessionId: "s1",
		trigger: "token-limit",
		tokensBefore: 10,
		summary: "s",
		timestamp: TS,
	};
}

interface PortOptions {
	records?: GuardianMemoryRecord[];
	contextText?: string;
	/** Reject every retrieval from this call index onwards. */
	failAfterCalls?: number;
	/** Per-call artificial latency, used to prove ordering is preserved. */
	delays?: number[];
	withCheckpoint?: boolean;
	withMaintenance?: boolean;
}

interface Recorder {
	port: GuardianRetrievalPort;
	queries: GuardianRetrievalQuery[];
	/** Retrieval identifiers in the order their promises resolved. */
	completions: string[];
	composeBudgets: number[];
	checkpointLabels: string[];
	maintenanceReasons: string[];
}

function recordingPort(options: PortOptions = {}): Recorder {
	const records = options.records ?? [memory("m1"), memory("m2")];
	const queries: GuardianRetrievalQuery[] = [];
	const completions: string[] = [];
	const composeBudgets: number[] = [];
	const checkpointLabels: string[] = [];
	const maintenanceReasons: string[] = [];

	const port: GuardianRetrievalPort = {
		retrieve(query) {
			queries.push(query);
			const index = queries.length - 1;
			if (options.failAfterCalls !== undefined && index >= options.failAfterCalls) {
				return Promise.reject(new Error("retrieval unavailable"));
			}
			const label = query.errors[0] ?? `call-${index}`;
			return Bun.sleep(options.delays?.[index] ?? 0).then(() => {
				completions.push(label);
				return records;
			});
		},
		getWorkingState() {
			return Promise.resolve(null);
		},
		composeContext(given, budgetTokens) {
			composeBudgets.push(budgetTokens);
			return Promise.resolve({
				text: options.contextText ?? given.map(r => r.content).join("\n"),
				recordIds: given.map(r => r.memoryId),
				tokenCount: given.length * 10,
			});
		},
	};

	if (options.withCheckpoint !== false) {
		port.createCheckpoint = (_sessionId, label) => {
			checkpointLabels.push(label);
			return Promise.resolve("cp1");
		};
	}
	if (options.withMaintenance !== false) {
		port.queueMaintenance = (_sessionId, reason) => {
			maintenanceReasons.push(reason);
			return Promise.resolve();
		};
	}

	return { port, queries, completions, composeBudgets, checkpointLabels, maintenanceReasons };
}

interface Harness extends Recorder {
	bus: SessionEventBus;
	engine: GuardianDecisionEngine;
	integration: GuardianSessionIntegration;
	reports: GuardianReport[];
}

/**
 * Build an engine plus a started integration over a recording port.
 *
 * Defaults to `active` mode: `observe` exists to suppress exactly the actions
 * this file is about, so testing the acting half in observe mode would assert
 * that nothing happens.
 */
function setup(
	config: Partial<GuardianConfig> = {},
	portOptions: PortOptions = {},
	integrationOptions: Partial<GuardianIntegrationOptions> = {},
	autoStart = true,
): Harness {
	const bus = new SessionEventBus();
	const recorder = recordingPort(portOptions);
	const reports: GuardianReport[] = [];
	const engine = new GuardianDecisionEngine({ mode: "active", ...config }, bus);
	const integration = new GuardianSessionIntegration(engine, {
		scope: SCOPE,
		port: recorder.port,
		reporter: report => reports.push(report),
		...integrationOptions,
	});
	if (autoStart) integration.start();
	return { ...recorder, bus, engine, integration, reports };
}

/** Thresholds that force a given rung of the ladder regardless of the score. */
const FORCE_WARN: Partial<GuardianConfig> = { warnAgentThreshold: 0 };
const FORCE_INJECT: Partial<GuardianConfig> = { warnAgentThreshold: 0.99, injectContextThreshold: 0 };
const FORCE_RETRIEVE: Partial<GuardianConfig> = {
	warnAgentThreshold: 0.99,
	injectContextThreshold: 0.98,
	retrieveSilentlyThreshold: 0,
};

describe("createRetrievalQuery", () => {
	function decisionFor(overrides: Partial<ExtractedEntities>) {
		const guardian = new GuardianDecisionEngine({ mode: "off" }, new SessionEventBus());
		return guardian.decide(idleEvent(), {
			entities: { files: [], symbols: [], errors: [], taskNames: [], commands: [], ...overrides },
			intent: "debugging",
			workingState: null,
			recentMemories: [],
			retrievedRecords: [],
			estimatedLatencyMs: 0,
		});
	}

	it("assembles query text from every entity kind", () => {
		const query = createRetrievalQuery(
			decisionFor({ taskNames: ["migrate"], errors: ["ENOENT"], symbols: ["parseConfig"], files: ["a.ts"] }),
			SCOPE,
		);

		expect(query.text).toBe("migrate ENOENT parseConfig a.ts");
		expect(query.intent).toBe("debugging");
		expect(query.scope).toBe(SCOPE);
		expect(query.limit).toBe(12);
	});

	it("drops blank and whitespace-only entities", () => {
		const query = createRetrievalQuery(decisionFor({ taskNames: ["  ", ""], symbols: [" trim "] }), SCOPE);

		expect(query.text).toBe("trim");
	});

	it("copies entity arrays rather than aliasing the decision", () => {
		const decision = decisionFor({ files: ["a.ts"] });
		const query = createRetrievalQuery(decision, SCOPE);

		query.files.push("b.ts");

		expect(decision.entities.files).toEqual(["a.ts"]);
	});

	it("honours an explicit limit", () => {
		expect(createRetrievalQuery(decisionFor({}), SCOPE, 3).limit).toBe(3);
	});
});

describe("formatGuardianInjection", () => {
	const context = { text: "remembered thing", recordIds: ["m1"], tokenCount: 4 };

	it("marks a warning as conflicting", () => {
		const text = formatGuardianInjection({
			interventionId: "i1",
			trigger: "tool-call",
			action: "WARN_AGENT",
			warning: true,
			context,
		});

		expect(text).toContain("conflict");
		expect(text).toContain("remembered thing");
	});

	it("presents a plain injection as merely relevant", () => {
		const text = formatGuardianInjection({
			interventionId: "i1",
			trigger: "tool-call",
			action: "INJECT_CONTEXT",
			warning: false,
			context,
		});

		expect(text).not.toContain("conflict");
		expect(text).toContain("may be relevant");
	});
});

describe("GuardianDecisionEngine decision seam", () => {
	it("notifies a listener with the recorded intervention and its event", async () => {
		const bus = new SessionEventBus();
		const guardian = new GuardianDecisionEngine({}, bus);
		const seen: Array<[GuardianIntervention, SessionEvent]> = [];

		guardian.onDecision((intervention, event) => seen.push([intervention, event]));
		bus.emit(idleEvent());
		await Bun.sleep(1);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.[0].id).toBe(guardian.getLastIntervention()?.id ?? "");
		expect(seen[0]?.[1].type).toBe("idle");
	});

	it("stops delivering after unsubscribe", async () => {
		const bus = new SessionEventBus();
		const guardian = new GuardianDecisionEngine({}, bus);
		let calls = 0;

		const unsubscribe = guardian.onDecision(() => {
			calls++;
		});
		bus.emit(idleEvent());
		unsubscribe();
		bus.emit(idleEvent());
		await Bun.sleep(1);

		expect(calls).toBe(1);
		expect(guardian.decisionCount()).toBe(2);
	});

	it("isolates a listener that throws", async () => {
		const bus = new SessionEventBus();
		const guardian = new GuardianDecisionEngine({}, bus);
		let reached = 0;

		guardian.onDecision(() => {
			throw new Error("listener exploded");
		});
		guardian.onDecision(() => {
			reached++;
		});

		expect(() => bus.emit(idleEvent())).not.toThrow();
		await Bun.sleep(1);
		expect(reached).toBe(1);
	});

	it("clears listeners on dispose", async () => {
		const bus = new SessionEventBus();
		const guardian = new GuardianDecisionEngine({}, bus);
		let calls = 0;

		guardian.onDecision(() => {
			calls++;
		});
		guardian.dispose();
		bus.emit(idleEvent());
		await Bun.sleep(1);

		expect(calls).toBe(0);
	});
});

describe("GuardianSessionIntegration", () => {
	it("retrieves and stages context for INJECT_CONTEXT", async () => {
		const h = setup(FORCE_INJECT);

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.queries).toHaveLength(1);
		expect(h.queries[0]?.scope).toBe(SCOPE);

		const pending = h.integration.peekInjection();
		expect(pending?.action).toBe("INJECT_CONTEXT");
		expect(pending?.warning).toBe(false);
		expect(pending?.context.recordIds).toEqual(["m1", "m2"]);
		expect(pending?.context.tokenCount).toBe(20);
	});

	it("flags a WARN_AGENT injection as a warning", async () => {
		const h = setup(FORCE_WARN);

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.integration.peekInjection()?.warning).toBe(true);
		expect(h.integration.peekInjection()?.action).toBe("WARN_AGENT");
	});

	it("retrieves but stages nothing for RETRIEVE_SILENTLY", async () => {
		const h = setup(FORCE_RETRIEVE);

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.queries).toHaveLength(1);
		expect(h.composeBudgets).toHaveLength(0);
		expect(h.integration.peekInjection()).toBeNull();
		expect(h.integration.getLastRetrievedRecords()).toHaveLength(2);
	});

	it("does not retrieve for CAPTURE_ONLY", async () => {
		// Default thresholds: a failed tool call alone does not clear 0.3.
		const h = setup();

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.engine.getLastIntervention()?.decision.action).toBe("CAPTURE_ONLY");
		expect(h.queries).toHaveLength(0);
	});

	it("hands the staged context out exactly once", async () => {
		const h = setup(FORCE_INJECT);

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.integration.takeInjection()?.context.recordIds).toEqual(["m1", "m2"]);
		expect(h.integration.takeInjection()).toBeNull();
	});

	it("records what it injected on the intervention itself", async () => {
		const h = setup(FORCE_INJECT);

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		const intervention = h.engine.getLastIntervention();
		expect(intervention?.injectedRecordIds).toEqual(["m1", "m2"]);
		expect(intervention?.tokenCount).toBe(20);
	});

	it("stages nothing when retrieval matched no records", async () => {
		const h = setup(FORCE_INJECT, { records: [] });

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.integration.peekInjection()).toBeNull();
		expect(h.reports.some(r => r.message === "no records matched")).toBe(true);
	});

	it("stages nothing when the composed context is empty", async () => {
		const h = setup(FORCE_INJECT, { contextText: "   " });

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.integration.peekInjection()).toBeNull();
		expect(h.engine.getLastIntervention()?.injectedRecordIds).toEqual([]);
	});

	it("applies the configured token budget and record limit", async () => {
		const h = setup(FORCE_INJECT, {}, { maxInjectionTokens: 64, maxRecordsPerRetrieval: 3 });

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.composeBudgets).toEqual([64]);
		expect(h.queries[0]?.limit).toBe(3);
	});

	it("checkpoints when the engine forces CHECKPOINT_NOW", async () => {
		const h = setup();

		h.bus.emit(compactionEvent());
		await h.integration.whenIdle();

		expect(h.checkpointLabels).toEqual(["compaction"]);
	});

	it("queues maintenance when the engine forces QUEUE_MAINTENANCE", async () => {
		const h = setup();

		h.bus.emit(idleEvent());
		await h.integration.whenIdle();

		expect(h.maintenanceReasons).toEqual(["idle"]);
	});

	it("degrades rather than failing when the port has no checkpoint store", async () => {
		const h = setup({}, { withCheckpoint: false });

		h.bus.emit(compactionEvent());
		await h.integration.whenIdle();

		expect(h.integration.getLastError()).toBeNull();
		expect(h.reports.some(r => r.message.includes("no checkpoint store"))).toBe(true);
	});

	it("degrades rather than failing when the port has no maintenance queue", async () => {
		const h = setup({}, { withMaintenance: false });

		h.bus.emit(idleEvent());
		await h.integration.whenIdle();

		expect(h.integration.getLastError()).toBeNull();
		expect(h.reports.some(r => r.message.includes("no maintenance queue"))).toBe(true);
	});

	it("reports a retrieval failure without throwing into the session", async () => {
		const h = setup(FORCE_INJECT, { failAfterCalls: 0 });

		expect(() => h.bus.emit(toolResultEvent("write_file"))).not.toThrow();
		await h.integration.whenIdle();

		expect(h.integration.getLastError()?.message).toBe("retrieval unavailable");
		expect(h.reports.some(r => r.level === "error")).toBe(true);
	});

	it("keeps processing decisions after a failure", async () => {
		const h = setup(FORCE_INJECT, { failAfterCalls: 0 });

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();
		h.bus.emit(toolResultEvent("edit_file"));
		await h.integration.whenIdle();

		expect(h.queries).toHaveLength(2);
	});

	it("keeps staged context on failure when failing open", async () => {
		const h = setup(FORCE_INJECT, { failAfterCalls: 1 });

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();
		expect(h.integration.peekInjection()).not.toBeNull();

		h.bus.emit(toolResultEvent("edit_file"));
		await h.integration.whenIdle();

		expect(h.integration.peekInjection()).not.toBeNull();
	});

	it("drops staged context on failure when failing closed", async () => {
		const h = setup(FORCE_INJECT, { failAfterCalls: 1 }, { failOpen: false });

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();
		expect(h.integration.peekInjection()).not.toBeNull();

		h.bus.emit(toolResultEvent("edit_file"));
		await h.integration.whenIdle();

		expect(h.integration.peekInjection()).toBeNull();
	});

	it("applies decisions in the order they were made, not the order they finish", async () => {
		const h = setup(FORCE_INJECT, { delays: [20, 0] });

		h.bus.emit(toolResultEvent("write_file"));
		h.bus.emit(toolResultEvent("edit_file"));
		await h.integration.whenIdle();

		expect(h.completions).toEqual(["Failed to run tool write_file", "Failed to run tool edit_file"]);
	});

	it("does nothing until started", async () => {
		const h = setup(FORCE_INJECT, {}, {}, false);

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.queries).toHaveLength(0);
		expect(h.engine.decisionCount()).toBe(1);
	});

	it("is idempotent across repeated start calls", async () => {
		const h = setup(FORCE_INJECT);

		h.integration.start();
		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.queries).toHaveLength(1);
	});

	it("detaches and discards staged context on stop", async () => {
		const h = setup(FORCE_INJECT);

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();
		expect(h.integration.peekInjection()).not.toBeNull();

		h.integration.stop();
		expect(h.integration.peekInjection()).toBeNull();

		h.bus.emit(toolResultEvent("edit_file"));
		await h.integration.whenIdle();
		expect(h.queries).toHaveLength(1);
	});

	it("swallows a reporter that throws", async () => {
		const h = setup(
			FORCE_INJECT,
			{},
			{
				reporter: () => {
					throw new Error("reporter exploded");
				},
			},
		);

		h.bus.emit(toolResultEvent("write_file"));
		await h.integration.whenIdle();

		expect(h.integration.getLastError()).toBeNull();
		expect(h.integration.peekInjection()).not.toBeNull();
	});
});

describe("initializeGuardian", () => {
	it("returns a started runtime wired to the bus", async () => {
		const bus = new SessionEventBus();
		const recorder = recordingPort();
		const runtime = initializeGuardian(bus, { scope: SCOPE, port: recorder.port }, { mode: "active" });

		bus.emit(idleEvent());
		await runtime.integration.whenIdle();

		expect(recorder.maintenanceReasons).toEqual(["idle"]);
		expect(runtime.engine.decisionCount()).toBe(1);
	});

	it("stops the integration when the session stops", async () => {
		const bus = new SessionEventBus();
		const recorder = recordingPort();
		const options = { scope: SCOPE, port: recorder.port };
		const runtime = initializeGuardian(bus, options, { ...FORCE_INJECT, mode: "active" });

		bus.emit({ type: "session-stop", sessionId: "s1", reason: "completed", timestamp: TS });
		await runtime.integration.whenIdle();

		bus.emit(toolResultEvent("write_file"));
		await runtime.integration.whenIdle();

		expect(recorder.queries).toHaveLength(0);
	});

	it("discards context staged for a turn that never happened on resume", async () => {
		const bus = new SessionEventBus();
		const recorder = recordingPort();
		// The resume trigger is disabled so the resume itself cannot re-stage
		// context while we are asserting that it cleared the previous turn's.
		const runtime = initializeGuardian(
			bus,
			{ scope: SCOPE, port: recorder.port },
			{
				...FORCE_INJECT,
				mode: "active",
				triggers: { ...DEFAULT_GUARDIAN_CONFIG.triggers, resume: false },
			},
		);

		bus.emit(toolResultEvent("write_file"));
		await runtime.integration.whenIdle();
		expect(runtime.integration.peekInjection()).not.toBeNull();

		bus.emit({ type: "resume", sessionId: "s2", parentSessionId: "s1", timestamp: TS });
		await runtime.integration.whenIdle();

		expect(runtime.integration.peekInjection()).toBeNull();
	});

	it("releases every bus subscription on dispose", async () => {
		const bus = new SessionEventBus();
		const recorder = recordingPort();
		const runtime = initializeGuardian(bus, { scope: SCOPE, port: recorder.port }, { mode: "active" });

		runtime.dispose();

		expect(bus.listenerCount("idle")).toBe(0);
		expect(bus.listenerCount("session-stop")).toBe(0);

		bus.emit(idleEvent());
		await Bun.sleep(1);

		expect(runtime.engine.decisionCount()).toBe(0);
		expect(recorder.maintenanceReasons).toHaveLength(0);
	});
});
