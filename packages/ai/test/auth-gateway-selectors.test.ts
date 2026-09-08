import { describe, expect, it } from "bun:test";
import {
	applyDiversity,
	leastBusySelector,
	orderedSelector,
	type RouteCandidate,
	weightedSelector,
} from "@oh-my-pi/pi-ai/auth-gateway/selectors";

function candidate(id: string, extra: Omit<RouteCandidate, "id"> = {}): RouteCandidate {
	return { id, ...extra };
}

describe("auth-gateway selectors", () => {
	describe("orderedSelector", () => {
		it("preserves input order and scores n-i", () => {
			const ranked = orderedSelector.rank([candidate("a"), candidate("b"), candidate("c")], {});
			expect(ranked.map(r => r.id)).toEqual(["a", "b", "c"]);
			expect(ranked.map(r => r.score)).toEqual([3, 2, 1]);
		});

		it("does not apply diversity when ctx.diversity is unset", () => {
			const ranked = orderedSelector.rank(
				[candidate("openai", { provider: "openai" }), candidate("anthropic", { provider: "anthropic" })],
				{},
			);
			expect(ranked.map(r => r.id)).toEqual(["openai", "anthropic"]);
		});

		it("filters then ranks so n is the surviving count", () => {
			const ranked = orderedSelector.rank(
				[candidate("a", { provider: "openai" }), candidate("b", { provider: "anthropic" }), candidate("c")],
				{ diversity: { avoidProvider: "openai" } },
			);
			expect(ranked.map(r => r.id)).toEqual(["b", "c"]);
			expect(ranked.map(r => r.score)).toEqual([2, 1]);
		});
	});

	describe("weightedSelector", () => {
		it("picks weight 3 before weight 1", () => {
			const ranked = weightedSelector.rank([candidate("low", { weight: 1 }), candidate("high", { weight: 3 })], {});
			expect(ranked[0]?.id).toBe("high");
			expect(ranked.map(r => r.id)).toEqual(["high", "low"]);
			expect(ranked.map(r => r.score)).toEqual([3, 1]);
		});

		it("defaults missing weight to 1 and stably keeps equal-score order", () => {
			const ranked = weightedSelector.rank(
				[candidate("first"), candidate("heavy", { weight: 2 }), candidate("second")],
				{},
			);
			expect(ranked.map(r => r.id)).toEqual(["heavy", "first", "second"]);
			expect(ranked.map(r => r.score)).toEqual([2, 1, 1]);
		});
	});

	describe("leastBusySelector", () => {
		it("picks inFlight 0 before inFlight 5", () => {
			const ranked = leastBusySelector.rank(
				[candidate("busy", { inFlight: 5 }), candidate("idle", { inFlight: 0 })],
				{},
			);
			expect(ranked[0]?.id).toBe("idle");
			expect(ranked.map(r => r.id)).toEqual(["idle", "busy"]);
			expect(ranked.map(r => r.score)).toEqual([0, -5]);
		});

		it("treats missing inFlight as 0", () => {
			const ranked = leastBusySelector.rank([candidate("busy", { inFlight: 2 }), candidate("unspecified")], {});
			expect(ranked[0]?.id).toBe("unspecified");
			expect(ranked[0]?.score).toBe(0);
		});
	});

	describe("applyDiversity", () => {
		it("drops the avoided provider and does not leave it in the result (negative)", () => {
			const kept = applyDiversity(
				[
					candidate("drop-me", { provider: "openai" }),
					candidate("keep-me", { provider: "anthropic" }),
					candidate("also-drop", { provider: "openai", model: "gpt-4" }),
				],
				{ avoidProvider: "openai" },
			);
			expect(kept.map(c => c.id)).toEqual(["keep-me"]);
			expect(kept.some(c => c.provider === "openai")).toBe(false);
			expect(kept.map(c => c.id)).not.toContain("drop-me");
		});

		it("drops matching model, family, and credential independently", () => {
			const kept = applyDiversity(
				[
					candidate("model", { model: "gpt-4" }),
					candidate("family", { family: "claude" }),
					candidate("cred", { credentialId: 7 }),
					candidate("ok", { model: "other", family: "other", credentialId: 1 }),
				],
				{ avoidModel: "gpt-4", avoidFamily: "claude", avoidCredential: 7 },
			);
			expect(kept.map(c => c.id)).toEqual(["ok"]);
		});

		it("does not drop a candidate whose avoided fields are unset", () => {
			const kept = applyDiversity([candidate("bare")], { avoidProvider: "openai", avoidCredential: 0 });
			expect(kept.map(c => c.id)).toEqual(["bare"]);
		});
	});

	describe("selector diversity wiring", () => {
		it("weightedSelector drops avoidProvider before ranking (negative: must not remain)", () => {
			const ranked = weightedSelector.rank(
				[
					candidate("openai-heavy", { provider: "openai", weight: 99 }),
					candidate("anthropic-light", { provider: "anthropic", weight: 1 }),
				],
				{ diversity: { avoidProvider: "openai" } },
			);
			expect(ranked.map(r => r.id)).toEqual(["anthropic-light"]);
			expect(ranked.some(r => r.id === "openai-heavy")).toBe(false);
		});

		it("leastBusySelector drops avoidProvider before ranking (negative: must not remain)", () => {
			const ranked = leastBusySelector.rank(
				[
					candidate("openai-idle", { provider: "openai", inFlight: 0 }),
					candidate("anthropic-busy", { provider: "anthropic", inFlight: 4 }),
				],
				{ diversity: { avoidProvider: "openai" } },
			);
			expect(ranked.map(r => r.id)).toEqual(["anthropic-busy"]);
			expect(ranked.some(r => r.id === "openai-idle")).toBe(false);
		});
	});
});
