/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { createTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelHubRegistry, ModelHubSource } from "../../../../src/modes/view-model/overlays/model-hub";
import { ModelHub } from "../../../../src/ui/overlays/pickers/model-hub";
import { ModelHubState } from "../../../../src/ui/overlays/pickers/model-hub-state";
import { nativeShell } from "../../../helpers/native-shell";
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
	authStorage: { keys: { source: () => undefined } },
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

	test("native thinking strip labels use the active theme glyphs", async () => {
		const previous = currentTheme();
		const custom = createTheme({
			...previous.json,
			symbols: {
				...previous.json.symbols,
				overrides: {
					...previous.json.symbols?.overrides,
					"status.disabled": "@D",
					"thinking.low": "@L low",
					"thinking.autoPending": "@A auto",
				},
			},
		});
		setCurrentTheme(custom);
		try {
			await using ui = await nativeShell();
			ui.shell.overlays.show(() => (
				<ModelHub
					source={source}
					registry={registry}
					scopedModels={models.map(model => ({ model }))}
					callbacks={{ onAssign: () => true, onUnassign: () => {}, onCancel: () => {} }}
					options={{ currentSelector: "anthropic/claude-sonnet-4-5" }}
					terminalRows={() => 30}
				/>
			));
			const picker = (): TspPickerProps => ui.node("picker").p;
			const pickerNode = ui.node("picker");
			ui.send({ ev: "activate", sf: ui.sf, id: pickerNode.id, item: selectorOf(models[0]!) });

			const roleStrip = picker().strip;
			expect(roleStrip).toBeDefined();
			const slow = roleStrip?.items.find(
				item => (typeof item.label === "string" ? item.label : item.label.map(span => span.t).join("")) === "slow",
			);
			expect(slow).toBeDefined();
			ui.send({ ev: "action", sf: ui.sf, id: pickerNode.id, act: "strip", value: slow!.id });

			const thinkingItems = picker().strip?.items ?? [];
			const labels = thinkingItems.map(item =>
				typeof item.label === "string" ? item.label : item.label.map(span => span.t).join(""),
			);
			expect(labels).toEqual(expect.arrayContaining(["@D off", "@L low", "@A auto"]));
			expect(thinkingItems.every(item => item.dot === undefined)).toBe(true);
		} finally {
			setCurrentTheme(previous);
		}
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
