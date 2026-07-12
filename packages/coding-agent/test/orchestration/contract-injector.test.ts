import { describe, expect, it } from "bun:test";
import { buildContractInjectionBlock, buildRecoveryInjection } from "../../src/orchestration/contract-injector";
import type { ContractGap } from "../../src/orchestration/intent-compiler";
import type { TaskContractV1 } from "../../src/orchestration/task-contract";
import { TASK_CONTRACT_VERSION } from "../../src/orchestration/task-contract";

const DIGEST = "a".repeat(64);

function makeContract(overrides?: Partial<TaskContractV1>): TaskContractV1 {
	return Object.freeze({
		version: TASK_CONTRACT_VERSION,
		objective: "Build the auth module with OAuth2",
		deliverables: ["src/auth/index.ts", "test/auth.test.ts"],
		completionCriteria: [
			{ id: "C1", description: "Tests pass" },
			{ id: "C2", description: "No regressions" },
		],
		nonSolutions: ["Narrative-only completion", "Hardcoded secrets"],
		knownFailureModes: [{ id: "F1", description: "scope drift" }],
		evidenceRequirements: [{ id: "E1", description: "test run output" }],
		constraints: ["must use bun runtime"],
		assumptions: [{ id: "A1", statement: "OAuth2 provider is Google", verified: false }],
		verificationPolicy: { requireTargetedChecks: true, allowNarrativeOnly: false },
		orchestrationPolicy: { preferIndependence: true },
		...overrides,
	});
}

describe("buildContractInjectionBlock — executor", () => {
	it("produces a task-contract XML block", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor");
		expect(block.target).toBe("executor");
		expect(block.text).toContain("<task-contract");
		expect(block.text).toContain("</task-contract>");
	});

	it("includes objective", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor");
		expect(block.text).toContain("Build the auth module");
	});

	it("includes deliverables", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor");
		expect(block.text).toContain("src/auth/index.ts");
	});

	it("includes completion criteria with ids", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor");
		expect(block.text).toContain('id="C1"');
		expect(block.text).toContain("Tests pass");
	});

	it("includes non-solutions", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor");
		expect(block.text).toContain("Narrative-only completion");
	});

	it("includes constraints", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor");
		expect(block.text).toContain("bun runtime");
	});

	it("includes assumptions with verified=false attribute", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor");
		expect(block.text).toContain('verified="false"');
		expect(block.text).toContain("Google");
	});

	it("omits empty deliverables section", () => {
		const block = buildContractInjectionBlock(makeContract({ deliverables: [] }), DIGEST, "executor");
		expect(block.text).not.toContain("<deliverables>");
	});

	it("includes digest prefix in version attribute", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor");
		expect(block.text).toContain(DIGEST.slice(0, 16));
	});

	it("escapes XML special characters in objective", () => {
		const block = buildContractInjectionBlock(makeContract({ objective: "Build <foo> & 'bar'" }), DIGEST, "executor");
		expect(block.text).toContain("&lt;foo&gt;");
		expect(block.text).toContain("&amp;");
		expect(block.text).not.toContain("<foo>");
	});
	it("escapes both single and double quotes in objective", () => {
		const block = buildContractInjectionBlock(
			makeContract({ objective: "She said \"hi\" & 'bye'" }),
			DIGEST,
			"executor",
		);
		expect(block.text).toContain("&quot;hi&quot;");
		expect(block.text).toContain("&apos;bye&apos;");
		expect(block.text).not.toContain('"hi"');
		expect(block.text).not.toContain("'bye'");
	});
});

