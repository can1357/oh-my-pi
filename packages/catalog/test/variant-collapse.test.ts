import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import {
	ANTIGRAVITY_PRIMARY_ENDPOINT,
	fetchAntigravityDiscoveryModels,
} from "@pk-nerdsaver-ai/pi-catalog/discovery/antigravity";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { stripThinkingVariantToken } from "@pk-nerdsaver-ai/pi-catalog/identity/family";
import { resolveProviderModels } from "@pk-nerdsaver-ai/pi-catalog/model-manager";
import { resolveWireModelId } from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import { googleGeminiCliModelManagerOptions } from "@pk-nerdsaver-ai/pi-catalog/provider-models/google";
import type { ModelSpec } from "@pk-nerdsaver-ai/pi-catalog/types";
import {
	ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
	collapseEffortVariants,
	collapseEffortVariantsAcrossProviders,
	deriveThinkingPairFamilies,
	GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
	getVariantAliasSources,
	isVariantCollapsedSpec,
	resolveBareVariantAlias,
	resolveVariantAlias,
} from "@pk-nerdsaver-ai/pi-catalog/variant-collapse";

function memberSpec(
	id: string,
	overrides: Partial<ModelSpec<"google-gemini-cli">> = {},
): ModelSpec<"google-gemini-cli"> {
	return {
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		...overrides,
	};
}

function pairSpec(
	id: string,
	overrides: Partial<ModelSpec<"openai-completions">> = {},
): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "venice",
		baseUrl: "https://api.venice.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

const PAIR_THINKING = {
	mode: "budget",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
} as const;

const FLASH_TRIPLET = () => [
	memberSpec("gemini-3.5-flash-extra-low", { maxTokens: 32_000 }),
	memberSpec("gemini-3.5-flash-low"),
	memberSpec("gemini-3-flash-agent", { input: ["text"] }),
];

