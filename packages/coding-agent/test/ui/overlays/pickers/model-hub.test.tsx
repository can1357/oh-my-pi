/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelHubRegistry, ModelHubSource } from "../../../../src/modes/view-model/overlays/model-hub";
import { ModelHub } from "../../../../src/ui/overlays/pickers/model-hub";
import { ModelHubState } from "../../../../src/ui/overlays/pickers/model-hub-state";
import { type Driver, keyFromRaw, pickerSuite } from "./harness";

const mk = (id: string, provider: string, reasoning = false, input: ("text" | "image")[] = ["text"]): Model =>
	buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://x",
		reasoning,
		input,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});

const models = [
	mk("claude-sonnet-4-5", "anthropic", true, ["text", "image"]),
	mk("claude-haiku", "anthropic"),
	mk("gpt-5-codex-extremely-long-model-identifier-名前", "openai", true),
	mk("llama-3.1-70b", "ollama"),
];
const roles: Record<string, string> = { default: "anthropic/claude-sonnet-4-5", smol: "anthropic/claude-haiku" };
const selectorOf = (model: Model): string => `${model.provider}/${model.id}`;

const source: ModelHubSource = {
	revision: 0,
	disabledProviders: [],
	fallbackChains: { default: ["openai/gpt-5-codex-extremely-long-model-identifier-名前"] },
	modelRoleStorage: "global",
	cycleOrder: ["default", "smol"],
	getProjectModelRole: () => undefined,
	getGlobalModelRole: role => roles[role],
	getModelRoleSource: () => "global",
	defaultThinkingLevel: "high",
	modelProviderOrder: [],
	knownRoleIds: ["default", "smol", "slow"],
	mruOrder: ["anthropic/claude-haiku"],
	modelPerf: new Map(),
	getModelRole: role => roles[role],
	getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: value => ({
		model: models.find(model => selectorOf(model) === value),
		explicitThinkingLevel: false,
	}),
};

const registry: ModelHubRegistry = {
	getError: () => undefined,
	getAvailable: () => models,
	getAll: () => models,
	authStorage: { keys: { source: () => undefined }, credentials: { list: () => [] } },
	getDiscoverableProviders: () => [],
	getProviderDiscoveryState: () => undefined,
	find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
	refreshIfStale: async () => false,
	refreshProvider: async () => {},
};

const scope = (value: string) => (d: Driver) => void d.emit({ type: "action", key: "", act: "scope", value, mods: [] });
const key = (raw: string) => (d: Driver) => d.press(raw);

pickerSuite({
	dir: "overlays/model-hub",
	mount() {
		let hub: ModelHubState | undefined;
		return {
			view: () => (
				<ModelHub
					source={source}
					registry={registry}
					scopedModels={models.map(model => ({ model }))}
					callbacks={{ onAssign: () => true, onUnassign: () => {}, onCancel: () => {}, onSavePreset: () => {} }}
					options={{ currentSelector: "anthropic/claude-sonnet-4-5" }}
					terminalRows={() => 30}
					onState={state => {
						hub = state;
					}}
				/>
			),
			steps: {
				refresh: () => hub?.refreshAfterExternalMutation(),
				"click roles": scope("roles"),
				down: key("\x1b[B"),
				save: key("s"),
				type: key("p"),
				esc: key("\x1b"),
				fallback: key("f"),
				enter: key("\r"),
				provider: scope("provider:openai"),
				enter2: key("\r"),
			},
		};
	},
});

describe("model hub flows the corpus does not record", () => {
	const press = (hub: ModelHubState, raw: string): void => void hub.handleKey(keyFromRaw(raw));

	test("Enter on a model offers its roles, assigning one offers its thinking levels", () => {
		const assigned: string[] = [];
		const hub = new ModelHubState(
			source,
			registry,
			models.map(model => ({ model })),
			{
				onAssign: (_model, role, level, selector) => void assigned.push(`${role}:${selector}:${level}`),
				onUnassign: () => {},
				onCancel: () => {},
			},
		);
		press(hub, "\r"); // sidebar → rows
		press(hub, "\r"); // pick the first model
		const strip = hub.strip;
		expect(strip?.kind).toBe("role");
		if (strip?.kind !== "role") return;
		expect(strip.chips.map(chip => chip.label)).toEqual([
			"default",
			"smol",
			"slow",
			"fallbacks:claude-sonnet-4-5",
			"fallbacks:anthropic/*",
			"fallback",
		]);
		press(hub, "\x1b[C");
		press(hub, "\x1b[C"); // slow
		press(hub, "\r");
		expect(assigned).toEqual(["slow:anthropic/claude-sonnet-4-5:inherit"]);
		expect(hub.strip?.kind).toBe("thinking");
		press(hub, "\x1b");
		expect(hub.strip).toBeNull();
		hub.dispose();
	});

	test("the Roles view edits the ctrl+p cycle and fallback order", () => {
		const cycles: string[][] = [];
		const hub = new ModelHubState(
			source,
			registry,
			models.map(model => ({ model })),
			{
				onAssign: () => {},
				onUnassign: () => {},
				onCancel: () => {},
				onCycleOrderChange: order => void cycles.push(order),
			},
		);
		hub.clickSidebarEntry("roles");
		press(hub, "c"); // default leaves the cycle
		press(hub, "\x1b[B");
		press(hub, "\x1b[B");
		press(hub, "]"); // smol moves later: nothing after it
		press(hub, "[");
		expect(cycles).toEqual([["smol"], ["smol", "default"]]);
		hub.dispose();
	});
});

