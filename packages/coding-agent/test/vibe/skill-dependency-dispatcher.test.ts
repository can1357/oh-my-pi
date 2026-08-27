import { describe, expect, test } from "bun:test";
import { createSkillDependencyDispatcher } from "../../src/vibe/skill-dependency-dispatcher";

const request = {
	type: "dependency_required",
	skill: "demo",
	args: "--x",
	execution_owner: "parent_active_session",
	status: "not_run",
	reason: "delegated_worker_boundary",
	dependent_gate: "gate",
	dependent_artifact: "a",
} as const;
function fake(overrides: Partial<any> = {}) {
	let listener: any;
	let unsubscribed = 0;
	return {
		state: { listener: () => listener, unsubscribed: () => unsubscribed },
		adapter: {
			enabled: () => true,
			knownSkill: () => true,
			buildMessage: async () => ({ ok: true }),
			send: async () => true,
			subscribe: (fn: any) => {
				listener = fn;
				return () => {
					unsubscribed++;
				};
			},
			timeoutMs: 10,
			...overrides,
		},
	};
}
describe("SDK skill dependency dispatcher", () => {
	test("disabled and unknown skills fail", async () => {
		for (const overrides of [{ enabled: () => false }, { knownSkill: () => false }]) {
			const f = fake(overrides);
			const r = await createSkillDependencyDispatcher(f.adapter)(request, "p");
			expect(r).toMatchObject({ type: "skill-dispatch-result/v1", status: "failed" });
		}
	});
	test("send false reports failure", async () => {
		const f = fake({ send: async () => false });
		expect((await createSkillDependencyDispatcher(f.adapter)(request, "p")).evidence).toBe("parent_turn_not_started");
	});
	test("agent_end returns correlated success and unsubscribes", async () => {
		const f = fake();
		const p = createSkillDependencyDispatcher(f.adapter)(request, "p");
		await Promise.resolve();
		f.state.listener()({ type: "agent_end" });
		const r = await p;
		expect(r).toMatchObject({ status: "success", correlationId: "p:demo:--x" });
		expect(f.state.unsubscribed()).toBe(1);
	});
	test("error notification returns failure and unsubscribes", async () => {
		const f = fake();
		const p = createSkillDependencyDispatcher(f.adapter)(request, "p");
		await Promise.resolve();
		f.state.listener()({ type: "notice", level: "error", message: "bad" });
		expect(await p).toMatchObject({ status: "failed", evidence: "bad" });
		expect(f.state.unsubscribed()).toBe(1);
	});
	test("timeout returns failure and unsubscribes", async () => {
		const f = fake({ timeoutMs: 1 });
		const r = await createSkillDependencyDispatcher(f.adapter)(request, "p");
		expect(r).toMatchObject({ status: "failed", evidence: "parent_dispatch_timeout" });
		expect(f.state.unsubscribed()).toBe(1);
	});
});
