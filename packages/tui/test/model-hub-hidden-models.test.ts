import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerProps, TspSpan } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild } from "../src/native/node";
import { ModelHubComponent, type ModelHubRegistry, type ModelHubSource } from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/tui";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const NOTE = "522 openrouter models hidden by your account settings";
const withPicker: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const withoutPicker: DescribeContext = { ...withPicker, supports: kind => kind !== "picker" };
const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;

const MODELS: Model[] = ["openrouter", "anthropic"].map(provider =>
	buildModel({
		id: `${provider}-chat`,
		name: `${provider}-chat`,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	}),
);

const source: ModelHubSource = {
	revision: 0,
	defaultThinkingLevel: "off",
	modelProviderOrder: [],
	knownRoleIds: ["default"],
	mruOrder: [],
	modelPerf: new Map(),
	getRoleInfo: role => ({ tag: role, name: role, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
	getModelRole: () => undefined,
	disabledProviders: [],
	fallbackChains: {},
	modelRoleStorage: "global",
	cycleOrder: [],
	getProjectModelRole: () => undefined,
	getGlobalModelRole: () => undefined,
	getModelRoleSource: () => "default",
};

const hubs: ModelHubComponent[] = [];
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
});
beforeAll(async () => {
	await initTheme(false);
});

function openHub(hiddenChatModelCount: number, initialProviderId?: string): ModelHubComponent {
	const registry: ModelHubRegistry = {
		getError: () => undefined,
		getAvailable: () => MODELS,
		getAll: () => MODELS,
		authStorage: { keys: { source: () => undefined } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: provider =>
			provider === "openrouter" ? { optional: false, status: "ok", hiddenChatModelCount } : undefined,
		find: (provider, id) => MODELS.find(model => model.provider === provider && model.id === id),
		refresh: async () => {},
		refreshProvider: async () => {},
	};
	const hub = new ModelHubComponent(
		ui,
		source,
		registry,
		MODELS.map(model => ({ model })),
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
		{ initialProviderId },
	);
	hubs.push(hub);
	return hub;
}

function nativeText(child: NativeChild): string {
	if (!("k" in child)) return "";
	const spans: unknown = child.p ? Reflect.get(child.p, "spans") : undefined;
	const own = Array.isArray(spans) ? spans.map((part: TspSpan) => part.t).join("") : "";
	return [own, ...(child.c ?? []).map(nativeText)].join("\n");
}

function renderedPaths(hub: ModelHubComponent) {
	const subtitle = (hub.describe(withPicker).p as TspPickerProps).subtitle;
	return {
		ansi: hub.render(160).join("\n").replace(ANSI_PATTERN, ""),
		native: nativeText(hub.describe(withoutPicker)),
		picker: Array.isArray(subtitle) ? subtitle.map(part => part.t).join("") : (subtitle ?? ""),
	};
}

describe("model hub account-hidden model note (#15794)", () => {
	test.each([
		["the provider scope", "openrouter"],
		["All models", undefined],
	])("names the hidden count in every render path under %s", (_scope, initialProviderId) => {
		const paths = renderedPaths(openHub(522, initialProviderId));

		expect(paths.ansi).toContain(NOTE);
		expect(paths.native).toContain(NOTE);
		expect(paths.picker).toContain(NOTE);
	});

	test("shows no note when the account hides nothing", () => {
		const paths = renderedPaths(openHub(0, "openrouter"));

		expect(paths.ansi).not.toContain("hidden by your account settings");
		expect(paths.native).not.toContain("hidden by your account settings");
		expect(paths.picker).not.toContain("hidden by your account settings");
	});
});
