import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ModelHubCallbacks,
	ModelHubComponent,
	resetProviderAutoRefreshGuard,
} from "@oh-my-pi/pi-coding-agent/modes/components/model-hub";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

// Issue #2761: implicit local providers (ollama, llama.cpp, lm-studio) used to
// get a sidebar tab even when nothing was listening on their endpoint. The hub
// must hide optional discoverable providers whose discovery is "idle" or
// "unavailable", keep explicitly configured or authed providers visible, and
// re-probe the hidden ones once per open so a freshly started server
// resurfaces its tab.

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

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
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

function discoveryState(provider: string, status: string, optional = true): unknown {
	return { provider, status, optional, stale: false, models: [] };
}

interface RegistrySpec {
	models: () => Model[];
	discoverable?: string[];
	discovery?: (providerId: string) => unknown;
	hasAuth?: (providerId: string) => boolean;
	refresh?: (mode: string) => Promise<void>;
}

function makeRegistry(spec: RegistrySpec): ModelRegistry {
	return {
		refresh: spec.refresh ?? (async () => {}),
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: spec.models,
		getAll: spec.models,
		getDiscoverableProviders: () => spec.discoverable ?? [],
		getProviderDiscoveryState: spec.discovery ?? (() => undefined),
		authStorage: { hasAuth: spec.hasAuth ?? (() => false) },
	} as unknown as ModelRegistry;
}

const openHubs: ModelHubComponent[] = [];

function createHub(registry: ModelRegistry): ModelHubComponent {
	const settings = Settings.isolated({});
	const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const callbacks: ModelHubCallbacks = {
		onAssign: () => {},
		onUnassign: () => {},
		onLoginRequest: () => {},
		onCancel: () => {},
	};
	const hub = new ModelHubComponent(ui, settings, registry, [], callbacks);
	openHubs.push(hub);
	return hub;
}

/** Flush the constructor's offline-refresh promise chain and any re-probes. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Bun.sleep(0);
	}
}

describe("issue #2761: unconfigured local providers in the Model Hub sidebar", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load dark theme for ModelHub tests");
		setThemeInstance(theme);
	});

	afterEach(() => {
		resetProviderAutoRefreshGuard();
		for (const hub of openHubs.splice(0)) {
			hub.dispose();
		}
	});

	test("hides an implicit local provider whose discovery never ran (idle)", async () => {
		const hub = createHub(
			makeRegistry({
				models: () => [makeModel("prov-a", "model-a")],
				discoverable: ["lm-studio"],
				discovery: id => discoveryState(id, "idle"),
			}),
		);
		await settle();
		const rendered = normalize(hub.render(220));
		expect(rendered).toContain("prov-a");
		expect(rendered).not.toContain("lm-studio");
	});

	test("hides an implicit local provider whose endpoint is unreachable (unavailable)", async () => {
		const hub = createHub(
			makeRegistry({
				models: () => [makeModel("prov-a", "model-a")],
				discoverable: ["lm-studio"],
				discovery: id => discoveryState(id, "unavailable"),
			}),
		);
		await settle();
		expect(normalize(hub.render(220))).not.toContain("lm-studio");
	});

	test("keeps a reachable local provider visible even when it serves zero models (empty)", async () => {
		const hub = createHub(
			makeRegistry({
				models: () => [makeModel("prov-a", "model-a")],
				discoverable: ["lm-studio"],
				discovery: id => discoveryState(id, "empty"),
			}),
		);
		await settle();
		expect(normalize(hub.render(220))).toContain("lm-studio");
	});

	test("keeps an explicitly configured discovery provider visible when unreachable", async () => {
		// models.yml discovery providers carry optional: false; hiding them
		// would bury a misconfigured baseUrl instead of surfacing it.
		const hub = createHub(
			makeRegistry({
				models: () => [makeModel("prov-a", "model-a")],
				discoverable: ["my-endpoint"],
				discovery: id => discoveryState(id, "unavailable", false),
			}),
		);
		await settle();
		expect(normalize(hub.render(220))).toContain("my-endpoint");
	});

	test("keeps a discoverable provider with stored auth visible", async () => {
		const hub = createHub(
			makeRegistry({
				models: () => [makeModel("prov-a", "model-a")],
				discoverable: ["lm-studio"],
				discovery: id => discoveryState(id, "unavailable"),
				hasAuth: id => id === "lm-studio",
			}),
		);
		await settle();
		expect(normalize(hub.render(220))).toContain("lm-studio");
	});

	test("keeps a discoverable provider visible when discovery state is unknown", async () => {
		// Fail open: no recorded discovery state means the registry has not
		// probed at all yet, so the tab stays until discovery says otherwise.
		const hub = createHub(
			makeRegistry({
				models: () => [makeModel("prov-a", "model-a")],
				discoverable: ["lm-studio"],
				discovery: () => undefined,
			}),
		);
		await settle();
		expect(normalize(hub.render(220))).toContain("lm-studio");
	});

	test("the online refresh resurfaces a hidden local when its server appears", async () => {
		let serving = false;
		const probed: string[] = [];
		const hub = createHub(
			makeRegistry({
				models: () => {
					if (serving) return [makeModel("prov-a", "model-a"), makeModel("lm-studio", "local-model")];
					return [makeModel("prov-a", "model-a")];
				},
				discoverable: ["lm-studio"],
				discovery: id => discoveryState(id, serving ? "ok" : "unavailable"),
				refresh: async mode => {
					probed.push(mode);
					serving = true;
				},
			}),
		);
		await settle();
		expect(probed).toEqual(["online"]);
		const rendered = normalize(hub.render(220));
		expect(rendered).toContain("lm-studio");
		expect(rendered).toContain("local-model");
	});

	test("does not refresh a hidden local that stays down more than once when the hub opens", async () => {
		const probed: string[] = [];
		const hub = createHub(
			makeRegistry({
				models: () => [makeModel("prov-a", "model-a")],
				discoverable: ["lm-studio"],
				discovery: id => discoveryState(id, "unavailable"),
				refresh: async mode => {
					probed.push(mode);
				},
			}),
		);
		await settle();
		expect(probed).toEqual(["online"]);
		expect(normalize(hub.render(220))).not.toContain("lm-studio");
	});
});
