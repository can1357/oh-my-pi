import { describe, expect, it } from "bun:test";
import { compileIntent, type HardOverrideKind, patchContractFromAnswer } from "../../src/orchestration/intent-compiler";

describe("compileIntent — objective extraction", () => {
	it("extracts an imperative first line as objective with high confidence", () => {
		const result = compileIntent("Implement a rate-limiter for the REST API");
		expect(result.contract.objective).toContain("rate-limiter");
		const assumption = result.assumptions.find(a => a.field === "objective");
		// High confidence → no assumption needed
		expect(assumption).toBeUndefined();
	});

	it("records an assumption when objective confidence is low", () => {
		const result = compileIntent("thing");
		const assumption = result.assumptions.find(a => a.field === "objective");
		// single ambiguous word → assumption or gap
		expect(result.gaps.length > 0 || assumption !== undefined).toBe(true);
	});

	it("uses first two lines for multi-line request", () => {
		const result = compileIntent(
			"Build the auth module\nIt should support OAuth2 and JWT\n- Refresh tokens\n- PKCE flow",
		);
		expect(result.contract.objective).toContain("auth module");
	});
});

describe("compileIntent — deliverables", () => {
	it("extracts bullet-list items as deliverables", () => {
		const result = compileIntent(
			"Implement the following:\n- TypeScript interface\n- unit tests\n- migration script",
		);
		expect(result.contract.deliverables.length).toBeGreaterThan(0);
	});

	it("adds a gap when no deliverables are found", () => {
		const result = compileIntent("Please help");
		const gap = result.gaps.find(g => g.field === "deliverables");
		expect(gap).toBeDefined();
	});

	it("respects explicit deliverables section", () => {
		const result = compileIntent("Fix the bug.\n\nDeliverables: patch file, test case, changelog entry");
		expect(result.contract.deliverables.length).toBeGreaterThan(0);
	});
});

describe("compileIntent — non-solutions", () => {
	it("includes OMPK default non-solutions", () => {
		const result = compileIntent("Build the thing");
		expect(result.contract.nonSolutions.some(n => n.toLowerCase().includes("completion"))).toBe(true);
	});

	it("extracts explicit don't-touch patterns", () => {
		const result = compileIntent("Refactor the parser. Don't touch the lexer module.");
		expect(result.contract.nonSolutions.some(n => n.toLowerCase().includes("lexer"))).toBe(true);
	});

	it("merges caller-supplied non-solutions", () => {
		const result = compileIntent("Build the UI", { nonSolutions: ["No jQuery"] });
		expect(result.contract.nonSolutions.some(n => n.includes("jQuery"))).toBe(true);
	});
});

describe("compileIntent — constraints", () => {
	it("merges caller-supplied constraints", () => {
		const result = compileIntent("Implement the feature", { constraints: ["must run on Node 20"] });
		expect(result.contract.constraints.some(c => c.includes("Node 20"))).toBe(true);
	});

	it("preserves negation in extracted constraints", () => {
		const result = compileIntent("Implement the retention policy; must not delete user data.");
		expect(result.contract.constraints).toContain("not delete user data");
	});

	it("preserves only, never, and without operators", () => {
		const result = compileIntent(
			"Implement the service; only use Bun, never deploy to production, without external APIs.",
		);
		expect(result.contract.constraints).toContain("only use Bun");
		expect(result.contract.constraints).toContain("never deploy to production");
		expect(result.contract.constraints).toContain("without external APIs");
	});
});

describe("compileIntent — assumptions", () => {
	it("records default criteria assumption", () => {
		const result = compileIntent("Implement a search endpoint");
		const a = result.assumptions.find(a => a.field === "completionCriteria");
		expect(a).toBeDefined();
		expect(a?.confidence).toBeLessThan(1);
	});

	it("assumption provenance is not explicit for inferred values", () => {
		const result = compileIntent("Refactor the parser. Don't touch the lexer.");
		const nsAssumption = result.assumptions.find(a => a.field === "nonSolutions");
		if (nsAssumption) {
			expect(nsAssumption.provenance).not.toBe("explicit");
		}
	});

	it("verified is false for all inferred assumptions", () => {
		const result = compileIntent("Build the pipeline");
		for (const a of result.assumptions) {
			expect(a.verified).not.toBe(true);
		}
	});
});

