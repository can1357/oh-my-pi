import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { selectorCandidates } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

const fast = getBundledModel("google", "gemini-3.5-flash")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const vertex = getBundledModel("google-vertex", "gemini-3.5-flash")!;
const models = [fast, mini, vertex];
const registry = { getAll: () => models, getAvailable: () => models };
const key = (model: typeof fast) => `${model.provider}/${model.id}`;

describe("auth-gateway stdio model selectors", () => {
	it("skips comma entries that resolve to nothing and follows the chosen role's fallback chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex), key(fast)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@commit,@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("uses a role-keyed chain when the role has no configured primary", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	// A retry must never move to a model the user did not select: a role's
	// built-in priority list would retry on any logged-in provider.
	it("never falls back to a role's built-in priority models", () => {
		const settings = Settings.isolated({});
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
		settings.setModelRole("smol", key(vertex));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([vertex]);
	});

	it("uses the inherited default chain for a role without its own chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { default: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("keeps an explicitly empty role chain from inheriting the default chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [], default: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
	});

	it("keeps model-keyed chains ahead of configured role chains", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(fast)]: [key(vertex)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
		cfgRetryFallbackChains.set(settings, { smol: [key(mini)], [key(fast)]: [key(vertex)] });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("follows model-keyed chains even when the role primary comes from its defaults", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(fast)]: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("expands role fallbacks transitively without retrying a model in a cycle", () => {
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				smol: [key(vertex)],
				[key(vertex)]: [key(mini), key(fast)],
				[key(mini)]: [key(vertex)],
			},
		});
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex, mini]);
	});

	it("does not add role defaults when model fallback is disabled", () => {
		const settings = Settings.isolated({ "retry.modelFallback": false });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
	});

	it("does not add role defaults to an explicit model selector", () => {
		expect(selectorCandidates(key(fast), Settings.isolated({}), registry)).toEqual([fast]);
	});

	it("follows a concrete model's own chain and stops at the first resolvable entry", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(mini)]: [key(vertex)] } });
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([mini, vertex]);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorCandidates("@commit", Settings.isolated({}), registry)).toEqual([]);
	});
});
