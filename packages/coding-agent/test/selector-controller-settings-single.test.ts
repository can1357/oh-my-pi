import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { Extension, TodoBackendDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";
import { AgentsHubComponent } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

/** The overlay members of `ui` the single-instance guard reads and drives. */
interface OverlayUi {
	overlayStack: TUI["overlayStack"];
	setFocus: (component: Component | null) => void;
	showOverlay: (component: Component, options?: OverlayOptions) => OverlayHandle;
}

/** A `ui` whose overlays live on `overlayStack` as TUI's do: shown on top, removed on hide. */
function overlayUi(): {
	ui: OverlayUi;
	shown: Component[];
	setFocus: OverlayUi["setFocus"];
	overlayStack: TUI["overlayStack"];
} {
	const overlayStack: TUI["overlayStack"] = [];
	const shown: Component[] = [];
	const setFocus = vi.fn<(component: Component | null) => void>();
	const showOverlay = (component: Component, options?: OverlayOptions): OverlayHandle => {
		const entry = { component, options, preFocus: null, hidden: false, released: false };
		overlayStack.push(entry);
		shown.push(component);
		return {
			hide: () => {
				const at = overlayStack.indexOf(entry);
				if (at >= 0) overlayStack.splice(at, 1);
			},
			setHidden: hidden => {
				entry.hidden = hidden;
			},
			isHidden: () => entry.hidden,
			isFocused: () => false,
		};
	};
	return { shown, setFocus, overlayStack, ui: { overlayStack, setFocus, showOverlay } };
}

function pickerContext(ui: OverlayUi) {
	return createInteractiveModeContext({
		session: {
			model: undefined,
			scopedModels: [],
			getContextUsage: () => undefined,
			effectiveServiceTier: () => undefined,
			getRoleModelCycle: () => undefined,
			modelRegistry: {
				getError: () => undefined,
				getAvailable: () => [],
				getAll: () => [],
				refreshIfStale: async () => false,
			},
		},
		ui,
		keybindings: { getKeys: () => [], getDisplayString: () => "" },
	});
}

describe("single-instance menus", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression: a second /settings (typed while theme discovery was pending, or
	// from Tern's native composer while the menu was open) stacked another
	// fullscreen settings menu on top of the first.
	it("focuses the open menu instead of stacking a second one", async () => {
		const themes = Promise.resolve(["dark"]);
		spyOn(themeModule, "getAvailableThemes").mockReturnValue(themes);
		const overlays: Component[] = [];
		const setFocus = vi.fn<(component: Component | null) => void>();
		const ctx = createInteractiveModeContext({
			session: { getAvailableThinkingLevels: () => [], getAvailableModels: () => [] },
			ui: {
				showOverlay: (component: Component, _options?: OverlayOptions): OverlayHandle => {
					overlays.push(component);
					return { hide: () => {}, setHidden: () => {}, isHidden: () => false, isFocused: () => false };
				},
				setFocus,
			},
		});
		const controller = new SelectorController(ctx);

		controller.showSettingsSelector();
		controller.showSettingsSelector();
		// The controller's continuation was queued first, so the menu is mounted.
		await themes;
		expect(overlays).toHaveLength(1);
		controller.showSettingsSelector();
		expect(overlays).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(overlays[0]);
	});

	it("offers Native, then each todo backend under its label (or its id) with its description, once startup-deferred extensions have bound", async () => {
		spyOn(themeModule, "getAvailableThemes").mockResolvedValue(["dark"]);
		const opened = Promise.withResolvers<Component>();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerTodoBackend({ id: "tracker", label: "Tracker", description: "Mirrors todos", replace() {} });
				pi.registerTodoBackend({ id: "plain", replace() {} });
			},
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
		);
		// The extension is startup-deferred: its backends register only when the session binds it.
		const backends = new Map<string, { extension: Extension; definition: TodoBackendDefinition }>();
		let pending = true;
		const ctx = createInteractiveModeContext({
			session: {
				getAvailableThinkingLevels: () => [],
				getAvailableModels: () => [],
				extensionRunner: { getTodoBackends: () => backends },
				get hasPendingDeferredExtensions() {
					return pending;
				},
				loadDeferredExtensions: async () => {
					for (const [id, definition] of extension.todoBackends ?? []) backends.set(id, { extension, definition });
					pending = false;
				},
			},
			ui: {
				showOverlay: (component: Component, _options?: OverlayOptions): OverlayHandle => {
					opened.resolve(component);
					return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
				},
				setFocus: () => {},
			},
		});

		new SelectorController(ctx).showSettingsSelector();
		const settings = await opened.promise;
		if (!(settings instanceof SettingsSelectorComponent)) throw new Error("the settings menu did not open");
		settings.handleNativeEvent({ type: "action", key: "", act: "page", value: "tools", mods: [] });
		const page = settings.describe({
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		});
		if (page.k !== "prefs" || !page.p) throw new Error(`described ${page.k}, not prefs`);
		const control = page.p.sections.flatMap(section => section.rows).find(row => row.id === "todo.backend")?.control;
		if (control?.k !== "choice") throw new Error("todo.backend is not a choice row");

		expect(control.options.slice(1)).toEqual([
			{ value: "tracker", label: "Tracker", detail: "Mirrors todos" },
			{ value: "plain", label: "plain", detail: undefined },
		]);
		expect(control.options[0]?.value).toBe("native");
	});

	// Regression: clicking Tern's composer model chip again while the picker was
	// still opening (or already open) stacked another picker per click.
	it("opens one model picker per close, focusing it on repeat requests", () => {
		const { ui, shown, setFocus } = overlayUi();
		const controller = new SelectorController(pickerContext(ui));

		controller.showModelSelector({ temporaryOnly: true });
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(shown[0]);

		shown[0]?.handleInput?.("\x1b");
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(2);
	});

	it("raises an open model picker another overlay covers instead of focusing it hidden", () => {
		const { ui, overlayStack } = overlayUi();
		const controller = new SelectorController(pickerContext(ui));
		controller.showModelSelector({ temporaryOnly: true });
		const picker = overlayStack[0]?.component;
		ui.showOverlay({ render: () => [], invalidate: () => {} });

		controller.showModelSelector({ temporaryOnly: true });
		expect(overlayStack).toHaveLength(2);
		expect(overlayStack.at(-1)?.component).toBe(picker);
	});

	it("opens one agents dashboard while it loads, and opens again after a failed load", async () => {
		const { ui, shown } = overlayUi();
		const controller = new SelectorController(createInteractiveModeContext({ ui }));
		const failed = Promise.withResolvers<AgentsHubComponent>();
		const create = spyOn(AgentsHubComponent, "create").mockReturnValue(failed.promise);

		const first = controller.showAgentsDashboard();
		await controller.showAgentsDashboard();
		expect(create).toHaveBeenCalledTimes(1);
		failed.reject(new Error("discovery failed"));
		await expect(first).rejects.toThrow("discovery failed");

		create.mockResolvedValue(Object.create(AgentsHubComponent.prototype));
		await controller.showAgentsDashboard();
		expect(create).toHaveBeenCalledTimes(2);
		expect(shown).toHaveLength(1);
	});

	// Regression: a second /usage (or status-line cost click) while the dashboard
	// was open stacked another fullscreen dashboard on top of the first.
	it("opens one usage dashboard per close, focusing it on repeat requests", () => {
		spyOn(activityClient, "loadDailyActivity").mockResolvedValue(undefined);
		const { ui, shown, setFocus } = overlayUi();
		const controller = new SelectorController(
			createInteractiveModeContext({
				session: {
					model: undefined,
					getUsageReportingModelSelectors: () => [],
					fetchUsageReports: async () => null,
					modelRegistry: {
						authStorage: {
							credentials: { all: () => ({}) },
							usage: { providerFor: () => undefined },
							oauth: { identity: () => undefined },
						},
					},
				},
				ui,
			}),
		);
		const reports = [{ provider: "anthropic", fetchedAt: Date.now(), limits: [] }];

		controller.showUsageDashboard(reports);
		controller.showUsageDashboard(reports);
		expect(shown).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(shown[0]);

		shown[0]?.handleInput?.("\x1b");
		controller.showUsageDashboard(reports);
		expect(shown).toHaveLength(2);
	});
});
