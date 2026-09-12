import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	collectOnlineTinyCandidates,
	expandOnlineTinyModelFallbacks,
} from "@oh-my-pi/pi-coding-agent/tiny/online-candidates";

const primary = getBundledModel("google", "gemini-2.5-flash")!;
const secondary = getBundledModel("openai", "gpt-4o-mini")!;
const fallback = getBundledModel("google-vertex", "gemini-2.5-flash")!;
const models = [primary, secondary, fallback];
const primarySelector = `${primary.provider}/${primary.id}`;
const secondarySelector = `${secondary.provider}/${secondary.id}`;
const fallbackSelector = `${fallback.provider}/${fallback.id}`;

function candidates(chains: Record<string, string[]>, modelFallback = true) {
	const settings = Settings.isolated({
		"retry.modelFallback": modelFallback,
		"retry.fallbackChains": chains,
	});
	settings.setModelRole("tiny", primarySelector);
	settings.setModelRole("smol", secondarySelector);
	return collectOnlineTinyCandidates(["tiny", "smol"], settings, models).map(candidate => candidate.model);
}

describe("online tiny fallback candidates", () => {
	it("does not hop to another role primary when model fallback is disabled", () => {
		expect(candidates({ tiny: [fallbackSelector] }, false)).toEqual([primary]);
	});

	it("still selects the first resolvable role when model fallback is disabled", () => {
		const settings = Settings.isolated({ "retry.modelFallback": false });
		settings.setModelRole("tiny", "missing/unavailable");
		settings.setModelRole("smol", secondarySelector);
		expect(collectOnlineTinyCandidates(["tiny", "smol"], settings, models)).toEqual([
			{ role: "smol", model: secondary },
		]);
	});

	it("keeps role primaries ahead of configured fallback hops and deduplicates models", () => {
		expect(candidates({ tiny: [secondarySelector, fallbackSelector, fallbackSelector] })).toEqual(models);
	});

	it("uses a model-keyed chain instead of the role or default chain", () => {
		expect(candidates({ [primarySelector]: [fallbackSelector], tiny: [secondarySelector], default: [] })).toEqual(
			models,
		);
	});

	it("uses the most specific wildcard key", () => {
		const routed = getBundledModel("openrouter", "google/gemini-2.5-flash")!;
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				"openrouter/*": [secondarySelector],
				"openrouter/google/*": ["google-vertex/*"],
			},
		});
		settings.setModelRole("tiny", "openrouter/google/gemini-2.5-flash");
		expect(
			collectOnlineTinyCandidates(["tiny"], settings, [...models, routed]).map(candidate => candidate.model),
		).toEqual([routed, fallback]);
	});

	it("expands wildcard entries using the current model id", () => {
		expect(candidates({ tiny: ["google-vertex/*"] })).toEqual(models);
	});

	it("does not append default when every requested role has its own chain", () => {
		expect(candidates({ tiny: [secondarySelector], smol: [], default: [fallbackSelector] })).toEqual([
			primary,
			secondary,
		]);
	});

	it("inherits default for a role without its own chain", () => {
		expect(candidates({ tiny: [], default: [fallbackSelector] })).toEqual(models);
	});

	it("preserves distinct role chains when their primaries are the same model", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": { tiny: [secondarySelector], smol: [fallbackSelector] },
		});
		settings.setModelRole("tiny", primarySelector);
		settings.setModelRole("smol", primarySelector);
		expect(collectOnlineTinyCandidates(["tiny", "smol"], settings, models).map(candidate => candidate.model)).toEqual(
			models,
		);
	});

	it("lets an explicitly empty role chain suppress the default chain", () => {
		expect(candidates({ tiny: [], smol: [], default: [fallbackSelector] })).toEqual([primary, secondary]);
	});

	it("skips unavailable and invalid entries without duplicating a primary", () => {
		expect(candidates({ tiny: ["missing/model", "invalid", primarySelector, fallbackSelector] })).toEqual(models);
	});

	it("preserves fallback chains for bare role selectors", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": { smol: [fallbackSelector] },
		});
		settings.setModelRole("smol", secondary.id);
		expect(collectOnlineTinyCandidates(["smol"], settings, models).map(candidate => candidate.model)).toEqual([
			secondary,
			fallback,
		]);
	});

	it("strips upstream routing before expanding wildcard fallbacks", () => {
		const routed = getBundledModel("openrouter", "google/gemini-2.5-flash")!;
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				"openrouter/*": ["google-vertex/*"],
			},
		});
		settings.setModelRole("tiny", "openrouter/google/gemini-2.5-flash@cerebras");
		expect(
			collectOnlineTinyCandidates(["tiny"], settings, [...models, routed]).map(
				candidate => `${candidate.model.provider}/${candidate.model.id}`,
			),
		).toEqual([`${routed.provider}/${routed.id}`, `${fallback.provider}/${fallback.id}`]);
	});

	it("keeps distinct @upstream routes for the same aggregator model", () => {
		const routed = getBundledModel("openrouter", "google/gemini-2.5-flash")!;
		const settings = Settings.isolated({ "retry.modelFallback": true });
		settings.setModelRole("tiny", "openrouter/google/gemini-2.5-flash@cerebras");
		settings.setModelRole("smol", "openrouter/google/gemini-2.5-flash@openai");
		const result = collectOnlineTinyCandidates(["tiny", "smol"], settings, [...models, routed]);
		expect(result.map(candidate => formatModelStringWithRouting(candidate.model))).toEqual([
			"openrouter/google/gemini-2.5-flash@cerebras",
			"openrouter/google/gemini-2.5-flash@openai",
		]);
		expect(result.map(candidate => candidate.role)).toEqual(["tiny", "smol"]);
	});

	it("resolves routed @upstream fallback selectors before lookup", () => {
		const routed = getBundledModel("openrouter", "google/gemini-2.5-flash")!;
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				tiny: ["openrouter/google/gemini-2.5-flash@cerebras"],
			},
		});
		settings.setModelRole("tiny", primarySelector);
		const result = collectOnlineTinyCandidates(["tiny"], settings, [...models, routed]);
		expect(result.map(candidate => formatModelStringWithRouting(candidate.model))).toEqual([
			primarySelector,
			"openrouter/google/gemini-2.5-flash@cerebras",
		]);
	});

	it("traverses model-keyed fallback chains from each hop", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				tiny: [secondarySelector],
				[secondarySelector]: [fallbackSelector],
			},
		});
		settings.setModelRole("tiny", primarySelector);
		expect(collectOnlineTinyCandidates(["tiny"], settings, models).map(candidate => candidate.model)).toEqual(models);
	});

	it("expands a seed model's own chain without merging role defaults", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				[primarySelector]: [fallbackSelector],
				// Role chain must not be applied to the seed (no expandDefault merge).
				tiny: [secondarySelector],
			},
		});
		settings.setModelRole("tiny", primarySelector);
		// Seed is primary: model-keyed hop to fallback must apply. Even though tiny
		// is assigned the same primary, expandOnlineTinyModelFallbacks must not treat
		// the seed as a tiny role primary (that would also queue secondary).
		expect(expandOnlineTinyModelFallbacks(primary, settings, models)).toEqual([primary, fallback]);
	});

	it("traverses multi-hop chains from an appended seed model", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				[primarySelector]: [secondarySelector],
				[secondarySelector]: [fallbackSelector],
			},
		});
		expect(expandOnlineTinyModelFallbacks(primary, settings, models)).toEqual(models);
	});
});
