import { describe, expect, test } from "bun:test";
import {
	buildRepairMessage,
	buildVerificationPlan,
	executeVerificationPlan,
	extractVerificationFailure,
	VerificationRecoveryController,
	type VerificationCheck,
	type VerificationFailure,
} from "../src/verification";
import { classifyTask, TaskRouteTracker } from "../src/task-router";

const check = (kind: VerificationCheck["kind"]): VerificationCheck => ({ name: "check", command: "bun", args: ["run", "check"], reason: "test", priority: 1, cost: "cheap", dependencies: [], kind });
const failure = (category: VerificationFailure["category"]): VerificationFailure => ({ check: "check", status: "failed", category, summary: `${category} failure`, relatedFiles: ["src/auth/session.ts"], affectedSymbols: ["refreshSession"], attempt: 1, rawOutputAvailable: true, rawOutput: "raw" });

describe("verification engine", () => {
	test("selects cheap meaningful checks before broader checks for a package change", () => {
		const plan = buildVerificationPlan({
			task: "Fix src/auth/session.ts",
			complexity: "COMPLEX",
			changedFiles: ["packages/agent/src/agent.ts"],
			availableScripts: {},
			packageScripts: { "packages/agent": { "check:types": "tsgo -p tsconfig.json --noEmit", test: "bun test --parallel", lint: "biome lint .", build: "bun run build" } },
		});
		expect(plan.checks.map(item => item.name)).toEqual([
			"packages/agent:check:types",
			"packages/agent:test",
			"packages/agent:lint",
			"packages/agent:build",
		]);
	});

	test("does not require application checks for documentation-only changes", () => {
		const plan = buildVerificationPlan({ task: "Update the README", complexity: "SIMPLE", changedFiles: ["README.md"], availableScripts: { test: "bun test" } });
		expect(plan.checks).toHaveLength(0);
	});

	test("extracts compact type evidence while preserving raw output", () => {
		const result = extractVerificationFailure(check("typecheck"), { stdout: "src/auth/session.ts:87 - error TS2322: Type string is not assignable to type number", stderr: "", code: 2, killed: false, durationMs: 4 }, 1);
		expect(result.category).toBe("TYPE_ERROR");
		expect(result.primaryError).toContain("TS2322");
		expect(result.relatedFiles.join(" ")).toContain("src/auth/session.ts");
		expect(result.rawOutputAvailable).toBe(true);
	});

	test("classifies blocked environment failures separately from code failures", async () => {
		const plan = { risk: "medium" as const, scope: "single-file" as const, checks: [check("test")], estimatedCost: "cheap" as const, requiredEvidence: ["check passed"], changedFiles: ["src/a.ts"], unexpectedFiles: [] };
		const result = await executeVerificationPlan(plan, { execute: async () => ({ stdout: "network connection refused", stderr: "", code: 1, killed: false, durationMs: 5 }) });
		expect(result.state).toBe("BLOCKED");
		expect(result.failure?.category).toBe("NETWORK_FAILURE");
	});

	test("cheap failure short-circuits expensive checks", async () => {
		const cheap = { ...check("typecheck"), name: "typecheck" };
		const expensive = { ...check("build"), name: "build", cost: "expensive" as const, priority: 2 };
		const plan = { risk: "high" as const, scope: "single-package" as const, checks: [cheap, expensive], estimatedCost: "expensive" as const, requiredEvidence: [], changedFiles: ["src/a.ts"], unexpectedFiles: [] };
		const executed: string[] = [];
		const result = await executeVerificationPlan(plan, { execute: async current => { executed.push(current.name); return { stdout: "error TS2322", stderr: "", code: 1, killed: false, durationMs: 2 }; } });
		expect(executed).toEqual(["typecheck"]);
		expect(result.state).toBe("FAILED");
	});

	test("returns unverified when no deterministic verification exists", async () => {
		const plan = buildVerificationPlan({ task: "Change README wording", complexity: "SIMPLE", changedFiles: ["README.md"], availableScripts: {} });
		const result = await executeVerificationPlan(plan, { execute: async () => ({ stdout: "", stderr: "", code: 0, killed: false, durationMs: 0 }) });
		expect(result.state).toBe("UNVERIFIED");
	});

	test("bounds repeated repair attempts and stops persistent same-failure loops", () => {
		const tracker = new TaskRouteTracker(classifyTask("Add pagination to the users endpoint."));
		const controller = new VerificationRecoveryController({ maxSameFailureRepairs: 2, maxTotalRepairs: 4 });
		const first = controller.decide(failure("TEST_FAILURE"), "workspace-a", tracker);
		expect(first.action).toBe("repair");
		const second = controller.decide(failure("TEST_FAILURE"), "workspace-b", tracker);
		expect(second.action === "repair" || second.action === "escalate").toBe(true);
		const third = controller.decide(failure("TEST_FAILURE"), "workspace-c", tracker);
		expect(third.action).toBe("stop");
	});

	test("environment failures never trigger autonomous repair", () => {
		const tracker = new TaskRouteTracker(classifyTask("Fix src/a.ts"));
		const controller = new VerificationRecoveryController();
		expect(controller.decide(failure("ENVIRONMENT_FAILURE"), "workspace", tracker).action).toBe("stop");
	});

	test("repeated verification failures escalate existing Task Router complexity", () => {
		const tracker = new TaskRouteTracker(classifyTask("Implement CSV export."));
		const controller = new VerificationRecoveryController();
		controller.decide(failure("TEST_FAILURE"), "a", tracker);
		const second = controller.decide(failure("TEST_FAILURE"), "b", tracker);
		expect(second.escalated).toBe(true);
		expect(tracker.current.complexity).toBe("COMPLEX");
	});

	test("repair message carries evidence and bounded next action", () => {
		const message = buildRepairMessage("Fix auth", failure("TYPE_ERROR"), ["typecheck: TYPE_ERROR"], undefined, "NORMAL");
		expect(message).toContain("TYPE_ERROR");
		expect(message).toContain("src/auth/session.ts");
		expect(message).toContain("targeted repair");
	});
});
