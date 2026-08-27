import { describe, expect, test } from "bun:test";
import {
	buildVibeDelegatedAssignment,
	coordinateDelegatedSkillDependency,
	parseDelegatedSkillDependency,
	validateSkillDispatchResult,
} from "../../src/vibe/delegated-skill-boundary";

const valid = {
	type: "dependency_required",
	skill: "gap-analysis",
	args: "--dalio",
	execution_owner: "parent_active_session",
	status: "not_run",
	reason: "delegated_worker_boundary",
	dependent_gate: "completion",
	dependent_artifact: "product/gap.md",
};
const success = {
	type: "skill-dispatch-result/v1",
	skill: "gap-analysis",
	status: "success",
	evidence: "agent_end",
} as const;

describe("delegated skill boundary", () => {
	test("builds a delegated assignment without changing the task", () => {
		const result = buildVibeDelegatedAssignment("run gap-analysis --dalio");
		expect(result).toContain("run gap-analysis --dalio");
		expect(result).toContain('"type":"dependency_required"');
	});
	test("accepts valid requests and rejects malformed, embedded, missing, extra, empty, and unsafe fields", () => {
		expect(parseDelegatedSkillDependency(JSON.stringify(valid))?.skill).toBe("gap-analysis");
		for (const value of [
			"{",
			`prefix ${JSON.stringify(valid)}`,
			{ ...valid, extra: true },
			{ ...valid, dependent_gate: "" },
			{ ...valid, skill: "" },
			{ ...valid, skill: "Gap Analysis" },
			{ ...valid, args: "x\ny" },
			{ ...valid, args: "/skill:foo" },
			{ ...valid, args: "x".repeat(2049) },
			{ ...valid, dependent_artifact: "" },
		]) {
			expect(parseDelegatedSkillDependency(typeof value === "string" ? value : JSON.stringify(value))).toBeNull();
		}
	});
	test("validates exact dispatch result keys, skill, status, and evidence", () => {
		expect(validateSkillDispatchResult(success, "gap-analysis")?.status).toBe("success");
		expect(validateSkillDispatchResult({ ...success, skill: "other" }, "gap-analysis")).toBeNull();
		expect(validateSkillDispatchResult({ ...success, status: "failed" }, "gap-analysis")?.status).toBe("failed");
		expect(validateSkillDispatchResult({ ...success, evidence: "" }, "gap-analysis")).toBeNull();
		expect(validateSkillDispatchResult({ ...success, extra: true }, "gap-analysis")).toBeNull();
	});
	test("dispatches once and resumes the same worker with verified evidence", async () => {
		const cache = new Map();
		let calls = 0;
		const resumed: unknown[] = [];
		const result = await coordinateDelegatedSkillDependency(
			JSON.stringify(valid),
			async () => {
				calls++;
				return success;
			},
			async payload => {
				resumed.push(payload);
			},
			cache,
		);
		expect(result.handled).toBe(true);
		expect(calls).toBe(1);
		expect(resumed).toEqual([success]);
	});
	test("deduplicates dispatch and resume, and keeps failed or ordinary output blocked/bypassed", async () => {
		const cache = new Map();
		let calls = 0;
		let resumes = 0;
		const dispatch = async () => {
			calls++;
			return success;
		};
		await coordinateDelegatedSkillDependency(
			JSON.stringify(valid),
			dispatch,
			async () => {
				resumes++;
			},
			cache,
		);
		await coordinateDelegatedSkillDependency(
			JSON.stringify(valid),
			dispatch,
			async () => {
				resumes++;
			},
			cache,
		);
		expect(calls).toBe(1);
		expect(resumes).toBe(1);
		const blocked = await coordinateDelegatedSkillDependency(
			JSON.stringify(valid),
			async () => ({ ...success, status: "failed" }),
			async () => {
				resumes++;
			},
			new Map(),
		);
		expect(blocked.handled).toBe(true);
		expect(blocked.result?.status).toBe("failed");
		expect(resumes).toBe(1);
		expect(
			(await coordinateDelegatedSkillDependency("ordinary output", dispatch, async () => {}, new Map())).handled,
		).toBe(false);
	});
});
test("accepts production-shaped correlated success evidence", async () => {
	const cache = new Map();
	let resumed = 0;
	const correlated = { ...success, correlationId: "parent:gap-analysis:--dalio" };
	const result = await coordinateDelegatedSkillDependency(
		JSON.stringify(valid),
		async () => correlated,
		async payload => {
			resumed++;
			expect(payload.correlationId).toBe(correlated.correlationId);
		},
		cache,
	);
	expect(result.result?.status).toBe("success");
	expect(resumed).toBe(1);
});
test("scopes idempotency by worker prefix", async () => {
	const cache = new Map();
	let calls = 0;
	const dispatch = async () => {
		calls++;
		return success;
	};
	await coordinateDelegatedSkillDependency(
		JSON.stringify(valid),
		dispatch,
		async () => {},
		cache,
		"owner:parent:worker-a",
	);
	await coordinateDelegatedSkillDependency(
		JSON.stringify(valid),
		dispatch,
		async () => {},
		cache,
		"owner:parent:worker-a",
	);
	await coordinateDelegatedSkillDependency(
		JSON.stringify(valid),
		dispatch,
		async () => {},
		cache,
		"owner:parent:worker-b",
	);
	expect(calls).toBe(2);
});
