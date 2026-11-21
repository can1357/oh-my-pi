import { describe, expect, it } from "bun:test";
import type { Answer } from "@oh-my-pi/pi-ai";
import { COUPLED_AT, planFromAnswers, segmentRequest } from "@oh-my-pi/pi-coding-agent/auto-parallel/planner";

type Role = "context" | "task" | "wrapup";

const role = (choice: Role): Answer => ({
	type: "choice",
	choice,
	probabilities: { context: 0, task: 0, wrapup: 0, [choice]: 1 },
	confidence: 1,
});

/** Answers for `roles`, every pair at `base` P(coupled) except the 1-based `pairs` overrides (`"1_3": 0.9`). */
function answers(roles: Role[], pairs: Record<string, number> = {}, base = 0.05) {
	const out: Record<string, Answer> = {};
	for (let a = 1; a <= roles.length; a++) {
		out[`role_${a}`] = role(roles[a - 1]);
		for (let b = a + 1; b <= roles.length; b++)
			out[`coupled_${a}_${b}`] = { type: "noul", noul: pairs[`${a}_${b}`] ?? base };
	}
	return out;
}

describe("segmentRequest", () => {
	it("keeps a plain lead-in apart from its list and folds lines indented to an entry into that entry", () => {
		const request = [
			"i want to implement widgets.",
			"can you help me:",
			" - drop the status bar",
			" - design an editor mode",
			"    then it must show a set of widgets",
			"    it should also let you delete them",
			"- implement the default widgets",
		].join("\n");
		expect(segmentRequest(request)).toEqual([
			"i want to implement widgets.",
			"can you help me:",
			"drop the status bar",
			"design an editor mode\nthen it must show a set of widgets\nit should also let you delete them",
			"implement the default widgets",
		]);
	});

	it("keeps nested entries and fenced blocks with their item, even unindented fence content", () => {
		const request = [
			"1. the `find` tool",
			"   - cap results at 50",
			"```ts",
			"- not an item",
			"```",
			"2. the `glob` tool",
		].join("\n");
		expect(segmentRequest(request)).toEqual([
			"the `find` tool\n- cap results at 50\n```ts\n- not an item\n```",
			"the `glob` tool",
		]);
	});
});

describe("planFromAnswers", () => {
	const items = ["lead-in", "a", "b", "c", "run the tests"];

	it("joins task items transitively and keeps context and wrap-up out of every subtask", () => {
		// a–b and b–c coupled: one subtask, though a–c alone is not; context/wrap-up pairs are ignored.
		const plan = planFromAnswers(
			items,
			answers(["context", "task", "task", "task", "wrapup"], { "2_3": 0.9, "3_4": 0.9, "1_2": 0.99, "4_5": 0.99 }),
		);
		expect(plan).toEqual({ items, context: [0], wrapup: [4], subtasks: [[1, 2, 3]] });
	});

	it("splits at the coupling threshold, not below it", () => {
		const roles: Role[] = ["task", "task", "task"];
		expect(planFromAnswers(["a", "b", "c"], answers(roles, { "1_2": COUPLED_AT })).subtasks).toEqual([[0, 1], [2]]);
		expect(planFromAnswers(["a", "b", "c"], answers(roles, { "1_2": COUPLED_AT - 0.01 })).subtasks).toEqual([
			[0],
			[1],
			[2],
		]);
	});

	it("rejects a missing or out-of-range answer instead of splitting on it", () => {
		const missing = answers(["task", "task"]);
		delete missing.coupled_1_2;
		expect(() => planFromAnswers(["a", "b"], missing)).toThrow("coupled_1_2");
		expect(() => planFromAnswers(["a", "b"], answers(["task", "task"], { "1_2": 1.5 }))).toThrow("coupled_1_2");
	});
});
