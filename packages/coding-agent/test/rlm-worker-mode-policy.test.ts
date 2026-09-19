import { describe, expect, test } from "bun:test";
import {
	classifyGrantComplexity,
	resolveAutoWorkerMode,
	resolveEffectiveWorkerMode,
} from "../src/rlm/worker-mode-policy";

describe("worker-mode-policy", () => {
	test("simple single fact → prose", () => {
		const decision = resolveAutoWorkerMode({
			grantedBytes: 202,
			grantCount: 1,
			patternCount: 1,
			patterns: ["pool_limit"],
			question: "What is pool_limit?",
			grantTextSample: "pool_limit=50",
		});
		expect(decision.mode).toBe("prose");
		expect(decision.complexity).toBe("simple_single_fact");
	});

	test("multi-region causal → evidence-packet (complexity first, not byte threshold)", () => {
		const decision = resolveAutoWorkerMode({
			grantedBytes: 549,
			grantCount: 2,
			patternCount: 2,
			patterns: ["active_connections", "pool_limit"],
			question: "What is the first causal condition before downstream errors?",
			grantTextSample: "active_connections reaches pool_limit\n downstream DB errors",
		});
		expect(decision.mode).toBe("evidence-packet");
		expect(decision.complexity).toBe("multi_region_causal");
	});

	test("contradiction markers → evidence-packet for quality", () => {
		const { complexity } = classifyGrantComplexity({
			grantedBytes: 2073,
			grantCount: 2,
			patternCount: 2,
			patterns: ["max_connections", "pool_limit"],
			question: "What is the effective connection pool limit under load?",
			grantTextSample: "max_connections=100\n pool_limit=50",
		});
		expect(complexity).toBe("contradictory_evidence");
		expect(
			resolveAutoWorkerMode({
				grantedBytes: 2073,
				grantCount: 2,
				patternCount: 2,
				patterns: ["max_connections", "pool_limit"],
				question: "What is the effective connection pool limit under load?",
				grantTextSample: "max_connections=100\n pool_limit=50",
			}).mode,
		).toBe("evidence-packet");
	});

	test("override forces prose under auto", () => {
		const decision = resolveEffectiveWorkerMode(
			"auto",
			{
				grantedBytes: 2100,
				grantCount: 2,
				patternCount: 2,
				patterns: ["active_connections"],
				question: "causal chain?",
			},
			"prose",
		);
		expect(decision.mode).toBe("prose");
		expect(decision.reason).toBe("override:prose");
	});
});