describe("compileIntent — gaps and clarification", () => {
	it("does not require clarification for a clear imperative request", () => {
		const result = compileIntent("Implement rate limiting for the REST API with Redis backend");
		expect(result.requiresClarification).toBe(false);
	});

	it("gap priorityScore is positive for high-impact gaps", () => {
		const result = compileIntent("help");
		for (const g of result.gaps) {
			expect(g.priorityScore).toBeGreaterThan(0);
		}
	});

	it("gaps are sorted by priorityScore descending", () => {
		const result = compileIntent("help");
		const scores = result.gaps.map(g => g.priorityScore);
		for (let i = 1; i < scores.length; i++) {
			expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
		}
	});

	it("topClarificationQuestion is set when requiresClarification is true", () => {
		const result = compileIntent("help");
		if (result.requiresClarification) {
			expect(result.topClarificationQuestion).toBeDefined();
			expect(result.topClarificationQuestion?.questionText).toBeString();
		}
	});
});

describe("compileIntent — contract validity", () => {
	it("always produces a non-empty objective", () => {
		const inputs = ["implement auth", "Build the full system", "Fix the bug in task-contract.ts"];
		for (const input of inputs) {
			const { contract } = compileIntent(input);
			expect(contract.objective.trim().length).toBeGreaterThan(0);
		}
	});

	it("always includes at least one completion criterion", () => {
		const { contract } = compileIntent("implement auth");
		expect(contract.completionCriteria.length).toBeGreaterThan(0);
	});

	it("version is the expected constant", () => {
		const { contract } = compileIntent("build the thing");
		expect(contract.version).toBe("task-contract/v1");
	});

	it("verificationPolicy.requireTargetedChecks is always true", () => {
		const { contract } = compileIntent("implement auth");
		expect(contract.verificationPolicy.requireTargetedChecks).toBe(true);
	});
});

describe("patchContractFromAnswer", () => {
	it("patches objective field", () => {
		const { contract } = compileIntent("unclear request");
		const patched = patchContractFromAnswer(contract, "objective", "Build the auth module");
		expect(patched.objective).toBe("Build the auth module");
	});

	it("appends to deliverables field", () => {
		const { contract } = compileIntent("implement the module\n- deliverable A");
		const patched = patchContractFromAnswer(contract, "deliverables", "README.md");
		expect(patched.deliverables).toContain("README.md");
	});

	it("appends to constraints field", () => {
		const { contract } = compileIntent("implement auth");
		const patched = patchContractFromAnswer(contract, "constraints", "must run on bun 1.x");
		expect(patched.constraints).toContain("must run on bun 1.x");
	});

	it("returns the same contract for unknown field", () => {
		const { contract } = compileIntent("implement auth");
		const patched = patchContractFromAnswer(contract, "unknown_field", "value");
		expect(patched).toBe(contract);
	});
});

describe("compileIntent — canonical ambiguity scoring", () => {
	// S = 0.25·impact + 0.20·uncertainty + 0.20·branching + 0.25·risk + 0.10·(1 − effort)
	const SCORE_WEIGHTS = { impact: 0.25, uncertainty: 0.2, branching: 0.2, risk: 0.25, effort: 0.1 } as const;

	it("priorityScore equals the canonical weighted material-gap score for every gap", () => {
		const result = compileIntent("help");
		expect(result.gaps.length).toBeGreaterThan(0);
		for (const gap of result.gaps) {
			const f = gap.scoreFactors;
			const expected =
				SCORE_WEIGHTS.impact * f.impact +
				SCORE_WEIGHTS.uncertainty * f.uncertainty +
				SCORE_WEIGHTS.branching * f.branching +
				SCORE_WEIGHTS.risk * f.risk +
				SCORE_WEIGHTS.effort * (1 - f.effort);
			expect(gap.priorityScore).toBeCloseTo(expected, 10);
		}
	});

	it("the 0.6 clarification threshold gates unresolved: critical gap retained, minor gap dropped", () => {
		const result = compileIntent("help");
		// Objective gap is critical/blocking → score ≥ 0.6 → retained as unresolved.
		const objectiveGap = result.gaps.find(g => g.id === "gap-objective");
		expect(objectiveGap).toBeDefined();
		expect(objectiveGap!.priorityScore).toBeGreaterThanOrEqual(0.6);
		expect(result.unresolved.some(g => g.id === "gap-objective")).toBe(true);
		// Default-deliverables gap is low/minor → score < 0.6 → filtered out of unresolved.
		const deliverablesGap = result.gaps.find(g => g.id === "gap-deliverables");
		expect(deliverablesGap).toBeDefined();
		expect(deliverablesGap!.priorityScore).toBeLessThan(0.6);
		expect(result.unresolved.some(g => g.id === "gap-deliverables")).toBe(false);
	});
});

