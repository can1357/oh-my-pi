import { classifyTask } from "../src/task-router";
import { applyDecision, decideNextAction, orchestrationStateFrom } from "../src/orchestration";

export function runOrchestrationBenchmark(iterations = 10000) {
	const tasks = [
		"change the button label",
		"add a new API endpoint and tests",
		"redesign authentication architecture across frontend backend database and worker",
		"fix the failing authentication test",
	];
	const start = performance.now();
	let decisions = 0;
	for (let i = 0; i < iterations; i++) {
		const task = tasks[i % tasks.length];
		const state = orchestrationStateFrom(task, classifyTask(task));
		for (let step = 0; step < 6; step++) {
			const decision = decideNextAction(state);
			decisions += 1;
			applyDecision(state, decision, start + i + step);
			if (decision.action === "COMPLETE" || decision.action === "BLOCK") break;
			if (step === 1 && decision.action === "IMPLEMENT") {
				state.changedFiles = ["src/example.ts"];
				state.verification.workspaceChanged = true;
			}
			if (decision.action === "VERIFY") state.verification.state = "VERIFIED";
		}
	}
	const elapsedMs = performance.now() - start;
	return { iterations, decisions, elapsedMs, avgDecisionUs: (elapsedMs * 1000) / Math.max(1, decisions) };
}

if (import.meta.main) console.log(JSON.stringify(runOrchestrationBenchmark(), null, 2));
