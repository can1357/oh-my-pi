import { describe, expect, it } from "bun:test";
import type { Judge, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { filterAvailable, isWithinWindow, needsRouting, type TierCandidate } from "../src/routing/availability";
import { routeTurn, verifyAndEscalate } from "../src/routing/route";
import { DEFAULT_ROUTING_POLICY, type TierSpec } from "../src/routing/types";
// ---------------------------------------------------------------------------
// Mock judge — returns canned answers or throws, per spec §10.6 (mock-first).
// ---------------------------------------------------------------------------

function mockJudge(answers: Record<string, unknown>): Judge {
	return {
		label: "mock/jev",
		async judge<Q extends Questions>(_request: { state: unknown; questions: Q }): Promise<JudgmentResult<Q>> {
			return {
				api: "mock",
				provider: "mock",
				model: "mock-jev",
				answers: answers as JudgmentResult<Q>["answers"],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		},
	};
}

function throwingJudge(): Judge {
	return {
		label: "mock/down",
		async judge(): Promise<never> {
			throw new Error("judge unreachable");
		},
	};
}

const TIERS: TierSpec[] = [
	{ id: "cheap", capability: "handles single-file mechanical edits, known patterns" },
	{ id: "mid", capability: "handles multi-file changes with some judgment" },
	{ id: "frontier", capability: "handles architectural, ambiguous, expensive-if-wrong work" },
];

const CONFIDENT_CHEAP = {
	tier: { type: "choice", choice: "cheap", probabilities: { cheap: 0.9 }, confidence: 0.9 },
	complexity: { type: "score", score: 0.2, probabilities: {}, confidence: 0.8 },
};

// ---------------------------------------------------------------------------
// Layer 0 — deterministic availability filter (spec §3)
// ---------------------------------------------------------------------------

describe("filterAvailable", () => {
	const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 20, h, m));

	it("wraps midnight windows correctly", () => {
		// 22:00 -> 08:00 at UTC+7: open at 23:00 local, closed at 12:00 local.
		const win = { startHour: 22, endHour: 8, utcOffsetMinutes: 420 };
		expect(isWithinWindow(win, at(16, 0))).toBe(true); // 23:00 local
		expect(isWithinWindow(win, at(5, 0))).toBe(false); // 12:00 local
		expect(isWithinWindow(win, at(0, 30))).toBe(true); // 07:30 local
	});

	it("excludes tiers by window, context, quota, and rate in order", () => {
		const tiers: TierCandidate[] = [
			{ id: "a", capability: "", availability: { window: { startHour: 9, endHour: 17, utcOffsetMinutes: 0 } } },
			{ id: "b", capability: "", availability: { maxContextTokens: 100 } },
			{ id: "c", capability: "", availability: { quota: { used: 10, limit: 10 } } },
			{ id: "d", capability: "", availability: { rate: { used: 5, limit: 5 } } },
			{ id: "e", capability: "" },
		];
		const r = filterAvailable(tiers, { now: at(20), contextTokens: 200 });
		expect(r.available.map(t => t.id)).toEqual(["e"]);
		expect(r.excluded).toEqual([
			{ id: "a", reason: "outside-window" },
			{ id: "b", reason: "context-too-large" },
			{ id: "c", reason: "quota-exhausted" },
			{ id: "d", reason: "rate-limited" },
		]);
	});

	it("needsRouting short-circuits at 0 or 1 available", () => {
		expect(needsRouting({ available: [], excluded: [] })).toBe(false);
		expect(needsRouting({ available: [TIERS[0] as TierCandidate], excluded: [] })).toBe(false);
		expect(needsRouting({ available: TIERS as TierCandidate[], excluded: [] })).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Routing decision — three gates, fail-expensive (spec §4/§5)
// ---------------------------------------------------------------------------

describe("routeTurn", () => {
	it("routes down when judge is confident and complexity is low", async () => {
		const d = await routeTurn(mockJudge(CONFIDENT_CHEAP), "fix the typo", TIERS);
		expect(d.tier).toBe("cheap");
		expect(d.reason).toBe("jev-confident");
	});

	it("stays at top when judge throws (engine-unavailable)", async () => {
		const d = await routeTurn(throwingJudge(), "anything", TIERS);
		expect(d).toEqual({ tier: "frontier", reason: "engine-unavailable" });
	});

	it("stays at top on low confidence", async () => {
		const d = await routeTurn(
			mockJudge({
				tier: { type: "choice", choice: "cheap", probabilities: {}, confidence: 0.5 },
				complexity: { type: "score", score: 0.2, probabilities: {}, confidence: 0.9 },
			}),
			"x",
			TIERS,
		);
		expect(d.tier).toBe("frontier");
		expect(d.reason).toBe("low-confidence");
	});

	it("stays at top on high complexity", async () => {
		const d = await routeTurn(
			mockJudge({
				tier: { type: "choice", choice: "cheap", probabilities: {}, confidence: 0.95 },
				complexity: { type: "score", score: 1.4, probabilities: {}, confidence: 0.9 }, // raw wire scale 0..2 → normalized 0.7 > 0.5
			}),
			"x",
			TIERS,
		);
		expect(d.tier).toBe("frontier");
		expect(d.reason).toBe("high-complexity");
	});

	it("stays at top when complexity confidence is untrusted", async () => {
		const d = await routeTurn(
			mockJudge({
				tier: { type: "choice", choice: "cheap", probabilities: {}, confidence: 0.95 },
				complexity: { type: "score", score: 0.1, probabilities: {}, confidence: 0.2 },
			}),
			"x",
			TIERS,
		);
		expect(d.tier).toBe("frontier");
		expect(d.reason).toBe("low-confidence");
	});

	it("treats missing complexity as HARD (fail expensive)", async () => {
		const d = await routeTurn(
			mockJudge({
				tier: { type: "choice", choice: "cheap", probabilities: {}, confidence: 0.95 },
			}),
			"x",
			TIERS,
		);
		expect(d.tier).toBe("frontier");
		expect(d.reason).toBe("high-complexity");
	});

	it("degrades unknown tier ids to top", async () => {
		const d = await routeTurn(
			mockJudge({
				tier: { type: "choice", choice: "nonexistent", probabilities: {}, confidence: 0.99 },
				complexity: { type: "score", score: 0.1, probabilities: {}, confidence: 0.9 },
			}),
			"x",
			TIERS,
		);
		expect(d.tier).toBe("frontier");
		expect(d.reason).toBe("jev-confident"); // named a tier, but it resolved to top
	});

	it("honors flat-pool thresholds when configured", async () => {
		const flat = { ...DEFAULT_ROUTING_POLICY, minConfidenceToDegrade: 0.6 };
		const d = await routeTurn(
			mockJudge({
				tier: { type: "choice", choice: "mid", probabilities: {}, confidence: 0.65 },
				complexity: { type: "score", score: 0.3, probabilities: {}, confidence: 0.8 },
			}),
			"x",
			TIERS,
			flat,
		);
		expect(d.tier).toBe("mid");
	});
});

// ---------------------------------------------------------------------------
// Verify-and-escalate (spec §6)
// ---------------------------------------------------------------------------

describe("verifyAndEscalate", () => {
	const downDecision = { tier: "cheap", reason: "jev-confident" as const };

	it("accepts adequate output", async () => {
		const d = await verifyAndEscalate(
			mockJudge({ adequate: { type: "choice", choice: "yes", probabilities: {}, confidence: 0.9 } }),
			"req",
			"out",
			TIERS,
			downDecision,
		);
		expect(d.tier).toBe("cheap");
		expect(d.escalated).toBeUndefined();
	});

	it("escalates one tier on confident inadequacy", async () => {
		const d = await verifyAndEscalate(
			mockJudge({ adequate: { type: "choice", choice: "no", probabilities: {}, confidence: 0.9 } }),
			"req",
			"out",
			TIERS,
			downDecision,
		);
		expect(d.tier).toBe("mid");
		expect(d.reason).toBe("verification-failed");
		expect(d.escalated).toBe(true);
		expect(d.escalationCount).toBe(1);
	});

	it("accepts when the 'no' verdict is unconfident", async () => {
		const d = await verifyAndEscalate(
			mockJudge({ adequate: { type: "choice", choice: "no", probabilities: {}, confidence: 0.3 } }),
			"req",
			"out",
			TIERS,
			downDecision,
		);
		expect(d.tier).toBe("cheap");
	});

	it("accepts when the verifier throws", async () => {
		const d = await verifyAndEscalate(throwingJudge(), "req", "out", TIERS, downDecision);
		expect(d.tier).toBe("cheap");
	});

	it("skips verification at top tier, when capped, and when disabled", async () => {
		const noJudge = mockJudge({ adequate: { type: "choice", choice: "no", probabilities: {}, confidence: 0.99 } });
		expect(
			(await verifyAndEscalate(noJudge, "r", "o", TIERS, { tier: "frontier", reason: "jev-confident" })).tier,
		).toBe("frontier");
		expect(
			(
				await verifyAndEscalate(noJudge, "r", "o", TIERS, {
					tier: "cheap",
					reason: "jev-confident",
					escalationCount: 1,
				})
			).tier,
		).toBe("cheap");
		expect(
			(
				await verifyAndEscalate(noJudge, "r", "o", TIERS, downDecision, {
					...DEFAULT_ROUTING_POLICY,
					allowVerify: false,
				})
			).tier,
		).toBe("cheap");
	});
});

// ---------------------------------------------------------------------------
// Cancellation semantics (spec §1 timeout + abort boundary)
// ---------------------------------------------------------------------------

describe("cancellation", () => {
	function abortAwareJudge(controller: AbortController): Judge {
		return {
			label: "mock/abort-aware",
			async judge(_req, opts) {
				controller.abort();
				throw opts?.signal?.aborted ? new DOMException("aborted", "AbortError") : new Error("boom");
			},
		};
	}

	it("rethrows when the caller's signal aborted (user escape)", async () => {
		const controller = new AbortController();
		await expect(
			routeTurn(abortAwareJudge(controller), "x", TIERS, DEFAULT_ROUTING_POLICY, controller.signal),
		).rejects.toThrow();
	});

	it("maps non-abort failures to engine-unavailable", async () => {
		const controller = new AbortController();
		const d = await routeTurn(throwingJudge(), "x", TIERS, DEFAULT_ROUTING_POLICY, controller.signal);
		expect(d).toEqual({ tier: "frontier", reason: "engine-unavailable" });
	});

	it("internal timeout -> engine-unavailable while caller signal stays live", async () => {
		const controller = new AbortController();
		const slowJudge: Judge = {
			label: "mock/slow",
			async judge(_req, opts) {
				const { promise, reject } = Promise.withResolvers<never>();
				opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				return promise;
			},
		};
		const d = await routeTurn(slowJudge, "x", TIERS, DEFAULT_ROUTING_POLICY, controller.signal, 20);
		expect(d).toEqual({ tier: "frontier", reason: "engine-unavailable" });
		expect(controller.signal.aborted).toBe(false);
	});

	it("verifyAndEscalate rethrows caller abort instead of accepting", async () => {
		const controller = new AbortController();
		await expect(
			verifyAndEscalate(
				abortAwareJudge(controller),
				"r",
				"o",
				TIERS,
				{ tier: "cheap", reason: "jev-confident" },
				DEFAULT_ROUTING_POLICY,
				controller.signal,
			),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// resolveRoutingJudge — native-only gate on the judge role chain (spec §3.1:
// undefined = no router -> top tier; non-native candidates never answer).
// ---------------------------------------------------------------------------

import { resolveRoutingJudge } from "../src/routing/judge";

function routingDeps(models: Array<Record<string, unknown>>) {
	const settings = {
		get: (key: string) => {
			if (key === "retry.fallbackChains" || key === "modelTags") return {};
			if (key === "cycleOrder") return [];
			return undefined;
		},
		getModelRoles: () => ({}),
		getModelRole: () => undefined,
	};
	const registry = {
		getAvailable: () => models,
	};
	return { settings, registry } as never;
}

const NATIVE_MODEL = {
	provider: "typesafe",
	id: "jev-latest",
	api: "typesafe",
	kind: "judge",
	name: "Jev",
	baseUrl: "https://api.typesafe.ai",
} as never;

const CHAT_MODEL = {
	provider: "openai",
	id: "gpt-5",
	api: "openai-responses",
	kind: "chat",
	name: "GPT-5",
} as never;

describe("resolveRoutingJudge", () => {
	it("returns undefined when the judge chain has no candidates", () => {
		expect(resolveRoutingJudge(routingDeps([]))).toBeUndefined();
	});

	it("returns undefined when only chat models are available", () => {
		expect(resolveRoutingJudge(routingDeps([CHAT_MODEL]))).toBeUndefined();
	});

	it("returns a judge when a native decisions model is on the chain", () => {
		const judge = resolveRoutingJudge(routingDeps([NATIVE_MODEL]));
		expect(judge).toBeDefined();
		expect(judge?.label).toBe("routing/native-only");
	});

	it("returns a judge when the session model itself is native", () => {
		const deps = routingDeps([]);
		(deps as { sessionModel?: unknown }).sessionModel = NATIVE_MODEL;
		expect(resolveRoutingJudge(deps)).toBeDefined();
	});
});
