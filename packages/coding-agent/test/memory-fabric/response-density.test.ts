import { describe, expect, it } from "bun:test";

import {
	classifyResponseDensity,
	classifyResponseSet,
	DENSITY_LADDER,
	describeDensity,
	directiveFor,
	GRAMMAR_RULE,
	isGrammarPreserving,
	makeDensityPolicy,
	type ResponseRequest,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/response-density";

const NOW = () => new Date("2026-01-01T00:00:00.000Z");

function request(overrides: Partial<ResponseRequest> = {}): ResponseRequest {
	return { id: "r1", summary: "What port does the dev server use?", ...overrides };
}

describe("density ladder and directives", () => {
	it("orders the ladder least-detail first", () => {
		expect(DENSITY_LADDER).toEqual(["minimal", "compact", "standard", "detailed"]);
	});

	it("every directive preserves grammar by construction", () => {
		for (const level of DENSITY_LADDER) {
			const directive = directiveFor(level);
			expect(directive.preserveGrammar).toBe(true);
			expect(isGrammarPreserving(directive)).toBe(true);
			expect(directive.directives.length).toBeGreaterThan(0);
		}
		expect(GRAMMAR_RULE).toContain("never grammar");
	});

	it("only minimal and compact may omit optional detail", () => {
		expect(directiveFor("minimal").allowOmitOptional).toBe(true);
		expect(directiveFor("compact").allowOmitOptional).toBe(true);
		expect(directiveFor("standard").allowOmitOptional).toBe(false);
		expect(directiveFor("detailed").allowOmitOptional).toBe(false);
	});

	it("safety-critical directives require verbatim reproduction", () => {
		const directive = directiveFor("detailed", { safetyCritical: true });
		expect(directive.verbatimRequired).toBe(true);
		expect(directive.directives.some(d => d.includes("verbatim"))).toBe(true);
	});

	it("honours per-level token-budget overrides", () => {
		expect(directiveFor("minimal").targetTokensHint).toBe(120);
		expect(directiveFor("minimal", { targetTokens: { minimal: 50 } }).targetTokensHint).toBe(50);
	});

	it("describes every level", () => {
		for (const level of DENSITY_LADDER) {
			expect(describeDensity(level).length).toBeGreaterThan(0);
		}
	});
});

describe("classifyResponseDensity", () => {
	it("defaults to observe mode and holds the effective level neutral", () => {
		const result = classifyResponseDensity(request({ complexity: 0.1 }), { now: NOW });
		expect(result.mode).toBe("observe");
		expect(result.proposedLevel).toBe("minimal");
		expect(result.level).toBe("standard");
		expect(result.failedOpen).toBe(false);
		expect(result.assessedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	it("applies the proposed level in active mode", () => {
		const result = classifyResponseDensity(request({ complexity: 0.1 }), { mode: "active", now: NOW });
		expect(result.level).toBe("minimal");
		expect(result.signals.complexitySource).toBe("hint");
	});

	it("maps complexity onto the ladder via thresholds", () => {
		const level = (c: number) =>
			classifyResponseDensity(request({ complexity: c }), { mode: "active", now: NOW }).level;
		expect(level(0.1)).toBe("minimal");
		expect(level(0.3)).toBe("compact");
		expect(level(0.6)).toBe("standard");
		expect(level(0.9)).toBe("detailed");
	});

	it("uses an injected scorer when no hint is present", () => {
		const result = classifyResponseDensity(request(), {
			mode: "active",
			now: NOW,
			scorer: { score: () => 0.9 },
		});
		expect(result.level).toBe("detailed");
		expect(result.signals.complexitySource).toBe("port");
	});

	it("nudges detail up for novices and down for experts", () => {
		const novice = classifyResponseDensity(request({ complexity: 0.3, audience: "novice" }), {
			mode: "active",
			now: NOW,
		});
		const expert = classifyResponseDensity(request({ complexity: 0.3, audience: "expert" }), {
			mode: "active",
			now: NOW,
		});
		expect(novice.level).toBe("standard");
		expect(expert.level).toBe("minimal");
	});

	it("honours an explicit caller preference", () => {
		const result = classifyResponseDensity(request({ complexity: 0.9, preference: "compact" }), {
			mode: "active",
			now: NOW,
		});
		expect(result.level).toBe("compact");
		expect(result.signals.preferenceApplied).toBe(true);
	});

	it("raises detail for required points (coverage floor)", () => {
		const points = ["a", "b", "c", "d", "e"];
		const result = classifyResponseDensity(request({ complexity: 0.1, requiredPoints: points }), {
			mode: "active",
			now: NOW,
		});
		expect(result.level).toBe("detailed");
		expect(result.signals.requiredPointCount).toBe(5);
	});

	it("floors safety-critical replies to detailed even in observe mode", () => {
		const result = classifyResponseDensity(request({ complexity: 0.1, safetyCritical: true }), { now: NOW });
		expect(result.level).toBe("detailed");
		expect(result.directive.verbatimRequired).toBe(true);
		expect(result.signals.safetyFloorApplied).toBe(true);
		expect(result.confidence).toBe(0.95);
	});

	it("fails open to the neutral standard level when the scorer throws", () => {
		const result = classifyResponseDensity(request(), {
			mode: "active",
			now: NOW,
			scorer: {
				score: () => {
					throw new Error("boom");
				},
			},
		});
		expect(result.level).toBe("standard");
		expect(result.failedOpen).toBe(true);
		expect(result.confidence).toBe(0);
	});

	it("clamps out-of-range complexity hints into [0,1]", () => {
		const high = classifyResponseDensity(request({ complexity: 42 }), { mode: "active", now: NOW });
		const low = classifyResponseDensity(request({ complexity: -3 }), { mode: "active", now: NOW });
		expect(high.level).toBe("detailed");
		expect(low.level).toBe("minimal");
	});
});

describe("classifyResponseSet", () => {
	it("summarizes proposed levels across a batch", () => {
		const report = classifyResponseSet(
			[
				request({ id: "a", complexity: 0.1 }),
				request({ id: "b", complexity: 0.3 }),
				request({ id: "c", complexity: 0.9 }),
			],
			{ now: NOW },
		);
		expect(report.summary.total).toBe(3);
		expect(report.summary.minimal).toBe(1);
		expect(report.summary.compact).toBe(1);
		expect(report.summary.detailed).toBe(1);
		expect(report.summary.reduced).toBe(2);
		expect(report.failedOpen).toBe(false);
	});

	it("returns an empty fail-open report for an empty batch", () => {
		const report = classifyResponseSet([], { now: NOW });
		expect(report.summary.total).toBe(0);
		expect(report.failedOpen).toBe(false);
	});
});

describe("makeDensityPolicy", () => {
	it("pre-binds options into a request hook", () => {
		const policy = makeDensityPolicy({ mode: "active", now: NOW });
		const result = policy(request({ complexity: 0.9 }));
		expect(result.level).toBe("detailed");
		expect(result.mode).toBe("active");
	});
});