describe("compileIntent — deterministic gap ordering", () => {
	it("breaks equal-priority ties by stable ascending gap id", () => {
		// Three distinct hard overrides share identical score factors → identical
		// priorityScore, so the deterministic tie-breaker (ascending id) orders them.
		const result = compileIntent("delete then deploy the secrets");
		const hardGaps = result.gaps.filter(g => g.hardOverride !== undefined);
		expect(hardGaps.length).toBeGreaterThanOrEqual(2);
		// Every hard gap is tied at the same score.
		const scores = hardGaps.map(g => g.priorityScore);
		expect(new Set(scores).size).toBe(1);
		// They must appear in ascending id order (the deterministic tie-break).
		const ids = hardGaps.map(g => g.id);
		expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
	});

	it("all hard-override gaps share the same critical/blocking score profile", () => {
		const result = compileIntent("delete then deploy the secrets");
		const hardGaps = result.gaps.filter(g => g.hardOverride !== undefined);
		for (const gap of hardGaps) {
			expect(gap.scoreFactors.impact).toBe(1);
			expect(gap.scoreFactors.risk).toBe(1);
			expect(gap.scoreFactors.uncertainty).toBe(1);
			expect(gap.scoreFactors.branching).toBe(1);
		}
	});
});

describe("compileIntent — hard override categories", () => {
	const cases: Array<{ kind: HardOverrideKind; trigger: string }> = [
		{ kind: "authorization", trigger: "Implement the gate; record the permission boundary" },
		{ kind: "destructive", trigger: "Implement the cleanup; delete the orphaned rows" },
		{ kind: "external", trigger: "Implement the pipeline; deploy to staging" },
		{ kind: "irreversible_cost", trigger: "Implement the checkout; purchase the quota" },
		{ kind: "security", trigger: "Implement the scan; fix the vulnerability report" },
		{ kind: "privacy", trigger: "Implement the export; redact the pii fields" },
		{ kind: "safety", trigger: "Implement the guard around the hazard zone" },
	];

	for (const { kind, trigger } of cases) {
		it(`surfaces a ${kind} hard override gap`, () => {
			const result = compileIntent(trigger);
			const gap = result.gaps.find(g => g.hardOverride === kind);
			expect(gap).toBeDefined();
			expect(gap!.impact).toBe("critical");
			expect(gap!.risk).toBe("blocking");
			expect(gap!.questionSpec?.kind).toBe("free_text");
			// Hard overrides are always retained as unresolved regardless of score.
			expect(result.unresolved.some(g => g.hardOverride === kind)).toBe(true);
		});
	}

	it("explicit approval suppresses all hard override gaps", () => {
		const result = compileIntent("approved: delete then deploy the secrets");
		expect(result.gaps.some(g => g.hardOverride !== undefined)).toBe(false);
	});

	it("does not turn explicit prohibitions into hard override questions", () => {
		const result = compileIntent("Implement documentation. Never deploy or delete generated files.");
		expect(result.gaps.some(gap => gap.hardOverride !== undefined)).toBe(false);
	});

	it("keeps an affirmative action after a prohibition material", () => {
		const result = compileIntent("Do not deploy staging. Deploy production.");
		expect(result.gaps.some(gap => gap.hardOverride === "external")).toBe(true);
	});
});

describe("compileIntent — single clarification question (one then blocked)", () => {
	it("asks one question drawn from a blocking hard-override gap", () => {
		const result = compileIntent("Implement the release; deploy to production");
		expect(result.requiresClarification).toBe(true);
		expect(result.topClarificationQuestion).toBeDefined();
		const question = result.topClarificationQuestion!;
		expect(question.kind).toBe("free_text");
		// The question targets the override boundary, never the deliverables gap.
		expect(question.field).not.toBe("deliverables");
	});

	it("yields exactly one question even when several hard overrides fire", () => {
		const result = compileIntent("delete then deploy the secrets");
		const hardGaps = result.gaps.filter(g => g.hardOverride !== undefined);
		expect(hardGaps.length).toBeGreaterThanOrEqual(2);
		expect(result.requiresClarification).toBe(true);
		// The seam is a single optional question, never a list.
		expect(Array.isArray(result.topClarificationQuestion)).toBe(false);
		expect(result.topClarificationQuestion).toBeInstanceOf(Object);
	});
});
