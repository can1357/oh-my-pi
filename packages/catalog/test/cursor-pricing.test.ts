import { describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
import { calculateCost } from "../src/models";
import type { ModelSpec, Usage } from "../src/types";

/** Zero-cost discovery spec, mirroring GetUsableModels (no pricing upstream). */
function spec(id: string): ModelSpec<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

describe("cursor API-equivalent pricing", () => {
	it("prices Cursor first-party models from the Cursor rate card", () => {
		expect(buildModel(spec("cursor-grok-4.6")).cost).toMatchObject({
			input: 2,
			output: 6,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
		expect(buildModel(spec("cursor-grok-4.6-fast")).cost).toMatchObject({
			input: 4,
			output: 12,
			cacheRead: 1,
			cacheWrite: 0,
		});
		// Grok 4.5 Fast output is 3x base per the Cursor docs, unlike 4.6 Fast.
		expect(buildModel(spec("cursor-grok-4.5-fast")).cost).toMatchObject({
			input: 4,
			output: 18,
			cacheRead: 1,
			cacheWrite: 0,
		});
		expect(buildModel(spec("composer-2.5")).cost).toMatchObject({
			input: 0.5,
			output: 2.5,
			cacheRead: 0.2,
			cacheWrite: 0,
		});
		expect(buildModel(spec("composer-2.5-fast")).cost).toMatchObject({
			input: 3,
			output: 15,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
	});

	it("prices Grok 4.7 wire ids with the 256K long-context tiers", () => {
		const base = buildModel(spec("grok-4.7-medium"));
		expect(base.cost).toMatchObject({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });
		expect(base.cost.longContext).toEqual({
			inputThreshold: 256_000,
			input: 4,
			output: 12,
			cacheRead: 1,
			cacheWrite: 0,
		});
		const fast = buildModel(spec("grok-4.7-xhigh-fast"));
		expect(fast.cost).toMatchObject({ input: 4, output: 12, cacheRead: 1, cacheWrite: 0 });
		// Fast long context bills at 3x standard rates (1.5x the fast base card).
		expect(fast.cost.longContext).toEqual({
			inputThreshold: 256_000,
			input: 6,
			output: 18,
			cacheRead: 1.5,
			cacheWrite: 0,
		});
	});

	it("keeps the explicit 500K Grok 4.7 lanes uncapped by their long-context tier", () => {
		for (const id of ["grok-4.7-500k", "grok-4.7-500k-fast"]) {
			const lane = buildModel({ ...spec(id), contextWindow: 500_000 });
			expect(lane.contextWindow, id).toBe(500_000);
			expect(lane.longContextWindowUncapped, id).toBe(true);
		}
		// The base lane's wire context is pinned to 256k; it must keep the cap.
		expect(buildModel({ ...spec("grok-4.7"), contextWindow: 256_000 }).longContextWindowUncapped).toBeUndefined();
	});

	it("bills the explicit 500K Grok 4.7 SKUs at their published base cards", () => {
		const cards = [
			["grok-4.7-500k", 4, 12, 1],
			["grok-4.7-500k-fast", 6, 18, 1.5],
		] as const;
		for (const [id, input, output, cacheRead] of cards) {
			const model = buildModel({ ...spec(id), contextWindow: 500_000 });
			expect(model.cost, id).toMatchObject({ input, output, cacheRead, cacheWrite: 0 });
			// The 500K SKU's published rate is its base card, not only its
			// long-context tier: requests below 256K must not fall back to the
			// cheaper 256K-lane rates.
			for (const prompt of [100_000, 300_000]) {
				const usage: Usage = {
					input: prompt - 3_000,
					output: 7,
					cacheRead: 2_000,
					cacheWrite: 1_000,
					totalTokens: prompt + 7,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				calculateCost(model, usage);
				expect(usage.cost.input, `${id} input @${prompt}`).toBeCloseTo((usage.input * input) / 1e6, 10);
				expect(usage.cost.output, `${id} output @${prompt}`).toBeCloseTo((usage.output * output) / 1e6, 10);
				expect(usage.cost.cacheRead, `${id} cacheRead @${prompt}`).toBeCloseTo(
					(usage.cacheRead * cacheRead) / 1e6,
					10,
				);
			}
		}
	});

	it("prices the newly served Cursor models from the docs", () => {
		const cards: Array<[string, { input: number; output: number; cacheRead: number; cacheWrite: number }]> = [
			["claude-fable-5-2", { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }],
			["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
			["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
			["gemini-2.5-flash", { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 }],
			["gemini-4-hydrogen", { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 }],
			["gemini-4-neon", { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 }],
			["glm-5p3", { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }],
			["glm-5p3-flash", { input: 0.15, output: 0.5, cacheRead: 0.029, cacheWrite: 0 }],
			["gpt-5.1", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }],
			["muse-wonder-1.0", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 }],
		];
		for (const [id, cost] of cards) {
			expect(buildModel(spec(id)).cost, id).toMatchObject(cost);
		}
	});

	it("prices third-party models at their Cursor API rates", () => {
		expect(buildModel(spec("claude-opus-4-7-high-fast")).cost).toMatchObject({
			input: 30,
			output: 150,
			cacheRead: 3,
			cacheWrite: 37.5,
		});
		expect(buildModel(spec("claude-opus-4-8-high-fast")).cost).toMatchObject({
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheWrite: 12.5,
		});
		// Fable 5.1 cache reads are discounted 75% below the standard rate.
		expect(buildModel(spec("claude-fable-5-1-max")).cost).toMatchObject({
			input: 10,
			output: 50,
			cacheRead: 0.25,
			cacheWrite: 12.5,
		});
		expect(buildModel(spec("gpt-5.4-fast")).cost).toMatchObject({
			input: 5,
			output: 30,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
		expect(buildModel(spec("kimi-k3-high")).cost).toMatchObject({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 0,
		});
		expect(buildModel(spec("muse-spark-1.3")).cost).toMatchObject({
			input: 1.25,
			output: 4.25,
			cacheRead: 0.15,
			cacheWrite: 0,
		});
		// Opus 5.5 runs 20% below Opus 5 with a discounted cache-read rate;
		// its fast lane bills at base since no fast multiplier is published.
		expect(buildModel(spec("claude-opus-5-5")).cost).toMatchObject({
			input: 4,
			output: 20,
			cacheRead: 0.2,
			cacheWrite: 5,
		});
		expect(buildModel(spec("claude-opus-5-5-fast")).cost).toMatchObject({
			input: 4,
			output: 20,
			cacheRead: 0.2,
			cacheWrite: 5,
		});
		// DeepSeek V4.1 Flash 1017 bills one card for its bare id and every
		// reasoning-effort wire id.
		for (const id of [
			"deepseek-v41-flash-1017",
			"deepseek-v41-flash-1017-none",
			"deepseek-v41-flash-1017-low",
			"deepseek-v41-flash-1017-medium",
			"deepseek-v41-flash-1017-high",
			"deepseek-v41-flash-1017-max",
		]) {
			expect(buildModel(spec(id)).cost, id).toMatchObject({
				input: 0.3,
				output: 1.2,
				cacheRead: 0.006,
				cacheWrite: 0,
			});
		}
	});

	it("models the GPT-5.6 272K 2x-input long tier", () => {
		const sol = buildModel(spec("gpt-5.6-sol"));
		expect(sol.cost).toMatchObject({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
		expect(sol.cost.longContext).toEqual({
			inputThreshold: 272_000,
			input: 8,
			output: 20,
			cacheRead: 0.8,
			cacheWrite: 10,
		});
	});

	it("models the Claude Haiku 5.5 100K 5x long tier on both lanes", () => {
		for (const id of ["claude-haiku-5-5", "claude-haiku-5-5-1m"]) {
			const haiku = buildModel(spec(id));
			expect(haiku.cost).toMatchObject({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
			expect(haiku.cost.longContext).toEqual({
				inputThreshold: 100_000,
				input: 0.5,
				output: 2.5,
				cacheRead: 0.05,
				cacheWrite: 0.625,
			});
		}
	});

	it("prices every served catalog id; only docs-absent ids stay zero", () => {
		// Snapshot of the Cursor roster on 2026-09-22, plus DeepSeek V4.1
		// Flash 1017 (served from 2026-10-27). A newly served id without a
		// cost-patch rule fails here instead of silently billing at zero.
		const servedIds = [
			"claude-4-sonnet",
			"claude-4.5-opus-high",
			"claude-4.5-sonnet",
			"claude-4.6-opus-high",
			"claude-4.6-opus-max",
			"claude-4.6-sonnet-medium",
			"claude-fable-5-1-high",
			"claude-fable-5-1-low",
			"claude-fable-5-1-max",
			"claude-fable-5-1-medium",
			"claude-fable-5-1-xhigh",
			"claude-fable-5-2",
			"claude-fable-5-2-1m",
			"claude-fable-5-2-1m-fast",
			"claude-fable-5-2-fast",
			"claude-fable-5-high",
			"claude-fable-5-low",
			"claude-fable-5-max",
			"claude-fable-5-medium",
			"claude-fable-5-xhigh",
			"claude-haiku-4-5",
			"claude-opus-4-7-high",
			"claude-opus-4-7-high-fast",
			"claude-opus-4-7-low",
			"claude-opus-4-7-low-fast",
			"claude-opus-4-7-max",
			"claude-opus-4-7-max-fast",
			"claude-opus-4-7-medium",
			"claude-opus-4-7-medium-fast",
			"claude-opus-4-7-xhigh",
			"claude-opus-4-7-xhigh-fast",
			"claude-opus-4-8-high",
			"claude-opus-4-8-high-fast",
			"claude-opus-4-8-low",
			"claude-opus-4-8-low-fast",
			"claude-opus-4-8-max",
			"claude-opus-4-8-max-fast",
			"claude-opus-4-8-medium",
			"claude-opus-4-8-medium-fast",
			"claude-opus-4-8-xhigh",
			"claude-opus-4-8-xhigh-fast",
			"claude-opus-5-5",
			"claude-opus-5-5-fast",
			"claude-opus-5-high",
			"claude-opus-5-high-fast",
			"claude-opus-5-low",
			"claude-opus-5-low-fast",
			"claude-opus-5-medium",
			"claude-opus-5-medium-fast",
			"claude-opus-5-thinking-max",
			"claude-opus-5-thinking-max-fast",
			"claude-opus-5-thinking-xhigh",
			"claude-opus-5-thinking-xhigh-fast",
			"claude-sonnet-5-high",
			"claude-sonnet-5-low",
			"claude-sonnet-5-max",
			"claude-sonnet-5-medium",
			"claude-sonnet-5-xhigh",
			"claude-sonnet-5-5",
			"claude-sonnet-5-5-1m",
			"composer-1",
			"composer-1.5",
			"composer-2.5",
			"composer-2.5-fast",
			"cursor-grok-4.5",
			"cursor-grok-4.5-fast",
			"cursor-grok-4.6",
			"cursor-grok-4.6-fast",
			"deepseek-v41-flash-1017-high",
			"deepseek-v41-flash-1017-low",
			"deepseek-v41-flash-1017-max",
			"deepseek-v41-flash-1017-medium",
			"deepseek-v41-flash-1017-none",
			"default",
			"gemini-3-flash",
			"gemini-3-pro",
			"gemini-3.1-pro",
			"gemini-3.5-flash",
			"gemini-3.6-flash",
			"gemini-3.7-flash",
			"gemini-3.8-flash",
			"gemini-2.5-flash",
			"gemini-4-argon",
			"gemini-4-carbon",
			"gemini-4-hydrogen",
			"gemini-4-hydrogen-1m",
			"gemini-4-neon",
			"gemini-4-neon-1m",
			"glm-5.2",
			"glm-5p3",
			"glm-5p3-flash",
			"gpt-5-mini",
			"gpt-5.1",
			"gpt-5.1-codex-max",
			"gpt-5.1-codex-max-high",
			"gpt-5.1-codex-mini",
			"gpt-5.1-high",
			"gpt-5.1-low",
			"gpt-5.2",
			"gpt-5.2-codex",
			"gpt-5.2-codex-fast",
			"gpt-5.2-codex-high",
			"gpt-5.2-codex-high-fast",
			"gpt-5.2-codex-low",
			"gpt-5.2-codex-low-fast",
			"gpt-5.2-codex-xhigh",
			"gpt-5.2-codex-xhigh-fast",
			"gpt-5.2-fast",
			"gpt-5.2-high",
			"gpt-5.2-high-fast",
			"gpt-5.2-low",
			"gpt-5.2-low-fast",
			"gpt-5.2-xhigh",
			"gpt-5.2-xhigh-fast",
			"gpt-5.3-codex",
			"gpt-5.3-codex-fast",
			"gpt-5.3-codex-high",
			"gpt-5.3-codex-high-fast",
			"gpt-5.3-codex-low",
			"gpt-5.3-codex-low-fast",
			"gpt-5.3-codex-spark-preview",
			"gpt-5.3-codex-xhigh",
			"gpt-5.3-codex-xhigh-fast",
			"gpt-5.4",
			"gpt-5.4-fast",
			"gpt-5.4-mini",
			"gpt-5.4-nano",
			"gpt-5.5",
			"gpt-5.5-fast",
			"gpt-5.6-luna",
			"gpt-5.6-luna-fast",
			"gpt-5.6-sol",
			"gpt-5.6-sol-fast",
			"gpt-5.6-terra",
			"gpt-5.6-terra-fast",
			"grok-4.7-high",
			"grok-4.7-high-fast",
			"grok-4.7-low",
			"grok-4.7-low-fast",
			"grok-4.7-medium",
			"grok-4.7-medium-fast",
			"grok-4.7-xhigh",
			"grok-4.7-xhigh-fast",
			"grok-code-fast-1",
			"kimi-k2.5",
			"kimi-k2.7-code",
			"kimi-k3-high",
			"kimi-k3-low",
			"kimi-k3-max",
			"muse-spark-1.3",
			"muse-wonder-1.0",
			"muse-wonder-1.0-1m",
		];
		const unpriced: Record<string, true> = {
			// Absent from https://cursor.com/docs/models-and-pricing; left
			// unpriced rather than proxied from another provider's card.
			"composer-1": true,
			"composer-1.5": true,
			default: true,
			"grok-code-fast-1": true,
			"kimi-k2.5": true,
		};
		for (const id of servedIds) {
			const cost = buildModel(spec(id)).cost;
			if (unpriced[id]) {
				expect(cost, id).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			} else {
				expect(cost.input, `${id} input`).toBeGreaterThan(0);
				expect(cost.output, `${id} output`).toBeGreaterThan(0);
			}
		}
	});
});