describe("buildContractInjectionBlock — advisor", () => {
	it("produces an active-task-contract XML block", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "advisor");
		expect(block.target).toBe("advisor");
		expect(block.text).toContain("<active-task-contract");
		expect(block.text).toContain("</active-task-contract>");
	});

	it("includes objective and criteria", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "advisor");
		expect(block.text).toContain("Build the auth module");
		expect(block.text).toContain("C1");
	});

	it("surfaces high-impact unverified assumptions", () => {
		const block = buildContractInjectionBlock(
			makeContract(),
			DIGEST,
			"advisor",
			[],
			[
				{
					id: "A1",
					statement: "OAuth2 provider is Google",
					confidence: 0.6,
					provenance: "inferred_keyword",
					impactIfWrong: "critical",
					field: "objective",
					verified: false,
				},
			],
		);
		expect(block.text).toContain("unverified-assumptions");
		expect(block.text).toContain("Google");
	});

	it("surfaces blocking gaps", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "advisor", [
			{
				id: "gap-objective",
				field: "objective",
				description: "Objective is unclear",
				confidence: 0.3,
				impact: "critical",
				risk: "blocking",
				scoreFactors: { impact: 1, uncertainty: 0.7, branching: 0.5, risk: 1, effort: 0.5 },
				priorityScore: 3.5,
			},
		]);
		expect(block.text).toContain("open-gaps");
		expect(block.text).toContain("Objective is unclear");
	});

	it("does NOT surface low-risk gaps", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "advisor", [
			{
				id: "gap-style",
				field: "constraints",
				description: "Minor style preference",
				confidence: 0.8,
				impact: "low",
				risk: "minor",
				scoreFactors: { impact: 0.25, uncertainty: 0.2, branching: 0.1, risk: 0.33, effort: 0.2 },
				priorityScore: 0.1,
			},
		]);
		expect(block.text).not.toContain("Minor style preference");
	});

	it("does NOT surface verified assumptions", () => {
		const block = buildContractInjectionBlock(
			makeContract(),
			DIGEST,
			"advisor",
			[],
			[
				{
					id: "A2",
					statement: "Confirmed by user",
					confidence: 1.0,
					provenance: "explicit",
					impactIfWrong: "high",
					field: "scope",
					verified: true,
				},
			],
		);
		expect(block.text).not.toContain("Confirmed by user");
	});

	it("digest reference is present", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "advisor");
		expect(block.text).toContain(DIGEST.slice(0, 16));
	});
});

describe("buildContractInjectionBlock — executor/advisor digest parity", () => {
	it("executor and advisor blocks carry the same digest prefix", () => {
		const executor = buildContractInjectionBlock(makeContract(), DIGEST, "executor");
		const advisor = buildContractInjectionBlock(makeContract(), DIGEST, "advisor");
		expect(executor.digest).toBe(advisor.digest);
		expect(executor.digest).toBe(DIGEST);
		const prefix = DIGEST.slice(0, 16);
		expect(executor.text).toContain(`digest="${prefix}"`);
		expect(advisor.text).toContain(`digest="${prefix}"`);
	});

	it("blocks differ only in wrapper element, not the shared digest", () => {
		const contract = makeContract();
		const executor = buildContractInjectionBlock(contract, DIGEST, "executor");
		const advisor = buildContractInjectionBlock(contract, DIGEST, "advisor");
		expect(executor.text).toContain("<task-contract");
		expect(advisor.text).toContain("<active-task-contract");
		// Same contract → same digest anchors both views.
		expect(executor.digest).toBe(advisor.digest);
	});
});

describe("buildContractInjectionBlock — unresolvedBlocked flag", () => {
	const blockingGap: ContractGap = {
		id: "gap-hard-external",
		field: "external",
		description: "External target not confirmed",
		confidence: 0,
		impact: "critical",
		risk: "blocking",
		hardOverride: "external",
		scoreFactors: { impact: 1, uncertainty: 1, branching: 1, risk: 1, effort: 0.2 },
		priorityScore: 0.98,
		questionSpec: { field: "external", questionText: "Which environment is authorized?", kind: "free_text" },
	};

	it("executor marks the unresolved section blocked when the flag is set", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor", [blockingGap], [], true);
		expect(block.text).toContain('<unresolved blocked="true">');
	});

	it("executor leaves the unresolved section open by default", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "executor", [blockingGap]);
		expect(block.text).toContain("<unresolved>");
		expect(block.text).not.toContain('blocked="true"');
	});

	it("advisor marks the open-gaps section blocked when the flag is set", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "advisor", [blockingGap], [], true);
		expect(block.text).toContain('<open-gaps blocked="true">');
	});

	it("advisor leaves the open-gaps section open by default", () => {
		const block = buildContractInjectionBlock(makeContract(), DIGEST, "advisor", [blockingGap]);
		expect(block.text).toContain("<open-gaps>");
		expect(block.text).not.toContain('blocked="true"');
	});
});

describe("buildRecoveryInjection", () => {
	it("produces a completion-gate-failure block", () => {
		const text = buildRecoveryInjection(["C1", "C2"], "Verify that tests pass with bun test");
		expect(text).toContain("<completion-gate-failure>");
		expect(text).toContain('id="C1"');
		expect(text).toContain('id="C2"');
		expect(text).toContain("bun test");
	});

	it("handles empty criteria list", () => {
		const text = buildRecoveryInjection([], "No specific criteria missing.");
		expect(text).toContain("<completion-gate-failure>");
		expect(text).toContain("No specific criteria missing.");
	});

	it("escapes XML in recovery instruction", () => {
		const text = buildRecoveryInjection(["C1"], "Run <bun> & check");
		expect(text).toContain("&lt;bun&gt;");
		expect(text).toContain("&amp;");
	});
});
