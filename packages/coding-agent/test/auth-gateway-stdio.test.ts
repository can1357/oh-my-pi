import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { selectorCandidates } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

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

	it("follows a concrete model's own chain and stops at the first resolvable entry", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(mini)]: [key(vertex)] } });
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([mini, vertex]);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorCandidates("@commit", Settings.isolated({}), registry)).toEqual([]);
	});

	it("resolves runner-kind models that the chat-only registry view hides", () => {
		const dictation = getBundledModel("openai-codex", "codex-transcribe")!;
		const kindRegistry = {
			getAll: (kind = "chat") => (kind === "all" ? [...models, dictation] : models),
			getAvailable: (kind = "chat") => (kind === "all" ? [...models, dictation] : models),
		};
		expect(selectorCandidates(key(dictation), Settings.isolated({}), kindRegistry)).toEqual([dictation]);
	});

	it("uses the first comma entry that resolves, even when it is a runner and a later entry is chat", () => {
		const dictation = getBundledModel("openai-codex", "codex-transcribe")!;
		const kindRegistry = {
			getAll: (kind = "chat") => (kind === "all" ? [...models, dictation] : models),
			getAvailable: (kind = "chat") => (kind === "all" ? [...models, dictation] : models),
		};
		expect(selectorCandidates(`${key(dictation)},${key(mini)}`, Settings.isolated({}), kindRegistry)).toEqual([
			dictation,
		]);
	});

	it("drops chat models a runner's default fallback chain names, since the runner's route cannot serve them", () => {
		const dictation = getBundledModel("openai-codex", "codex-transcribe")!;
		const kindRegistry = {
			getAll: (kind = "chat") => (kind === "all" ? [...models, dictation] : models),
			getAvailable: (kind = "chat") => (kind === "all" ? [...models, dictation] : models),
		};
		const settings = Settings.isolated({ "retry.fallbackChains": { default: [key(mini)] } });
		expect(selectorCandidates(key(dictation), settings, kindRegistry)).toEqual([dictation]);
	});

	it("prefers the chat model when the chat view and the full catalog both match a selector", () => {
		const dictation = getBundledModel("openai-codex", "codex-transcribe")!;
		// A runner that shares the chat model's bare id and sorts ahead of it in the full catalog.
		const runner = { ...dictation, id: mini.id };
		const registryWithRunner = {
			getAll: (kind = "chat") => (kind === "all" ? [runner, mini] : [mini]),
			getAvailable: (kind = "chat") => (kind === "all" ? [runner, mini] : [mini]),
		};
		expect(selectorCandidates(mini.id, Settings.isolated({}), registryWithRunner)).toEqual([mini]);
	});
});
