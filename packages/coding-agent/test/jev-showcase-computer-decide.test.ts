/**
 * Task battery from awlevin/typesafe-computer-use tests/test_decide.py
 * plus omp computer.decide() ladder scenarios.
 */
import { describe, expect, it } from "bun:test";
import {
	applyDeterministicRules,
	applySemanticRerank,
	decideComputerStep,
	type ComputerDecision,
} from "../src/computer/decide";
import { gradeComputerDecideTask, type ComputerDecideTask } from "../src/jev-showcase/grade-computer-decide";
import computerTasks from "../evals/jev-showcase/computer-decide/tasks.json";

function answer(
	choice: string,
	confidence: number,
	probabilities?: Record<string, number>,
): {
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
} {
	return { choice, confidence, probabilities: probabilities ?? { [choice]: confidence } };
}

/** Minimal Decision parser mirroring typesafe-computer-use decide.Decision for click_item. */
function parseTypesafeComputerDecision(input: {
	kind: ReturnType<typeof answer>;
	item: ReturnType<typeof answer> | null;
	site: ReturnType<typeof answer>;
	offscreen?: ReturnType<typeof answer>;
}): { clicking: boolean; pressingOffscreen: boolean; chosen: string; confidence: number; stops: boolean } {
	const kind = input.kind.choice;
	const stops = kind === "done" || kind === "none";
	if (kind === "press_offscreen" && input.offscreen) {
		return {
			pressingOffscreen: true,
			clicking: false,
			chosen: `offscreen:${input.offscreen.choice}`,
			confidence: Math.min(input.kind.confidence, input.offscreen.confidence),
			stops,
		};
	}
	if (kind === "click_item") {
		return {
			clicking: true,
			pressingOffscreen: false,
			chosen: input.item?.choice ?? "",
			confidence: Math.min(input.kind.confidence, input.item?.confidence ?? 0),
			stops,
		};
	}
	return {
		clicking: false,
		pressingOffscreen: false,
		chosen: kind,
		confidence: input.kind.confidence,
		stops,
	};
}

describe("jev showcase computer decide (typesafe-computer-use parity)", () => {
	it("click_item uses item confidence as the gate", () => {
		const d = parseTypesafeComputerDecision({
			kind: answer("click_item", 0.9),
			item: answer("12", 0.6),
			site: answer("none", 1),
		});
		expect(d.clicking).toBe(true);
		expect(d.chosen).toBe("12");
		expect(d.confidence).toBe(0.6);
		expect(d.stops).toBe(false);
	});

	it("fixed actions ignore the item head", () => {
		const d = parseTypesafeComputerDecision({
			kind: answer("open_site", 0.8),
			item: answer("3", 0.1),
			site: answer("github", 0.9),
		});
		expect(d.clicking).toBe(false);
		expect(d.chosen).toBe("open_site");
		expect(d.confidence).toBe(0.8);
	});

	it("stops on done or none", () => {
		expect(
			parseTypesafeComputerDecision({ kind: answer("done", 0.9), item: null, site: answer("none", 1) }).stops,
		).toBe(true);
		expect(
			parseTypesafeComputerDecision({ kind: answer("none", 0.9), item: null, site: answer("none", 1) }).stops,
		).toBe(true);
	});

	it("press_offscreen uses the offscreen answer and min confidence", () => {
		const d = parseTypesafeComputerDecision({
			kind: answer("press_offscreen", 0.9),
			item: answer("3", 0.9),
			site: answer("none", 1),
			offscreen: answer("7", 0.5),
		});
		expect(d.pressingOffscreen).toBe(true);
		expect(d.chosen).toBe("offscreen:7");
		expect(d.confidence).toBe(0.5);
	});

	it("ignores offscreen answer for click_item", () => {
		const d = parseTypesafeComputerDecision({
			kind: answer("click_item", 0.9),
			item: answer("3", 0.8),
			site: answer("none", 1),
			offscreen: answer("7", 0.1),
		});
		expect(d.pressingOffscreen).toBe(false);
		expect(d.chosen).toBe("3");
	});
});

describe("jev showcase computer decide task battery", () => {
	const tasks = computerTasks as ComputerDecideTask[];

	for (const task of tasks.filter(t => !t.gtkLabels)) {
		it(`offline: ${task.id}`, async () => {
			let decision: ComputerDecision | null = null;
			const minConfidence = task.expected.minConfidence;
			if (task.expected.backend?.includes("jev")) {
				const judge = {
					label: "fake/jev",
					async judge() {
						return {
							api: "typesafe",
							provider: "typesafe",
							model: "jev-test",
							answers: {
								action: {
									type: "choice",
									choice: task.expected.action ?? "click",
									probabilities: { click: 0.9 },
								},
								target: {
									type: "choice",
									choice: task.expected.target ?? task.candidates[0]?.id ?? "none",
									probabilities: {},
								},
								needsVision: { type: "noul", noul: 0 },
								needsGeneration: { type: "noul", noul: 0 },
								done: { type: "noul", noul: 0 },
							},
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						};
					},
				} as unknown as import("@oh-my-pi/pi-ai").Judge;
				decision = await decideComputerStep({
					state: { goal: task.goal, candidates: task.candidates },
					judge,
					useJev: true,
					minConfidence,
				});
			} else {
				decision =
					applyDeterministicRules({ goal: task.goal, candidates: task.candidates }, minConfidence) ??
					applySemanticRerank({ goal: task.goal, candidates: task.candidates }, minConfidence);
			}
			expect(gradeComputerDecideTask(task, decision)).toBe(true);
		});
	}
});
