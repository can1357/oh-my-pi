import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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

	it("drops on-device runners from a hosted runner's chain, so their 400 never masks the hosted failure", () => {
		const dictation = getBundledModel("openai-codex", "codex-transcribe")!;
		const local = getBundledModel("local", "whisper-small")!;
		const kindRegistry = {
			getAll: (kind = "chat") => (kind === "all" ? [...models, dictation, local] : models),
			getAvailable: (kind = "chat") => (kind === "all" ? [...models, dictation, local] : models),
		};
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(dictation)]: [key(local)] } });
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

	it("keeps a known provider's prefix locked, so `proxy/foo` never resolves to another provider's `proxy/foo-latest`", () => {
		const routed = buildModel({
			id: "proxy/foo-latest",
			name: "Foo",
			api: "openai-completions",
			provider: "custom-gateway",
			baseUrl: "https://gateway.example/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		// `proxy` is a configured discovery provider whose catalog is still empty.
		const proxyRegistry = {
			getAll: () => [routed],
			getAvailable: () => [routed],
			hasProvider: (provider: string) => provider === "proxy",
		};
		expect(selectorCandidates("proxy/foo", Settings.isolated({}), proxyRegistry)).toEqual([]);
		expect(selectorCandidates("proxy/foo-latest", Settings.isolated({}), proxyRegistry)).toEqual([routed]);
	});
});
