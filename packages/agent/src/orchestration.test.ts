import { describe, expect, test } from "bun:test";
import { applyDecision, createInitialOrchestrationState, decideNextAction, orchestrationStateFrom, strategyFingerprint } from "./orchestration";
import { classifyTask } from "./task-router";

function stateFor(task: string) { return orchestrationStateFrom(task, classifyTask(task)); }

describe("adaptive orchestration state machine", () => {
	test("simple task takes the minimum path", () => {
		const state = stateFor("change the button label");
		expect(state.currentPhase).toBe("IMPLEMENT");
		expect(decideNextAction(state).action).toBe("IMPLEMENT");
		state.changedFiles = ["src/button.tsx"];
		state.verification.workspaceChanged = true;
		expect(decideNextAction(state).action).toBe("VERIFY");
		state.currentPhase = "VERIFY";
		state.verification.state = "VERIFIED";
		expect(decideNextAction(state).action).toBe("COMPLETE");
	});

	test("normal task plans before implementation", () => {
		const state = stateFor("add a new endpoint and tests");
		expect(state.currentPhase).toBe("UNDERSTAND");
		state.repository.available = true;
		expect(decideNextAction(state).action).toBe("PLAN");
		applyDecision(state, decideNextAction(state), 1000);
		expect(state.currentPhase).toBe("PLAN");
		expect(decideNextAction(state).action).toBe("IMPLEMENT");
	});

	test("complex task can discover before planning", () => {
		const state = stateFor("redesign authentication architecture across frontend backend api database and worker");
		if (state.complexity === "SIMPLE" || state.complexity === "NORMAL") state.complexity = "COMPLEX";
		expect(decideNextAction(state).action).toBe("DISCOVER");
	});

	test("verification is a completion gate", () => {
		const state = stateFor("implement the checkout feature and tests");
		state.complexity = "NORMAL";
		state.changedFiles = ["checkout.ts"];
		state.verification.workspaceChanged = true;
		state.verification.state = "PENDING";
		state.currentPhase = "VERIFY";
		expect(decideNextAction(state).action).toBe("VERIFY");
		state.verification.state = "VERIFIED";
		expect(decideNextAction(state).action).not.toBe("COMPLETE");
	});

	test("failure follows diagnose -> repair -> verify", () => {
		const state = stateFor("fix the authentication bug");
		state.currentPhase = "VERIFY";
		state.changedFiles = ["auth.ts"];
		state.verification.workspaceChanged = true;
		state.verification.state = "FAILED";
		state.failure = { present: true, category: "type_error", check: "typecheck", repeatCount: 1 };
		expect(decideNextAction(state).action).toBe("DIAGNOSE");
		applyDecision(state, decideNextAction(state), 1000);
		expect(decideNextAction(state).action).toBe("REPAIR");
		applyDecision(state, decideNextAction(state), 2000);
		expect(decideNextAction(state).action).toBe("VERIFY");
	});

	test("repair does not immediately loop; it waits for fresh verification", () => {
		const state = stateFor("fix a failing test");
		state.currentPhase = "RECOVER";
		state.failure = { present: true, category: "test_failure", check: "unit", repeatCount: 1 };
		const first = decideNextAction(state);
		expect(first.action).toBe("DIAGNOSE");
		applyDecision(state, first, 1000);
		const diagnoseNext = decideNextAction(state);
		expect(diagnoseNext.action).toBe("REPAIR");
		applyDecision(state, diagnoseNext, 2000);
		const verify = decideNextAction(state);
		expect(verify.action).toBe("VERIFY");
		applyDecision(state, verify, 3000);
		expect(decideNextAction(state).action).toBe("VERIFY");
		state.verification.state = "FAILED";
		expect(decideNextAction(state).action).toBe("DIAGNOSE");
	});

	test("repeated failure escalates, refreshes context, then repairs", () => {
		const state = stateFor("repair the authentication subsystem");
		state.complexity = "COMPLEX";
		state.failure = { present: true, category: "test_failure", check: "auth.test", repeatCount: 2 };
		const escalation = decideNextAction(state);
		expect(escalation.action).toBe("ESCALATE");
		applyDecision(state, escalation, 1000);
		const refresh = decideNextAction(state);
		expect(refresh.action).toBe("REFRESH_CONTEXT");
		applyDecision(state, refresh, 2000);
		expect(decideNextAction(state).action).toBe("REPAIR");
	});

	test("stagnation changes strategy instead of repeating", () => {
		const state = stateFor("fix the failing authentication test");
		state.currentPhase = "RECOVER";
		state.failure = { present: true, category: "test_failure", check: "auth.test", repeatCount: 1 };
		const fingerprint = strategyFingerprint(state, "REPAIR");
		state.strategyHistory = [fingerprint, fingerprint];
		expect(decideNextAction(state).action).toBe("REFRESH_CONTEXT");
	});

	test("blocked verification is never success", () => {
		const state = stateFor("run the integration tests");
		state.verification.state = "BLOCKED";
		state.verification.blocked = true;
		expect(decideNextAction(state).action).toBe("BLOCK");
		applyDecision(state, decideNextAction(state), 1000);
		expect(state.outcome).toBe("BLOCKED");
	});

	test("context pressure compacts once", () => {
		const state = stateFor("implement a feature");
		state.context.pressure = 0.95;
		expect(decideNextAction(state).action).toBe("COMPACT");
		applyDecision(state, decideNextAction(state), 1000);
		expect(decideNextAction(state).action).not.toBe("COMPACT");
	});

	test("repository refresh is finite", () => {
		const state = stateFor("update the data layer");
		state.currentPhase = "PLAN";
		state.repository.changed = true;
		expect(decideNextAction(state).action).toBe("REFRESH_REPOSITORY");
		applyDecision(state, decideNextAction(state), 1000);
		expect(state.repository.changed).toBe(false);
		expect(state.currentPhase).toBe("UNDERSTAND");
	});

	test("complex verified task gets one bounded review", () => {
		const state = stateFor("redesign the authentication architecture");
		state.complexity = "COMPLEX";
		state.currentPhase = "VERIFY";
		state.changedFiles = ["auth.ts"];
		state.verification.workspaceChanged = true;
		state.verification.state = "VERIFIED";
		expect(decideNextAction(state).action).toBe("REVIEW");
		state.reviewRequested = true;
		state.currentPhase = "REVIEW";
		state.reviewCompleted = false;
		expect(decideNextAction(state).action).toBe("REVIEW");
		state.reviewCompleted = true;
		expect(decideNextAction(state).action).toBe("COMPLETE");
	});

	test("unsupported reasoning capability changes review requirements without replacing execution", () => {
		const state = stateFor("redesign the authentication architecture");
		state.complexity = "COMPLEX";
		state.modelCapabilities = { reasoning: "unsupported" } as typeof state.modelCapabilities;
		state.currentPhase = "REVIEW";
		state.reviewCompleted = false;
		state.verification.state = "VERIFIED";
		const decision = decideNextAction(state);
		expect(decision.action).toBe("REVIEW");
		expect(decision.requiredCapabilities).toContain("reasoning");
	});

	test("state initialization extracts file and symbol hints", () => {
		const state = createInitialOrchestrationState("update `Agent.prompt()` in packages/agent/src/agent.ts", classifyTask("update `Agent.prompt()` in packages/agent/src/agent.ts"));
		expect(state.activeFiles.some(file => file.includes("packages/agent/src/agent.ts"))).toBe(true);
		expect(state.activeSymbols).toContain("Agent.prompt()");
	});
});
