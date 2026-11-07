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

	it("uses built-in fallbacks when the role has no configured primary or chain", () => {
		expect(selectorCandidates("@smol", Settings.isolated({}), registry)).toEqual([fast, mini]);
	});

	it("uses built-in fallbacks after a configured role primary", () => {
		const settings = Settings.isolated({});
		settings.setModelRole("smol", key(vertex));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([vertex, fast, mini]);
	});

	it("prefers the inherited default chain over built-in fallbacks for a role without its own chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { default: [key(vertex)] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("does not append built-in fallbacks to an explicitly empty role chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [] } });
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
		settings.setModelRole("smol", key(vertex));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([vertex]);
	});

	it("keeps model-keyed chains ahead of built-in and configured role chains", () => {
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
