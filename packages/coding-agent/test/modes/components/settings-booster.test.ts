import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { TYPESAFE_PROVIDER } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

beforeAll(async () => {
	await initTheme();
});

let auth: AuthStorage;
let registry: ModelRegistry;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	auth = createInMemoryAuthStorage();
	registry = new ModelRegistry(auth);
});

afterEach(() => {
	vi.restoreAllMocks();
	auth.close();
	resetSettingsForTest();
});

function openBooster(): SettingsSelectorComponent {
	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(registry),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	for (const char of "jev compaction booster") selector.handleInput(char);
	return selector;
}

function clickBooster(selector: SettingsSelectorComponent): void {
	const rows = selector.render(100);
	const row = rows.findIndex(line => line.includes("Jev Compaction Booster"));
	if (row < 0) throw new Error("Booster must remain a searchable row");
	// SGR coordinates are one-based. Click the setting pane, not a section sidebar.
	selector.handleInput(`\x1b[<0;50;${row + 1}M`);
	selector.handleInput(`\x1b[<0;50;${row + 1}M`);
}

describe("Jev booster settings eligibility", () => {
	it("keeps unavailable settings searchable and rejects keyboard and mouse activation without probing credentials", () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		const selector = openBooster();
		const output = selector.render(100).join("\n");
		expect(output).toContain("/login typesafe");
		selector.handleInput("\n");
		clickBooster(selector);
		expect(settings.get("compaction.boosterEnabled")).toBe(false);
		expect(fetch).not.toHaveBeenCalled();

		auth.setRuntimeApiKey(TYPESAFE_PROVIDER, "local-test-key");
		const available = openBooster();
		available.handleInput("\n");
		expect(settings.get("compaction.boosterEnabled")).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refreshes the live judgment gate and permits disabling a saved preference after auth disappears", () => {
		auth.setRuntimeApiKey(TYPESAFE_PROVIDER, "local-test-key");
		settings.set("providers.judgmentProvider", "llm");
		const selector = openBooster();
		expect(selector.render(100).join("\n")).toContain("Auto or TypeSafe");
		selector.handleInput("\n");
		expect(settings.get("compaction.boosterEnabled")).toBe(false);

		settings.set("providers.judgmentProvider", "auto");
		// A search refresh rebuilds items from the same live host callbacks.
		selector.handleInput("\x7f");
		selector.handleInput("r");
		selector.handleInput("\n");
		expect(settings.get("compaction.boosterEnabled")).toBe(true);

		auth.removeRuntimeApiKey(TYPESAFE_PROVIDER);
		const unavailable = openBooster();
		expect(settings.get("compaction.boosterEnabled")).toBe(true);
		expect(unavailable.render(100).join("\n")).toContain("/login typesafe");
		unavailable.handleInput("\n");
		expect(settings.get("compaction.boosterEnabled")).toBe(false);
		unavailable.handleInput("\n");
		expect(settings.get("compaction.boosterEnabled")).toBe(false);
	});
});
