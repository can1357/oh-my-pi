import { describe, expect, test } from "bun:test";
import {
	aggregateSpecialistFindings,
	buildSpecialistContext,
	decideDelegation,
	specialistModelBudget,
	strategyFingerprintForDelegation,
	type SpecialistFinding,
} from "./specialist-orchestration";

describe("specialist delegation policy", () => {
	test("simple task skips specialists", () => {
		const decision = decideDelegation({ task: "rename a button", complexity: "SIMPLE", confidence: 0.95, failureCount: 0, availableBudgetTokens: 8000, allowParallel: true, maxConcurrent: 3 });
		expect(decision.action).toBe("SKIP_DELEGATION");
		expect(decision.roles).toEqual([]);
	});

	test("high-confidence task with sufficient evidence avoids delegation", () => {
		const decision = decideDelegation({ task: "add a small endpoint", complexity: "NORMAL", confidence: 0.94, failureCount: 0, hasExistingRelevantEvidence: true, availableBudgetTokens: 8000, allowParallel: true, maxConcurrent: 3 });
		expect(decision.action).toBe("SKIP_DELEGATION");
	});

	test("architecture ambiguity delegates to architect", () => {
		const decision = decideDelegation({ task: "choose a new authentication architecture", complexity: "COMPLEX", confidence: 0.62, architectureAmbiguity: true, failureCount: 0, availableBudgetTokens: 8000, allowParallel: false, maxConcurrent: 1 });
		expect(decision.action).toBe("DELEGATE");
		expect(decision.role).toBe("ARCHITECT");
		expect(decision.readOnly).toBe(true);
	});

	test("repeated debugging failure delegates to debugger", () => {
		const decision = decideDelegation({ task: "fix the auth test", complexity: "COMPLEX", confidence: 0.55, failureCount: 2, availableBudgetTokens: 8000, allowParallel: false, maxConcurrent: 1 });
		expect(decision.role).toBe("DEBUGGER");
	});

	test("security-sensitive task delegates security reviewer", () => {
		const decision = decideDelegation({ task: "change credential validation", complexity: "NORMAL", confidence: 0.65, securitySensitive: true, failureCount: 0, availableBudgetTokens: 8000, allowParallel: false, maxConcurrent: 1 });
		expect(decision.role).toBe("SECURITY_REVIEWER");
	});

	test("large uncertain repository can parallelize independent read-only roles", () => {
		const decision = decideDelegation({ task: "understand the auth boundary", complexity: "VERY_COMPLEX", confidence: 0.55, repositorySize: "large", uncertainty: true, failureCount: 0, availableBudgetTokens: 12000, allowParallel: true, maxConcurrent: 3 });
		expect(decision.action).toBe("PARALLEL_DELEGATE");
		expect(decision.roles).toEqual(["ARCHITECT", "EXPLORER"]);
	});


test("parallel delegation is never suggested when failure evidence makes work dependent", () => {
	const decision = decideDelegation({ task: "understand the auth boundary after failures", complexity: "VERY_COMPLEX", confidence: 0.55, repositorySize: "large", uncertainty: true, failureCount: 2, architectureAmbiguity: true, availableBudgetTokens: 12000, allowParallel: true, maxConcurrent: 3 });
	expect(decision.action).toBe("DELEGATE");
	expect(decision.roles[0]).toBe("SECURITY_REVIEWER");
});

	test("budget pressure skips delegation", () => {
		const decision = decideDelegation({ task: "redesign the data layer", complexity: "COMPLEX", confidence: 0.5, architectureAmbiguity: true, failureCount: 0, availableBudgetTokens: 1500, allowParallel: false, maxConcurrent: 1 });
		expect(decision.action).toBe("SKIP_DELEGATION");
	});

	test("specialist context stays compact and targeted", () => {
		const context = buildSpecialistContext({ task: "fix auth", relevantFiles: ["auth.ts"], activeFiles: ["auth.ts", "auth.test.ts"], activeSymbols: ["validateToken"], failure: { category: "test_failure", check: "auth.test.ts", summary: "expected 401 got 200", attempts: 2 }, hypothesis: "cache invalidation", constraints: ["preserve API"], question: "What is the root cause?" });
		expect(context).toContain("TASK\nfix auth");
		expect(context).toContain("CURRENT FAILURE");
		expect(context).toContain("cache invalidation");
		expect(context.length).toBeLessThanOrEqual(7000);
	});
});

describe("specialist aggregation", () => {
	test("preserves disagreement instead of majority-voting", () => {
		const findings: SpecialistFinding[] = [
			{ role: "DEBUGGER", summary: "cache invalidation is the cause", evidence: ["auth.test.ts:143"], confidence: 0.88 },
			{ role: "ARCHITECT", summary: "database transaction ordering is the cause", evidence: ["session.ts:92"], confidence: 0.81 },
		];
		const result = aggregateSpecialistFindings(findings);
		expect(result.conflicts.length).toBeGreaterThan(0);
		expect(result.unresolvedQuestions.length).toBeGreaterThan(0);
	});

	test("identical evidence forms consensus", () => {
		const result = aggregateSpecialistFindings([
			{ role: "DEBUGGER", summary: "incorrect cache key", evidence: ["a.ts:1"], confidence: 0.8 },
			{ role: "REVIEWER", summary: "incorrect cache key", evidence: ["a.ts:1"], confidence: 0.9 },
		]);
		expect(result.consensus).toHaveLength(1);
		expect(result.conflicts).toHaveLength(0);
	});
});

test("specialist budget is bounded by remaining task budget", () => {
	const budget = specialistModelBudget({ task: "x", complexity: "VERY_COMPLEX", confidence: 0.5, failureCount: 0, availableBudgetTokens: 1000, allowParallel: false, maxConcurrent: 1 }, "ARCHITECT");
	expect(budget).toBeLessThanOrEqual(1000 * 0.2);
});

test("delegation fingerprint is deterministic", () => {
	const decision = decideDelegation({ task: "x", complexity: "COMPLEX", confidence: 0.5, architectureAmbiguity: true, failureCount: 0, availableBudgetTokens: 5000, allowParallel: false, maxConcurrent: 1 });
	expect(strategyFingerprintForDelegation(decision)).toBe(strategyFingerprintForDelegation(decision));
});
