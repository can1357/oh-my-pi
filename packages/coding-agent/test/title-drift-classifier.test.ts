import { describe, expect, it } from "bun:test";
import type { Judge, JudgmentRequest } from "@oh-my-pi/pi-ai";
import { classifyTitleDrift } from "@oh-my-pi/pi-coding-agent/session/title-drift-classifier";

/** A judge answering `fits` with `noul`, recording each request's state. */
function fitsJudge(noul: number, states: unknown[] = []): Judge {
	return {
		label: "stub",
		judge: async (request: JudgmentRequest) => {
			states.push(request.state);
			return {
				api: "stub",
				provider: "stub",
				model: "stub",
				answers: { fits: { type: "noul", noul } },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
			} as never;
		},
	};
}

const recent = [{ role: "user" as const, text: "now draft the release notes for 2.0" }];

describe("classifyTitleDrift", () => {
	it("judges the title without its card, and finds it stale below a 0.5 fit probability", async () => {
		const states: unknown[] = [];

		expect(await classifyTitleDrift(fitsJudge(0.31, states), "🧪 PARSER: Fix parser recovery", recent)).toBe(true);
		expect(await classifyTitleDrift(fitsJudge(0.62), "Draft release notes", recent)).toBe(false);
		// The card is how the terminal indexes the session, not what it works on.
		expect(states).toEqual([{ title: "Fix parser recovery", recent }]);
	});

	it("returns undefined instead of throwing when the judge fails", async () => {
		const failing: Judge = {
			label: "failing",
			judge: async () => {
				throw new Error("judgment: no judge model available");
			},
		};

		expect(await classifyTitleDrift(failing, "Fix parser recovery", recent)).toBeUndefined();
	});
});
