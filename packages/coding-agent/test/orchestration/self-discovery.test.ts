import { describe, expect, it } from "bun:test";
import { classifyForSelfDiscovery } from "../../src/orchestration/self-discovery";
import type { TaskContractV1 } from "../../src/orchestration/task-contract";
import { TASK_CONTRACT_VERSION } from "../../src/orchestration/task-contract";

function makeContract(overrides?: Partial<TaskContractV1>): TaskContractV1 {
	return Object.freeze({
		version: TASK_CONTRACT_VERSION,
		objective: "Do something",
		deliverables: ["D1"],
		completionCriteria: [{ id: "C1", description: "works" }],
		nonSolutions: [],
		knownFailureModes: [],
		evidenceRequirements: [],
		constraints: [],
		assumptions: [],
		verificationPolicy: { requireTargetedChecks: true, allowNarrativeOnly: false },
		orchestrationPolicy: { preferIndependence: true },
		...overrides,
	});
}

describe("classifyForSelfDiscovery", () => {
	it("routes a trivial single-criterion contract to direct", () => {
		const result = classifyForSelfDiscovery(makeContract());
		expect(result.decision).toBe("direct");
	});

	it("routes a contract with explicit search budget to self_discovery", () => {
		const result = classifyForSelfDiscovery(
			makeContract({
				orchestrationPolicy: {
					preferIndependence: true,
					searchBudget: {
						maxInitialFamilies: 3,
						maxRounds: 3,
						maxSameBlockerRetries: 1,
						minEvidenceGainToContinue: 0.1,
					},
				},
			}),
		);
		expect(result.decision).toBe("self_discovery");
		expect(result.reasons.some(r => r.includes("search budget"))).toBe(true);
	});

	it("routes a contract with >2 criteria to self_discovery", () => {
		const result = classifyForSelfDiscovery(
			makeContract({
				completionCriteria: [
					{ id: "C1", description: "a" },
					{ id: "C2", description: "b" },
					{ id: "C3", description: "c" },
				],
			}),
		);
		expect(result.decision).toBe("self_discovery");
	});

	it("routes a security-keyword objective to self_discovery", () => {
		const result = classifyForSelfDiscovery(
			makeContract({ objective: "Fix the security vulnerability in the authentication system" }),
		);
		expect(result.decision).toBe("self_discovery");
		expect(result.reasons.some(r => r.includes("high-risk keywords"))).toBe(true);
	});

	it("routes a remote deployment contract to self_discovery", () => {
		const result = classifyForSelfDiscovery(
			makeContract({ objective: "Deploy the application to the remote Docker container" }),
		);
		expect(result.decision).toBe("self_discovery");
	});

	it("routes a multi-step contract with maxInitialFamilies>1 to self_discovery", () => {
		const result = classifyForSelfDiscovery(
			makeContract({
				orchestrationPolicy: { preferIndependence: true, maxInitialFamilies: 3 },
			}),
		);
		expect(result.decision).toBe("self_discovery");
	});

	it("routes a research-keyword contract to self_discovery when combined with other signals", () => {
		const result = classifyForSelfDiscovery(
			makeContract({
				objective: "Investigate and analyze the connection failure",
				completionCriteria: [
					{ id: "C1", description: "root cause identified" },
					{ id: "C2", description: "fix verified" },
					{ id: "C3", description: "regression test passes" },
				],
			}),
		);
		expect(result.decision).toBe("self_discovery");
	});

	it("routes an unverified-assumption contract toward self_discovery when other signals present", () => {
		const result = classifyForSelfDiscovery(
			makeContract({
				objective: "Build the authentication system with Docker and credentials",
				assumptions: [{ id: "A1", statement: "Tailscale is available", verified: false }],
			}),
		);
		expect(result.decision).toBe("self_discovery");
	});

	it("returns reasons array with at least one entry", () => {
		const result = classifyForSelfDiscovery(makeContract());
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	it("returns confidence in [0, 1]", () => {
		const simple = classifyForSelfDiscovery(makeContract());
		const complex = classifyForSelfDiscovery(
			makeContract({
				objective: "Design and implement the full remote workspace security architecture with Docker isolation",
				completionCriteria: [
					{ id: "C1", description: "secure" },
					{ id: "C2", description: "isolated" },
					{ id: "C3", description: "tested" },
				],
			}),
		);
		expect(simple.confidence).toBeGreaterThanOrEqual(0);
		expect(simple.confidence).toBeLessThanOrEqual(1);
		expect(complex.confidence).toBeGreaterThan(simple.confidence);
	});

	it("direct decision confidence is lower than self_discovery confidence for complex task", () => {
		const simple = classifyForSelfDiscovery(makeContract());
		const complex = classifyForSelfDiscovery(
			makeContract({
				objective: "Migrate and deploy the full system to remote Docker with security audit",
				orchestrationPolicy: {
					preferIndependence: true,
					searchBudget: {
						maxInitialFamilies: 4,
						maxRounds: 4,
						maxSameBlockerRetries: 1,
						minEvidenceGainToContinue: 0.1,
					},
				},
				completionCriteria: [
					{ id: "C1", description: "migrated" },
					{ id: "C2", description: "deployed" },
					{ id: "C3", description: "secured" },
				],
			}),
		);
		expect(simple.decision).toBe("direct");
		expect(complex.decision).toBe("self_discovery");
		expect(complex.confidence).toBeGreaterThan(simple.confidence);
	});
});
