import { describe, expect, it } from "bun:test";
import type { Judge } from "@oh-my-pi/pi-ai";
import {
	applyDeterministicRules,
	applySemanticRerank,
	buildFactorizedQuestions,
	candidatesFromElements,
	decideComputerStep,
} from "../src/computer/decide";
import { shouldUseComputerJev } from "../src/computer/policy";

describe("computer decide", () => {
	it("maps AX elements to candidates", () => {
		expect(candidatesFromElements([{ ref: "e1", title: "Save", role: "button" }])).toEqual([
			{ id: "e1", label: "Save", role: "button", source: "ax" },
		]);
	});

	it("rules click a lone matching control", () => {
		const decision = applyDeterministicRules({
			goal: "click Save",
			candidates: [{ id: "e1", label: "Save" }],
		});
		expect(decision?.action).toBe("click");
		expect(decision?.target).toBe("e1");
		expect(decision?.backend).toBe("rules");
	});

	it("reranks by label overlap", () => {
		const decision = applySemanticRerank({
			goal: "click Save changes",
			candidates: [
				{ id: "e1", label: "Cancel" },
				{ id: "e2", label: "Save changes" },
			],
		});
		expect(decision?.action).toBe("click");
		expect(decision?.target).toBe("e2");
		expect(decision?.backend).toBe("rerank");
	});

	it("builds factorized Jev questions", () => {
		const questions = buildFactorizedQuestions([{ id: "e1", label: "Save", role: "button" }]);
		expect(questions.action.type).toBe("choice");
		expect(questions.target.type).toBe("choice");
		expect(questions.needsVision.type).toBe("noul");
		expect(Object.keys(questions.target.criteria as Record<string, string | null>)).toContain("e1");
	});

	it("fail-opens when Jev is disabled and rules/rerank miss", async () => {
		const packet = await decideComputerStep({
			state: {
				goal: "do the ambiguous thing",
				candidates: [
					{ id: "a", label: "Alpha" },
					{ id: "b", label: "Beta" },
				],
			},
			useJev: false,
		});
		expect(packet).toBeNull();
	});

	it("uses Jev when armed", async () => {
		const judge = {
			label: "mock",
			async judge() {
				return {
					api: "typesafe",
					provider: "typesafe",
					model: "jev-latest",
					answers: {
						action: {
							type: "choice",
							choice: "click",
							probabilities: { click: 0.9 },
							confidence: 0.9,
						},
						target: { type: "choice", choice: "e2", probabilities: { e2: 0.8 }, confidence: 0.8 },
						needsVision: { type: "noul", noul: 0.1 },
						needsGeneration: { type: "noul", noul: 0.1 },
						done: { type: "noul", noul: 0.1 },
					},
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			},
		} as unknown as Judge;
		const packet = await decideComputerStep({
			state: {
				goal: "ambiguous",
				candidates: [
					{ id: "e1", label: "Alpha" },
					{ id: "e2", label: "Beta" },
				],
			},
			judge,
			useJev: true,
		});
		expect(packet?.backend).toBe("jev");
		expect(packet?.action).toBe("click");
		expect(packet?.target).toBe("e2");
	});
});

describe("computer jev policy", () => {
	it("respects computer.jev off", () => {
		expect(
			shouldUseComputerJev(
				{ get: path => (path === "computer.jev" ? "off" : "auto") },
				{ authStorage: { hasAuth: () => true } },
			),
		).toBe(false);
	});

	it("auto follows typesafe auth", () => {
		expect(
			shouldUseComputerJev(
				{ get: path => (path === "computer.jev" ? "auto" : "auto") },
				{ authStorage: { hasAuth: () => false } },
			),
		).toBe(false);
		expect(
			shouldUseComputerJev(
				{ get: path => (path === "computer.jev" ? "auto" : "auto") },
				{ authStorage: { hasAuth: p => p === "typesafe" } },
			),
		).toBe(true);
	});
});
