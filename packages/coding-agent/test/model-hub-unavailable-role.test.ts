/**
 * A configured role whose model is momentarily absent from the catalog — a
 * discovery-backed provider that has not listed it yet — must stay visible as
 * configured, not read as cleared, and must not be rewritten through the role
 * strip. Regression for a role silently disappearing from `/model` after its
 * provider's roster was pruned mid-refresh.
 */
import { createModelBrowserSource } from "../src/modes/model-browser-source";
import { afterEach, beforeAll, describe, expect, test, type Mock, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ModelHubComponent } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const testTheme = await getThemeByName("dark");

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 1024,
	});
}

const openHubs: ModelHubComponent[] = [];

interface Harness {
	hub: ModelHubComponent;
	settings: Settings;
	onAssign: Mock<(...args: unknown[]) => boolean>;
	onUnassign: Mock<(...args: unknown[]) => void>;
	setPool: (models: Model[]) => void;
}

function createHarness(initial: Model[], roleDefault: string): Harness {
	let pool = initial;
	const settings = Settings.isolated({ modelRoles: { default: roleDefault } });
	const readModels = (): Model[] => pool;
	const registry = {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: readModels,
		getAll: readModels,
		find: (provider: string, id: string) => pool.find(m => m.provider === provider && m.id === id),
		getDiscoverableProviders: () => ["lithosai"],
		getProviderDiscoveryState: () => undefined,
		authStorage: { keys: { source: () => undefined } },
	} as unknown as ModelRegistry;
	const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const onAssign = vi.fn(() => true);
	const onUnassign = vi.fn();
	const hub = new ModelHubComponent(ui, createModelBrowserSource(settings), registry, [], {
		onAssign,
		onUnassign,
		onLoginRequest: () => {},
		onCancel: () => {},
	});
	openHubs.push(hub);
	return {
		hub,
		settings,
		onAssign,
		onUnassign,
		setPool: models => {
			pool = models;
			hub.refreshAfterExternalMutation();
		},
	};
}

describe("model hub role strip", () => {
	beforeAll(async () => {
		if (!testTheme) throw new Error("dark theme unavailable");
		setThemeInstance(testTheme);
	});

	afterEach(() => {
		for (const hub of openHubs.splice(0)) hub.dispose();
	});

	test("does not offer to re-assign a configured role whose model is transiently unavailable", () => {
		const lithosai = makeModel("lithosai", "deepseek-ai/DeepSeek-V4.1-Flash-fast");
		const other = makeModel("openai", "gpt-5");
		const harness = createHarness([lithosai, other], "lithosai/deepseek-ai/DeepSeek-V4.1-Flash-fast");

		// The provider's roster is pruned mid-refresh; the configured role is
		// still persisted but no longer resolves.
		harness.setPool([other]);
		expect(harness.settings.getModelRole("default")).toBe("lithosai/deepseek-ai/DeepSeek-V4.1-Flash-fast");

		// Open the role strip on the surviving model and walk every chip,
		// pressing Enter on any whose label names the `default` role.
		harness.hub.handleInput("\r");
		harness.hub.handleInput("\r");

		expect(harness.onUnassign).not.toHaveBeenCalledWith("default");
		expect(harness.settings.getModelRole("default")).toBe("lithosai/deepseek-ai/DeepSeek-V4.1-Flash-fast");
	});

	test("roles view reports a configured-but-unavailable role as configured, not cleared", () => {
		const lithosai = makeModel("lithosai", "deepseek-ai/DeepSeek-V4.1-Flash-fast");
		const other = makeModel("openai", "gpt-5");
		const harness = createHarness([lithosai, other], "lithosai/deepseek-ai/DeepSeek-V4.1-Flash-fast");

		harness.setPool([other]);
		harness.hub.handleInput("\x1b[A");
		const text = harness.hub.render(200).map(stripVTControlCharacters).join("\n");
		const defaultRow = text.split("\n").find(line => line.includes("DEFAULT"));
		expect(defaultRow).toBeDefined();
		// "—" is the hub's rendering of "no role configured": that is the lie.
		expect(defaultRow).not.toContain("—");
	});
});