describe("collapseEffortVariants", () => {
	it("collapses the 3.5-flash triplet into one routed logical spec", () => {
		const out = collapseEffortVariants(
			[...FLASH_TRIPLET(), memberSpec("gemini-2.5-flash-lite")],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);

		expect(out.map(m => m.id).sort()).toEqual(["gemini-2.5-flash-lite", "gemini-3.5-flash"]);
		// Non-family specs pass through by reference.
		expect(out.find(m => m.id === "gemini-2.5-flash-lite")?.thinking).toBeUndefined();
		const flash = out.find(m => m.id === "gemini-3.5-flash");
		expect(flash?.name).toBe("Gemini 3.5 Flash");
		expect(flash?.requestModelId).toBe("gemini-3.5-flash-extra-low");
		// Capability union: max caps, image support from any member.
		expect(flash?.maxTokens).toBe(65_535);
		expect(flash?.input).toEqual(["text", "image"]);
		expect(flash?.thinking?.mode).toBe("budget");
		expect(flash?.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		expect(flash?.thinking?.effortBudgets).toEqual({
			minimal: 1000,
			low: 1000,
			medium: 4000,
			high: 10000,
		});
		expect(flash?.thinking?.suppressWhenOff).toBe(true);
		expect(flash?.thinking?.effortRouting).toEqual({
			off: "gemini-3.5-flash-extra-low",
			minimal: "gemini-3.5-flash-extra-low",
			low: "gemini-3.5-flash-extra-low",
			medium: "gemini-3.5-flash-low",
			high: "gemini-3-flash-agent",
		});
	});

	it("drops routes whose target member is absent", () => {
		const out = collapseEffortVariants(
			[memberSpec("gemini-3.5-flash-extra-low")],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);

		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("gemini-3.5-flash");
		expect(out[0]?.requestModelId).toBe("gemini-3.5-flash-extra-low");
		// minimal+low route to extra-low (present); medium (flash-low) and high
		// (flash-agent) targets are absent and drop.
		expect(out[0]?.thinking?.effortRouting).toEqual({
			off: "gemini-3.5-flash-extra-low",
			minimal: "gemini-3.5-flash-extra-low",
			low: "gemini-3.5-flash-extra-low",
		});
	});

	it("routes both bare and -thinking sonnet 4.6 ids to the bare wire id (backend has no -thinking twin)", () => {
		const out = collapseEffortVariants(
			[
				memberSpec("claude-sonnet-4-6", { maxTokens: 64_000 }),
				memberSpec("claude-sonnet-4-6-thinking", { maxTokens: 64_000 }),
			],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);

		expect(out).toHaveLength(1);
		const spec = out[0];
		expect(spec?.id).toBe("claude-sonnet-4-6");
		// Default wire id equals the logical id — requestModelId is omitted and
		// no effortRouting is needed; the request-body `thinkingBudget` carries
		// per-effort behavior on a single shared wire id.
		expect(spec?.requestModelId).toBeUndefined();
		expect(spec?.thinking?.effortRouting).toBeUndefined();
		expect(spec?.thinking?.mode).toBe("budget");

		const model = buildModel(spec as ModelSpec<"google-gemini-cli">);
		expect(resolveWireModelId(model, undefined)).toBe("claude-sonnet-4-6");
		expect(resolveWireModelId(model, Effort.High)).toBe("claude-sonnet-4-6");
	});

	it("collapses a bare-only sonnet 4.6 discovery to the bare wire id", () => {
		const out = collapseEffortVariants(
			[memberSpec("claude-sonnet-4-6", { maxTokens: 64_000 })],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);

		expect(out).toHaveLength(1);
		const spec = out[0];
		expect(spec?.id).toBe("claude-sonnet-4-6");
		expect(spec?.requestModelId).toBeUndefined();
		expect(spec?.thinking?.effortRouting).toBeUndefined();

		const model = buildModel(spec as ModelSpec<"google-gemini-cli">);
		// Regression: previously this routed thinking efforts to a non-existent
		// `claude-sonnet-4-6-thinking` wire id and 404'd on the backend.
		expect(resolveWireModelId(model, Effort.High)).toBe("claude-sonnet-4-6");
		expect(resolveWireModelId(model, undefined)).toBe("claude-sonnet-4-6");
	});

	it("routes every opus 4.6 request to the -thinking wire id (the only one the backend exposes)", () => {
		const out = collapseEffortVariants([memberSpec("claude-opus-4-6-thinking")], ANTIGRAVITY_VARIANT_COLLAPSE_TABLE);

		expect(out).toHaveLength(1);
		const spec = out[0];
		expect(spec?.id).toBe("claude-opus-4-6");
		expect(spec?.requestModelId).toBe("claude-opus-4-6-thinking");
		expect(spec?.thinking?.effortRouting).toBeUndefined();

		const model = buildModel(spec as ModelSpec<"google-gemini-cli">);
		// Thinking-off and every effort fall back through requestModelId to
		// the only wire id the backend actually serves.
		expect(resolveWireModelId(model, undefined)).toBe("claude-opus-4-6-thinking");
		expect(resolveWireModelId(model, Effort.High)).toBe("claude-opus-4-6-thinking");
	});

	it("reconciles a stale Sonnet 4.6 snapshot whose routing still targets the dead -thinking wire id", () => {
		// Bundled `models.json` and SQLite cache rows written before #3071
		// route every effort to `claude-sonnet-4-6-thinking` (a wire id
		// `daily-cloudcode-pa` does not expose). The `retiredMembers` entry
		// triggers `reconcileRetiredRouting`, which re-points every retired
		// route to the live bare wire id.
		const stale: ModelSpec<"google-gemini-cli"> = {
			...memberSpec("claude-sonnet-4-6", { maxTokens: 64_000 }),
			requestModelId: "claude-sonnet-4-6",
			thinking: {
				mode: "budget",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				effortRouting: {
					off: "claude-sonnet-4-6",
					[Effort.Minimal]: "claude-sonnet-4-6-thinking",
					[Effort.Low]: "claude-sonnet-4-6-thinking",
					[Effort.Medium]: "claude-sonnet-4-6-thinking",
					[Effort.High]: "claude-sonnet-4-6-thinking",
				},
			},
		};
		const out = collapseEffortVariants([stale], ANTIGRAVITY_VARIANT_COLLAPSE_TABLE);

		expect(out).toHaveLength(1);
		const spec = out[0];
		expect(spec?.id).toBe("claude-sonnet-4-6");
		expect(spec?.thinking?.effortRouting).toEqual({
			off: "claude-sonnet-4-6",
			minimal: "claude-sonnet-4-6",
			low: "claude-sonnet-4-6",
			medium: "claude-sonnet-4-6",
			high: "claude-sonnet-4-6",
		});

		const model = buildModel(spec as ModelSpec<"google-gemini-cli">);
		expect(resolveWireModelId(model, Effort.High)).toBe("claude-sonnet-4-6");
	});

	it("reconciles a stale Opus 4.6 snapshot whose routing still targets the dead bare wire id", () => {
		// Defensive: a stale snapshot with `off`/efforts pointing at the bare
		// `claude-opus-4-6` (never exposed by Antigravity) is re-pointed to
		// the live `-thinking` wire id by `reconcileRetiredRouting`.
		const stale: ModelSpec<"google-gemini-cli"> = {
			...memberSpec("claude-opus-4-6"),
			requestModelId: "claude-opus-4-6",
			thinking: {
				mode: "budget",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				effortRouting: {
					off: "claude-opus-4-6",
					[Effort.Minimal]: "claude-opus-4-6",
					[Effort.Low]: "claude-opus-4-6",
					[Effort.Medium]: "claude-opus-4-6",
					[Effort.High]: "claude-opus-4-6",
				},
			},
		};
		const out = collapseEffortVariants([stale], ANTIGRAVITY_VARIANT_COLLAPSE_TABLE);

		expect(out).toHaveLength(1);
		const spec = out[0];
		expect(spec?.id).toBe("claude-opus-4-6");
		expect(spec?.requestModelId).toBe("claude-opus-4-6-thinking");
		expect(spec?.thinking?.effortRouting).toEqual({
			off: "claude-opus-4-6-thinking",
			minimal: "claude-opus-4-6-thinking",
			low: "claude-opus-4-6-thinking",
			medium: "claude-opus-4-6-thinking",
			high: "claude-opus-4-6-thinking",
		});

		const model = buildModel(spec as ModelSpec<"google-gemini-cli">);
		expect(resolveWireModelId(model, undefined)).toBe("claude-opus-4-6-thinking");
		expect(resolveWireModelId(model, Effort.High)).toBe("claude-opus-4-6-thinking");
	});

	it("renames single-member families through requestModelId with no routing", () => {
		const out = collapseEffortVariants(
			[memberSpec("gpt-oss-120b-medium", { input: ["text"] })],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);

		expect(out[0]?.id).toBe("gpt-oss-120b");
		expect(out[0]?.requestModelId).toBe("gpt-oss-120b-medium");
		expect(out[0]?.thinking?.effortRouting).toBeUndefined();
		expect(out[0]?.thinking?.mode).toBe("budget");

		const bareOut = collapseEffortVariants(
			[memberSpec("gpt-oss-120b", { input: ["text"] })],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);
		expect(bareOut[0]?.id).toBe("gpt-oss-120b");
		expect(bareOut[0]?.requestModelId).toBeUndefined();
	});

	it("collapses Claude 3.7 and 3.5 thinking pairs on antigravity", () => {
		const out = collapseEffortVariants(
			[
				memberSpec("claude-3-7-sonnet"),
				memberSpec("claude-3-7-sonnet-thinking"),
				memberSpec("claude-3-5-sonnet"),
				memberSpec("claude-3-5-haiku"),
			],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);

		const sonnet37 = out.find(m => m.id === "claude-3-7-sonnet");
		expect(sonnet37).toBeDefined();
		expect(sonnet37?.thinking?.mode).toBe("budget");
		expect(sonnet37?.thinking?.effortRouting?.off).toBe("claude-3-7-sonnet");
		expect(sonnet37?.thinking?.effortRouting?.[Effort.High]).toBe("claude-3-7-sonnet-thinking");

		const sonnet35 = out.find(m => m.id === "claude-3-5-sonnet");
		expect(sonnet35).toBeDefined();
		expect(sonnet35?.thinking?.mode).toBe("budget");

		const haiku35 = out.find(m => m.id === "claude-3-5-haiku");
		expect(haiku35).toBeDefined();
		expect(haiku35?.thinking?.mode).toBe("budget");
	});
	it("is idempotent and dedupes mixed raw+collapsed input", () => {
		const once = collapseEffortVariants(FLASH_TRIPLET(), ANTIGRAVITY_VARIANT_COLLAPSE_TABLE);
		expect(collapseEffortVariants(once, ANTIGRAVITY_VARIANT_COLLAPSE_TABLE)).toEqual(once);

		// Stale raw members beside the live collapsed entry dedupe away; the
		// collapsed entry wins verbatim.
		const mixed = [...once, memberSpec("gemini-3.5-flash-low"), memberSpec("gemini-3-flash-agent")];
		const deduped = collapseEffortVariants(mixed, ANTIGRAVITY_VARIANT_COLLAPSE_TABLE);
		expect(deduped).toEqual(once);
	});

	it("keeps gemini-cli flash on the level transport with the original routing", () => {
		const out = collapseEffortVariants(FLASH_TRIPLET(), GEMINI_CLI_VARIANT_COLLAPSE_TABLE);
		const flash = out.find(m => m.id === "gemini-3.5-flash");
		expect(flash?.thinking?.mode).toBe("google-level");
		expect(flash?.thinking?.effortBudgets).toBeUndefined();
		expect(flash?.thinking?.effortRouting).toEqual({
			off: "gemini-3.5-flash-extra-low",
			minimal: "gemini-3-flash-agent",
			low: "gemini-3.5-flash-extra-low",
			medium: "gemini-3.5-flash-extra-low",
			high: "gemini-3.5-flash-low",
		});
	});

	it("collapses the 3.1-pro family on the budget transport with the +1 budgets", () => {
		const out = collapseEffortVariants(
			[memberSpec("gemini-3.1-pro-low"), memberSpec("gemini-pro-agent")],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);
		const pro = out.find(m => m.id === "gemini-3.1-pro");
		expect(pro?.thinking?.mode).toBe("budget");
		expect(pro?.thinking?.effortBudgets).toEqual({ low: 1001, high: 10001 });
		expect(pro?.thinking?.effortRouting).toEqual({
			off: "gemini-3.1-pro-low",
			low: "gemini-3.1-pro-low",
			high: "gemini-pro-agent",
		});
	});

	it("refreshes a stale alias-keyed flash snapshot in place to the budget contract", () => {
		// Bundled snapshots key the flash family under the recycled `gemini-3-flash`
		// id on the old level transport. That exact id is load-bearing, so it is
		// refreshed in place (same id) rather than re-keyed to `gemini-3.5-flash`.
		const stale: ModelSpec<"google-gemini-cli"> = {
			...memberSpec("gemini-3-flash"),
			reasoning: true,
			thinking: { mode: "google-level", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		};
		const out = collapseEffortVariants([stale], ANTIGRAVITY_VARIANT_COLLAPSE_TABLE);
		const flash = out.find(m => m.id === "gemini-3-flash");
		expect(flash).toBeDefined();
		expect(flash?.thinking?.mode).toBe("budget");
		expect(flash?.thinking?.effortBudgets).toEqual({ minimal: 1000, low: 1000, medium: 4000, high: 10000 });
		expect(flash?.thinking?.effortRouting?.high).toBe("gemini-3-flash-agent");
		expect(flash?.requestModelId).toBe("gemini-3.5-flash-extra-low");
	});

	it("heals a stale alias row alongside the canonical row (merge coexistence)", () => {
		// The model-manager merge keeps both the bundled exact `gemini-3-flash`
		// and the discovered canonical `gemini-3.5-flash` (exact-id merge); both
		// must land on the budget transport and neither is dropped.
		const stale: ModelSpec<"google-gemini-cli"> = {
			...memberSpec("gemini-3-flash"),
			reasoning: true,
			thinking: { mode: "google-level", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		};
		const canonical = collapseEffortVariants(FLASH_TRIPLET(), ANTIGRAVITY_VARIANT_COLLAPSE_TABLE).find(
			m => m.id === "gemini-3.5-flash",
		);
		expect(canonical).toBeDefined();
		const out = collapseEffortVariants(
			[stale, canonical as ModelSpec<"google-gemini-cli">],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);
		expect(out.map(m => m.id).sort()).toEqual(["gemini-3-flash", "gemini-3.5-flash"]);
		expect(out.find(m => m.id === "gemini-3-flash")?.thinking?.mode).toBe("budget");
		expect(out.find(m => m.id === "gemini-3.5-flash")?.thinking?.mode).toBe("budget");
	});

	it("refreshes a stale family.id-keyed 3.1-pro snapshot in place to the budget contract", () => {
		// Pass-through branch: a bundled collapsed `gemini-3.1-pro` on the old level
		// transport with no live members refreshes from the hand table.
		const stale: ModelSpec<"google-gemini-cli"> = {
			...memberSpec("gemini-3.1-pro"),
			reasoning: true,
			requestModelId: "gemini-3.1-pro-low",
			thinking: {
				mode: "google-level",
				efforts: [Effort.Low, Effort.High],
				effortRouting: { off: "gemini-3.1-pro-low", low: "gemini-3.1-pro-low", high: "gemini-pro-agent" },
				suppressWhenOff: true,
			},
		};
		const out = collapseEffortVariants([stale], ANTIGRAVITY_VARIANT_COLLAPSE_TABLE);
		const pro = out.find(m => m.id === "gemini-3.1-pro");
		expect(pro?.thinking?.mode).toBe("budget");
		expect(pro?.thinking?.effortBudgets).toEqual({ low: 1001, high: 10001 });
	});
});

describe("stripThinkingVariantToken", () => {
	it("strips trailing and infix tokens case-insensitively", () => {
		expect(stripThinkingVariantToken("kimi-k2-thinking")).toBe("kimi-k2");
		expect(stripThinkingVariantToken("hf:moonshotai/Kimi-K2-Thinking")).toBe("hf:moonshotai/Kimi-K2");
		expect(stripThinkingVariantToken("xiaomi/mimo-v2-flash-thinking-original")).toBe("xiaomi/mimo-v2-flash-original");
		expect(stripThinkingVariantToken("[Kiro] claude-opus-4-8-thinking [X]")).toBe("[Kiro] claude-opus-4-8 [X]");
		// Reasoning-token spellings pair the same way.
		expect(stripThinkingVariantToken("x-ai/grok-4.1-fast-reasoning")).toBe("x-ai/grok-4.1-fast");
		expect(stripThinkingVariantToken("claude-3-7-sonnet-reasoner")).toBe("claude-3-7-sonnet");
	});

	it("ignores ids without a token and negated tokens", () => {
		expect(stripThinkingVariantToken("kimi-k2")).toBeUndefined();
		// OpenRouter route variants use `:thinking` — a different mechanism.
		expect(stripThinkingVariantToken("anthropic/claude-3.7-sonnet:thinking")).toBeUndefined();
		expect(stripThinkingVariantToken("thinkingcap-1")).toBeUndefined();
		// `non-thinking` names the NON-thinking SKU.
		expect(stripThinkingVariantToken("deepseek-non-thinking-v3.2-exp")).toBeUndefined();
	});
});

describe("deriveThinkingPairFamilies", () => {
	it("derives a pair family routing off to bare and efforts to -thinking", () => {
		const specs = [pairSpec("kimi-k2"), pairSpec("kimi-k2-thinking", { reasoning: true, thinking: PAIR_THINKING })];
		const families = deriveThinkingPairFamilies(specs);

		expect(families).toHaveLength(1);
		expect(families[0]?.id).toBe("kimi-k2");
		expect(families[0]?.members).toEqual(["kimi-k2", "kimi-k2-thinking"]);
		expect(families[0]?.routing).toEqual({
			off: "kimi-k2",
			minimal: "kimi-k2-thinking",
			low: "kimi-k2-thinking",
			medium: "kimi-k2-thinking",
			high: "kimi-k2-thinking",
		});

		const out = collapseEffortVariants(specs, { families });
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("kimi-k2");
		expect(out[0]?.requestModelId).toBeUndefined();
		expect(out[0]?.reasoning).toBe(true);
		expect(out[0]?.thinking?.effortRouting?.[Effort.High]).toBe("kimi-k2-thinking");
		expect(out[0]?.thinking?.effortRouting?.off).toBe("kimi-k2");
	});

	it("pairs infix -thinking tokens", () => {
		const specs = [
			pairSpec("xiaomi/mimo-v2-flash-original"),
			pairSpec("xiaomi/mimo-v2-flash-thinking-original", { reasoning: true, thinking: PAIR_THINKING }),
		];
		const families = deriveThinkingPairFamilies(specs);
		expect(families).toHaveLength(1);
		expect(families[0]?.id).toBe("xiaomi/mimo-v2-flash-original");
	});

	it("collapses metadata-poor twins using the bare member's surface", () => {
		// Aggregators routinely ship the twin with reasoning:false, no
		// thinking config, and zero (unknown) pricing — name wins.
		const base = pairSpec("xiaomi/mimo-v2-flash", {
			reasoning: true,
			cost: { input: 0.09, output: 0.29, cacheRead: 0.045, cacheWrite: 0 },
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
		});
		const twin = pairSpec("xiaomi/mimo-v2-flash-thinking", {
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const families = deriveThinkingPairFamilies([base, twin]);
		expect(families).toHaveLength(1);
		expect(families[0]?.thinking.mode).toBe("effort");

		const out = collapseEffortVariants([base, twin], { families });
		expect(out).toHaveLength(1);
		expect(out[0]?.reasoning).toBe(true);
		expect(out[0]?.cost.input).toBe(0.09);
		expect(out[0]?.thinking?.effortRouting?.[Effort.XHigh]).toBe("xiaomi/mimo-v2-flash-thinking");
		expect(out[0]?.thinking?.effortRouting?.off).toBe("xiaomi/mimo-v2-flash");
	});

	it("collapses zero-cost metadata-less twins with a derived surface", () => {
		const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const base = pairSpec("TEE/kimi-k2.5", { cost: zeroCost });
		const twin = pairSpec("TEE/kimi-k2.5-thinking", { cost: zeroCost });
		const families = deriveThinkingPairFamilies([base, twin]);
		expect(families).toHaveLength(1);
		expect(families[0]?.thinking.efforts.length).toBeGreaterThan(0);

		const out = collapseEffortVariants([base, twin], { families });
		expect(out.map(m => m.id)).toEqual(["TEE/kimi-k2.5"]);
		// Effort routing to a live thinking id forces reasoning even though
		// upstream marked neither member.
		expect(out[0]?.reasoning).toBe(true);
		expect(out[0]?.thinking?.effortRouting?.off).toBe("TEE/kimi-k2.5");
	});

	it("never merges price-divergent twins or orphan thinking ids", () => {
		// Different pricing — distinct SKUs.
		expect(
			deriveThinkingPairFamilies([
				pairSpec("kimi-k2"),
				pairSpec("kimi-k2-thinking", {
					reasoning: true,
					thinking: PAIR_THINKING,
					cost: { input: 3, output: 6, cacheRead: 0.1, cacheWrite: 0 },
				}),
			]),
		).toEqual([]);
		// No bare twin.
		expect(
			deriveThinkingPairFamilies([
				pairSpec("moonshot.kimi-k2-thinking", { reasoning: true, thinking: PAIR_THINKING }),
			]),
		).toEqual([]);
		// Api mismatch.
		expect(
			deriveThinkingPairFamilies([
				pairSpec("kimi-k2"),
				{
					...pairSpec("kimi-k2-thinking", { reasoning: true, thinking: PAIR_THINKING }),
					api: "anthropic-messages",
				} as unknown as ModelSpec<"openai-completions">,
			]),
		).toEqual([]);
	});

	it("defers to hand-table families for claimed ids", () => {
		const specs = [
			memberSpec("claude-sonnet-4-6"),
			memberSpec("claude-sonnet-4-6-thinking", { thinking: PAIR_THINKING }),
		];
		expect(deriveThinkingPairFamilies(specs, ANTIGRAVITY_VARIANT_COLLAPSE_TABLE)).toEqual([]);
	});
});

describe("collapseEffortVariantsAcrossProviders", () => {
	it("applies hand tables and derived pairs per provider", () => {
		const out = collapseEffortVariantsAcrossProviders([
			memberSpec("gemini-3.5-flash-extra-low"),
			pairSpec("kimi-k2"),
			pairSpec("kimi-k2-thinking", { reasoning: true, thinking: PAIR_THINKING }),
			// Same ids on a provider without a table or a live bare twin stay.
			pairSpec("qwen3-vl-32b-thinking", { provider: "aimlapi", reasoning: true, thinking: PAIR_THINKING }),
		]);

		expect(out.map(m => `${m.provider}/${m.id}`).sort()).toEqual([
			"aimlapi/qwen3-vl-32b-thinking",
			"google-antigravity/gemini-3.5-flash",
			"venice/kimi-k2",
		]);
	});
});

describe("variant aliases", () => {
	it("resolves members and recycled ids per provider", () => {
		expect(resolveVariantAlias("google-antigravity", "gemini-3.5-flash-low")).toBe("gemini-3.5-flash");
		expect(resolveVariantAlias("google-gemini-cli", "gemini-pro-agent")).toBe("gemini-3.1-pro");
		expect(resolveVariantAlias("google-antigravity", "gemini-3-flash")).toBe("gemini-3.5-flash");
		expect(resolveVariantAlias("google-antigravity", "gemini-2.5-flash-thinking")).toBe("gemini-2.5-flash");
		expect(resolveVariantAlias("google-antigravity", "gemini-2.5-flash-lite")).toBeUndefined();
		expect(resolveVariantAlias("anthropic", "claude-sonnet-4-6-thinking")).toBeUndefined();
	});

	it("names the declaring providers in bare-id lookups", () => {
		const hit = resolveBareVariantAlias("GEMINI-3.5-FLASH-LOW");
		expect(hit?.id).toBe("gemini-3.5-flash");
		expect(hit?.providers).toContain("google-antigravity");
		expect(hit?.providers).toContain("google-gemini-cli");
		expect(resolveBareVariantAlias("gpt-4o")).toBeUndefined();
	});

	it("reverse sources cover members and recycled ids", () => {
		const sources = getVariantAliasSources("google-antigravity", "gemini-3.5-flash");
		expect(sources).toContain("gemini-3.5-flash-extra-low");
		expect(sources).toContain("gemini-3.5-flash-low");
		expect(sources).toContain("gemini-3-flash");
		expect(getVariantAliasSources("openai", "gpt-4o")).toEqual([]);
	});

	it("scopes collapsed-spec detection to routing and hand-table families", () => {
		const collapsed = collapseEffortVariants(
			[memberSpec("gemini-3.5-flash-low")],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		)[0];
		expect(collapsed && isVariantCollapsedSpec(collapsed)).toBe(true);
		expect(isVariantCollapsedSpec(memberSpec("gemini-3.5-flash-low"))).toBe(false);
		// Copilot long-context variants carry requestModelId but are NOT
		// collapsed specs — the generator rebake must not skip them.
		expect(
			isVariantCollapsedSpec(
				memberSpec("claude-opus-4.7-1m", { provider: "github-copilot", requestModelId: "claude-opus-4.7" }),
			),
		).toBe(false);
	});
});

describe("resolveWireModelId", () => {
	it("survives buildModel and routes per effort with requestModelId fallback", () => {
		const collapsed = collapseEffortVariants(FLASH_TRIPLET(), ANTIGRAVITY_VARIANT_COLLAPSE_TABLE)[0];
		const model = buildModel(collapsed as ModelSpec<"google-gemini-cli">);

		expect(model.thinking?.effortRouting).toEqual(collapsed?.thinking?.effortRouting);
		expect(model.thinking?.suppressWhenOff).toBe(true);
		expect(resolveWireModelId(model, Effort.High)).toBe("gemini-3-flash-agent");
		expect(resolveWireModelId(model, Effort.Medium)).toBe("gemini-3.5-flash-low");
		expect(resolveWireModelId(model, Effort.Minimal)).toBe("gemini-3.5-flash-extra-low");
		expect(resolveWireModelId(model, undefined)).toBe("gemini-3.5-flash-extra-low");

		// Dropped route (partial family) falls back to requestModelId.
		const partial = collapseEffortVariants(
			[memberSpec("gemini-3.5-flash-extra-low")],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		)[0];
		const partialModel = buildModel(partial as ModelSpec<"google-gemini-cli">);
		expect(resolveWireModelId(partialModel, Effort.High)).toBe("gemini-3.5-flash-extra-low");

		// Models without routing serialize their own id.
		expect(resolveWireModelId(buildModel(memberSpec("gemini-2.5-flash-lite")), Effort.High)).toBe(
			"gemini-2.5-flash-lite",
		);
	});
});

describe("merge-point collapsing (resolveProviderModels)", () => {
	async function tempDb(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "variant-collapse-"));
		return path.join(dir, "models.db");
	}

	it("converges stale static raw ids with collapsed dynamic results", async () => {
		const dbPath = await tempDb();
		const staleStatic = [
			memberSpec("gemini-3.1-pro-low"),
			memberSpec("gemini-3.1-pro-high"),
			memberSpec("gemini-2.5-flash-lite"),
		];
		const liveCollapsed = collapseEffortVariants(
			[memberSpec("gemini-3.1-pro-low"), memberSpec("gemini-3.1-pro-high")],
			ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
		);

		const result = await resolveProviderModels(
			{
				providerId: "google-antigravity",
				staticModels: staleStatic,
				fetchDynamicModels: () => Promise.resolve(liveCollapsed),
				cacheDbPath: dbPath,
			},
			"online",
		);
		expect(result.models.map(m => m.id).sort()).toEqual(["gemini-2.5-flash-lite", "gemini-3.1-pro"]);

		// The cache snapshot written above is collapsed too: a later resolve
		// whose dynamic fetch fails must not resurrect raw ids.
		const offline = await resolveProviderModels(
			{
				providerId: "google-antigravity",
				staticModels: staleStatic,
				fetchDynamicModels: () => Promise.resolve(null),
				cacheDbPath: dbPath,
			},
			"online",
		);
		expect(offline.models.filter(m => m.id.includes("gemini-3.1-pro")).map(m => m.id)).toEqual(["gemini-3.1-pro"]);
	});

	it("collapses X/X-thinking pairs for providers without a hand table", async () => {
		const dbPath = await tempDb();
		const result = await resolveProviderModels(
			{
				providerId: "venice",
				staticModels: [
					pairSpec("kimi-k2"),
					pairSpec("kimi-k2-thinking", { reasoning: true, thinking: PAIR_THINKING }),
				],
				cacheDbPath: dbPath,
			},
			"offline",
		);

		expect(result.models.map(m => m.id)).toEqual(["kimi-k2"]);
		const model = result.models[0];
		expect(model?.reasoning).toBe(true);
		expect(model && resolveWireModelId(model, Effort.High)).toBe("kimi-k2-thinking");
		expect(model && resolveWireModelId(model, undefined)).toBe("kimi-k2");
	});
});

describe("antigravity discovery collapsing", () => {
	const payload = {
		models: {
			"gemini-3.5-flash-extra-low": {
				displayName: "Gemini 3.5 Flash (Extra Low)",
				supportsThinking: true,
				supportsImages: true,
				maxTokens: 1_048_576,
				maxOutputTokens: 65_536,
			},
			"gemini-3.5-flash-low": {
				displayName: "Gemini 3.5 Flash (Low)",
				supportsThinking: true,
				supportsImages: true,
				maxTokens: 1_048_576,
				maxOutputTokens: 65_536,
			},
			"gemini-3-flash-agent": {
				displayName: "Gemini 3 Flash Agent",
				supportsThinking: true,
				supportsImages: true,
				thinkingBudget: 10_000,
			},
			"claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", supportsThinking: true, supportsImages: true },
			"claude-sonnet-4-6-thinking": {
				displayName: "Claude Sonnet 4.6 Thinking",
				supportsThinking: true,
				supportsImages: true,
			},
			"gemini-2.5-flash": { displayName: "Gemini 2.5 Flash", supportsThinking: true, supportsImages: true },
			"gemini-2.5-flash-thinking": { displayName: "Gemini 2.5 Flash Thinking", supportsThinking: true },
			chat_20706: { displayName: "Chat Internal" },
			"internal-model": { displayName: "Internal", isInternal: true },
		},
	};
	const fetcher = Object.assign(
		(_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
			Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
		{ preconnect: fetch.preconnect },
	);

	it("returns collapsed logical entries and keeps the denylist", async () => {
		const models = await fetchAntigravityDiscoveryModels({ token: "t", endpoint: "https://cca.test", fetcher });

		expect(models?.map(m => m.id).sort()).toEqual(["claude-sonnet-4-6", "gemini-2.5-flash", "gemini-3.5-flash"]);
		const flash = models?.find(m => m.id === "gemini-3.5-flash");
		expect(flash?.requestModelId).toBe("gemini-3.5-flash-extra-low");
		expect(flash?.thinking?.effortRouting?.[Effort.High]).toBe("gemini-3-flash-agent");
		expect(flash?.thinking?.effortRouting?.[Effort.Medium]).toBe("gemini-3.5-flash-low");
		expect(flash?.thinking?.suppressWhenOff).toBe(true);
		// The 2.5 pair collapses instead of denylisting the -thinking twin.
		const flash25 = models?.find(m => m.id === "gemini-2.5-flash");
		expect(flash25?.thinking?.effortRouting?.[Effort.High]).toBe("gemini-2.5-flash-thinking");
		expect(flash25?.thinking?.effortRouting?.off).toBe("gemini-2.5-flash");
	});

	it("keeps collapsed routing through the gemini-cli re-provision", async () => {
		const options = googleGeminiCliModelManagerOptions({
			oauthToken: "t",
			endpoint: "https://cca.test",
			fetch: fetcher,
		});
		const models = await options.fetchDynamicModels?.();

		const flash = models?.find(m => m.id === "gemini-3.5-flash");
		expect(flash?.provider).toBe("google-gemini-cli");
		expect(flash?.baseUrl).toBe("https://cca.test");
		expect(flash?.requestModelId).toBe("gemini-3.5-flash-extra-low");
		expect(flash?.thinking?.effortRouting?.off).toBe("gemini-3.5-flash-extra-low");
	});

	it("uses the primary daily endpoint by default", async () => {
		const requestedUrls: string[] = [];
		const defaultFetcher = Object.assign(
			(input: string | URL | Request, _init?: RequestInit) => {
				requestedUrls.push(String(input));
				return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
			},
			{ preconnect: fetch.preconnect },
		);

		const models = await fetchAntigravityDiscoveryModels({
			token: "t",
			fetcher: defaultFetcher,
		});

		expect(requestedUrls[0]).toContain(ANTIGRAVITY_PRIMARY_ENDPOINT);
		expect(models?.[0]?.baseUrl).toBe(ANTIGRAVITY_PRIMARY_ENDPOINT);
	});
});
