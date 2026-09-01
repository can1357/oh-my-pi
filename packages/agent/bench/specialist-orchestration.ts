import { classifyTask } from "../src/task-router";
import { decideDelegation, strategyFingerprintForDelegation } from "../src/specialist-orchestration";
import { createInitialOrchestrationState } from "../src/orchestration";

const samples = [
	{ task: "rename the button label", budget: 8000 },
	{ task: "add a new endpoint and tests", budget: 8000 },
	{ task: "redesign authentication architecture across frontend backend database and worker", budget: 12000 },
	{ task: "fix the authentication test after two failed repairs", budget: 6000 },
];

export function runSpecialistPolicyBenchmark(iterations = 10000) {
	const start = performance.now();
	let delegates = 0;
	let parallel = 0;
	let avoided = 0;
	for (let i = 0; i < iterations; i++) {
		const sample = samples[i % samples.length]!;
		const classification = classifyTask(sample.task);
		const orchestration = createInitialOrchestrationState(sample.task, classification);
		const decision = decideDelegation({
			task: sample.task,
			complexity: orchestration.complexity,
			confidence: orchestration.confidence,
			repositorySize: sample.task.includes("architecture") ? "large" : "small",
			uncertainty: orchestration.confidence < 0.72,
			crossSubsystem: sample.task.includes("across frontend backend database"),
			failureCount: sample.task.includes("failed") ? 2 : 0,
			architectureAmbiguity: sample.task.includes("architecture"),
			independentVerification: false,
			externalResearchRequired: false,
			securitySensitive: sample.task.includes("authentication"),
			hasExistingRelevantEvidence: false,
			availableBudgetTokens: sample.budget,
			allowParallel: true,
			maxConcurrent: 2,
		});
		void strategyFingerprintForDelegation(decision);
		if (decision.action === "SKIP_DELEGATION") avoided++;
		if (decision.action === "DELEGATE") delegates++;
		if (decision.action === "PARALLEL_DELEGATE") parallel++;
	}
	const elapsedMs = performance.now() - start;
	return { iterations, delegates, parallel, avoided, elapsedMs, avgDecisionUs: (elapsedMs * 1000) / iterations };
}

if (import.meta.main) console.log(JSON.stringify(runSpecialistPolicyBenchmark(), null, 2));