describe("model hub fallback chains reject non-chat models (#20897)", () => {
	const press = (hub: ModelHubState, raw: string): void => void hub.handleKey(keyFromRaw(raw));

	const imageModel: Model = buildModel({
		id: "gpt-image-2",
		name: "gpt-image-2",
		api: "openai-images",
		provider: "openai-codex",
		baseUrl: "https://x",
		reasoning: false,
		input: ["image"],
		kind: "image",
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});

	const tinyModel: Model = buildModel({
		id: "tiny-helper",
		name: "tiny-helper",
		api: "ollama-chat",
		provider: "ollama",
		baseUrl: "https://x",
		reasoning: false,
		input: ["text"],
		kind: "tiny",
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});

	const kindOf = (model: Model) => model.kind ?? "chat";
	// Mirror production: chat-section roles accept chat, and tiny/memory also accept tiny.
	const kindSource: ModelHubSource = {
		...source,
		fallbackChains: {},
		knownRoleIds: ["default"],
		getRoleInfo: role =>
			role === "tiny" || role === "memory"
				? {
						name: role,
						section: "chat",
						accepts: model => kindOf(model) === "tiny" || kindOf(model) === "chat",
					}
				: { name: role, section: "chat", accepts: model => kindOf(model) === "chat" },
	};

	const chatModels = [models[0]!, tinyModel, imageModel];

	function makeHub(items: Model[]) {
		return new ModelHubState(
			kindSource,
			registry,
			items.map(model => ({ model })),
			{ onAssign: () => true, onUnassign: () => {}, onCancel: () => {} },
		);
	}

	test("a non-chat model's role strip offers no fallback chips", () => {
		const hub = makeHub(chatModels);
		press(hub, "\r"); // sidebar to rows
		press(hub, "\x1b[B"); // past the chat model
		press(hub, "\x1b[B"); // highlight the image model row
		press(hub, "\r");
		const strip = hub.strip;
		expect(strip?.kind).toBe("role");
		if (strip?.kind !== "role") return;
		expect(strip.item.model.id).toBe("gpt-image-2");
		expect(strip.chips.map(chip => chip.label)).toEqual([]);
		hub.dispose();
	});

	test("a chat model's role strip still offers the fallback chips", () => {
		const hub = makeHub(chatModels);
		press(hub, "\r"); // sidebar to rows
		press(hub, "\r"); // pick the first row: the chat model
		const strip = hub.strip;
		expect(strip?.kind).toBe("role");
		if (strip?.kind !== "role") return;
		expect(strip.item.model.kind ?? "chat").toBe("chat");
		expect(strip.chips.map(chip => chip.label)).toEqual([
			"default",
			"fallbacks:claude-sonnet-4-5",
			"fallbacks:anthropic/*",
			"fallback",
		]);
		hub.dispose();
	});

	test("browsing candidates for a model-keyed chain filters to chat-capable models", () => {
		const hub = makeHub(chatModels);
		press(hub, "\r"); // sidebar to rows
		press(hub, "\r"); // open the chat model's strip
		press(hub, "\x1b[C"); // move to `fallbacks:claude-sonnet-4-5`
		press(hub, "\r"); // browse candidates for the chain key `anthropic/claude-sonnet-4-5`
		expect(hub.strip).toBeNull();
		expect(hub.candidateItems.map(item => item.model.id)).toEqual(["claude-sonnet-4-5", "tiny-helper"]);
		hub.dispose();
	});

	test("the brand-new-chain-key browser filters to the highlighted role's accepts", () => {
		const hub = makeHub(chatModels);
		hub.clickSidebarEntry("roles");
		press(hub, "f"); // add a fallback to the highlighted `default` role
		expect(hub.candidateItems.map(item => item.model.id)).toEqual(["claude-sonnet-4-5"]);
		hub.dispose();
	});

	test("a tiny-kind model's role strip still offers the fallback chips", () => {
		const hub = makeHub(chatModels);
		press(hub, "\r"); // sidebar to rows
		press(hub, "\x1b[B"); // highlight the tiny model row
		press(hub, "\r");
		const strip = hub.strip;
		expect(strip?.kind).toBe("role");
		if (strip?.kind !== "role") return;
		expect(strip.item.model.id).toBe("tiny-helper");
		expect(strip.chips.map(chip => chip.label)).toEqual(["fallbacks:tiny-helper", "fallbacks:ollama/*", "fallback"]);
		hub.dispose();
	});
});
