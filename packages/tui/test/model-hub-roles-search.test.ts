/**
 * The Roles view's letter commands (`s` save preset, `f` fallback, …) must not
 * swallow a search: the picker offers no search field while they own the
 * keys, and once a query is live, typing keeps editing it.
 */
import { beforeAll, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "../src/native/node";
import {
	ModelHubComponent,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";

const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

const sonnet = buildModel({
	id: "claude-sonnet",
	name: "claude-sonnet",
	api: "ollama-chat",
	provider: "anthropic",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 1024,
});

const source: ModelHubSource = {
	revision: 0,
	disabledProviders: [],
	fallbackChains: {},
	modelRoleStorage: "global",
	cycleOrder: [],
	getProjectModelRole: () => undefined,
	getGlobalModelRole: () => undefined,
	getModelRoleSource: () => "default",
	defaultThinkingLevel: "high",
	modelProviderOrder: [],
	knownRoleIds: ["default"],
	mruOrder: [],
	modelPerf: new Map(),
	getModelRole: () => undefined,
	getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
};

const registryStub: ModelHubRegistry = {
	getError: () => undefined,
	getAvailable: () => [],
	getAll: () => [],
	authStorage: { keys: { source: () => undefined } },
	getDiscoverableProviders: () => [],
	getProviderDiscoveryState: () => undefined,
	find: () => undefined,
	refresh: async () => {},
	refreshProvider: async () => {},
};

function createHub(): ModelHubComponent {
	const callbacks: ModelHubCallbacks = {
		onAssign: () => true,
		onUnassign: () => {},
		onCancel: () => {},
		onSavePreset: () => {},
	};
	return new ModelHubComponent(tuiStub, source, registryStub, [{ model: sonnet }], callbacks);
}

function pickerProps(hub: ModelHubComponent): TspPickerProps {
	const root = hub.describe(pickerCx);
	if (root?.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root?.k}`);
	return root.p;
}

/** A click on the sidebar's Roles entry: a deliberate dive into the rows. */
const CLICK_ROLES = { type: "select", key: "scopes", item: "roles" } as const;

beforeAll(async () => {
	await initTheme(false);
});

test("with no query the Roles rows hide the search field and keep their letter commands", () => {
	const hub = createHub();
	hub.handleNativeEvent(CLICK_ROLES);
	expect(pickerProps(hub).query).toBeNull();

	hub.handleInput("s");
	expect(pickerProps(hub).strip).not.toBeNull();
});

test("a live query keeps taking printable keys on the Roles rows", () => {
	const hub = createHub();
	for (const ch of "son") hub.handleInput(ch);
	hub.handleNativeEvent(CLICK_ROLES);
	expect(pickerProps(hub).query).toBe("son");

	hub.handleInput("n");
	hub.handleInput("e");
	const props = pickerProps(hub);
	expect(props.strip).toBeNull();
	expect(props.query).toBe("sonne");
	expect(props.scope).toBe("all");
});
