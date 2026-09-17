#!/usr/bin/env bun
/**
 * computer.decide() battery — offline rules/rerank + optional live Jev + GTK e2e.
 *
 * Usage:
 *   bun evals/jev-showcase/computer-decide/orchestrate.ts
 *   JEV_ARMS=rules-rerank,jev TYPESAFE_API_KEY=... bun evals/jev-showcase/computer-decide/orchestrate.ts
 *   PI_COMPUTER_E2E=1 JEV_ARMS=e2e bun evals/jev-showcase/computer-decide/orchestrate.ts
 */
import * as path from "node:path";
import { TypeSafeJudge } from "@oh-my-pi/pi-ai";
import {
	applyDeterministicRules,
	applySemanticRerank,
	candidatesFromElements,
	decideComputerStep,
} from "../../../src/computer/decide";
import { appendJsonl, loadCompletedKeys } from "../../../src/jev-showcase/jsonl";
import {
	gradeComputerDecideTask,
	type ComputerDecideTask,
} from "../../../src/jev-showcase/grade-computer-decide";
import { runEvalComputerDecide } from "../../../src/computer/decide-bridge";
import { Settings } from "../../../src/config/settings";
import type { ToolSession } from "../../../src/tools";
import { GuiE2eHarness, SHOULD_RUN_COMPUTER_E2E } from "../../../test/helpers/hyprland-headless-harness";
import tasks from "./tasks.json";

const ROOT = import.meta.dir;
const resultsPath = process.env.JEV_SHOWCASE_RESULTS ?? path.join(ROOT, "results", "results.jsonl");

function toolSession(jev: "off" | "on" | "auto"): ToolSession {
	const settings = Settings.isolated({ "computer.jev": jev });
	return {
		settings,
		modelRegistry: { authStorage: { hasAuth: () => jev !== "off" } },
		getSessionId: () => "jev-showcase-computer-decide",
	} as unknown as ToolSession;
}

async function runOffline(task: ComputerDecideTask, arm: string) {
	const minConfidence = task.expected.minConfidence;
	let decision = null;
	if (arm === "jev") {
		const apiKey = process.env.TYPESAFE_API_KEY?.trim();
		if (!apiKey) throw new Error("TYPESAFE_API_KEY required for jev arm");
		decision = await decideComputerStep({
			state: { goal: task.goal, candidates: task.candidates },
			judge: new TypeSafeJudge({ apiKey }),
			useJev: true,
			minConfidence,
		});
	} else {
		decision =
			applyDeterministicRules({ goal: task.goal, candidates: task.candidates }, minConfidence) ??
			applySemanticRerank({ goal: task.goal, candidates: task.candidates }, minConfidence);
	}
	return decision;
}

async function runE2e(task: ComputerDecideTask) {
	if (!SHOULD_RUN_COMPUTER_E2E) throw new Error("PI_COMPUTER_E2E=1 required for e2e arm");
	const harness = new GuiE2eHarness();
	harness.start();
	try {
		harness.launchGtkFixture(task.gtkLabels ?? "Save,Cancel");
		await harness.waitForGtkWindow();
		harness.assertIsolationHeld();
		const buttons = await harness.queryButtons();
		const candidates = candidatesFromElements(
			buttons.map(b => ({ ref: b.ref, role: b.role, title: b.title })),
		);
		const jev = process.env.TYPESAFE_API_KEY ? "auto" : "off";
		const result = await runEvalComputerDecide(
			{ state: { goal: task.goal, candidates }, minConfidence: task.expected.minConfidence },
			{ session: toolSession(jev) },
		);
		return result.data;
	} finally {
		harness.stop();
	}
}

async function main(): Promise<void> {
	const done = loadCompletedKeys(resultsPath, r => `${r.task}:${r.arm}`);
	const arms = (process.env.JEV_ARMS ?? "rules-rerank").split(",");

	for (const task of tasks as ComputerDecideTask[]) {
		for (const arm of arms) {
			const key = `${task.id}:${arm}`;
			if (done.has(key)) continue;
			if (arm === "e2e" && !task.gtkLabels) continue;
			if (arm !== "e2e" && task.gtkLabels && task.candidates.length === 0) continue;
			const started = performance.now();
			try {
				const packet = arm === "e2e" ? await runE2e(task) : await runOffline(task, arm);
				const ok = gradeComputerDecideTask(task, packet);
				const row = {
					task: task.id,
					arm,
					ok,
					latencyMs: Math.round(performance.now() - started),
					backend: packet?.backend,
					action: packet?.action,
					target: packet?.target,
				};
				appendJsonl(resultsPath, row);
				console.log(`RESULT_JSON:${JSON.stringify(row)}`);
			} catch (error) {
				const row = {
					task: task.id,
					arm,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Math.round(performance.now() - started),
				};
				appendJsonl(resultsPath, row);
				console.log(`RESULT_JSON:${JSON.stringify(row)}`);
			}
		}
	}
}

await main();
