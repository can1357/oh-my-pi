import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { Extension, TodoBackendDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { type JSXNode, type KeyEvent, signal, type TextEdit, type UiNode } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import * as themeLoader from "@oh-my-pi/pi-tui/theme/loader";
import type { SubmenuOption } from "../src/config/settings-defs";
import * as usageDashboardModule from "../src/ui/overlays/panels/usage-dashboard";
import * as agentsHubModule from "../src/ui/overlays/pickers/agents-hub";
import * as modelPickerModule from "../src/ui/overlays/pickers/model-picker";
import * as settingsModule from "../src/ui/overlays/settings/settings";
import type { TspPrefsSection } from "@oh-my-pi/pi-wire";
import { cfgTerminalShowProgress } from "../src/modes/settings";
import { Overlays } from "../src/ui/shell/overlays";
import { initTheme } from "../src/ui/theme/service";
import { nativeShell } from "./helpers/native-shell";
import { corpusStatusFacts } from "./ui/status/fixture";

/** A screen standing in for a menu's view: one `picker` node. */
function screen(): JSXNode {
	return jsx("picker", {});
}

/** A shell whose overlays are the real stack, focus a plain signal. */
function shellContext(extra: Record<string, unknown> = {}) {
	const focused = signal<UiNode | null>(null);
	const home = jsx("col", {}) as UiNode;
	const overlays = new Overlays({ focused, focus: node => focused.set(node), fallback: () => home });
	const ctx = {
		shell: {
			overlays,
			focused,
			focus: (node: UiNode | null) => focused.set(node ?? home),
			size: () => ({ columns: 120, rows: 40 }),
			native: () => false,
		},
		settings: Settings.instance,
		keybindings: { keysFor: () => [] },
		statusLine: { previewSettings: vi.fn() },
		...extra,
	} as unknown as InteractiveModeContext;
	return { ctx, overlays, focused };
}

const pickerSession = {
	model: undefined,
	scopedModels: [],
	configuredThinkingLevel: () => undefined,
	autoResolvedThinkingLevel: () => undefined,
	getContextUsage: () => undefined,
	effectiveServiceTier: () => undefined,
	getRoleModelCycle: () => undefined,
	modelRegistry: {
		getError: () => undefined,
		getAvailable: () => [],
		getAll: () => [],
		refreshIfStale: async () => false,
	},
};

describe("single-instance menus", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		initTheme();
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
		spyOn(themeLoader, "listThemes").mockReturnValue(themes);
		const windows = spyOn(settingsModule, "SettingsWindow").mockImplementation(() => jsx("prefs", {}));
		const { ctx, overlays, focused } = shellContext({
			session: { getAvailableThinkingLevels: () => [], getAvailableModels: () => [] },
		});
		const controller = new SelectorController(ctx);

		controller.showSettingsSelector();
		controller.showSettingsSelector();
		// The controller's continuation was queued first, so the menu is mounted.
		await themes;
		expect(windows).toHaveBeenCalledTimes(1);
		const menu = overlays.top();
		expect(menu?.node.kind).toBe("overlay");
		expect(menu?.node.props()).toMatchObject({ size: "full" });
		focused.set(null);
		controller.showSettingsSelector();
		expect(windows).toHaveBeenCalledTimes(1);
		expect(overlays.top()).toBe(menu);
		expect(focused()?.kind).toBe("prefs");
	});

	it("docks settings on an aside-capable terminal and returns the keys to the clicked field or prefs", async () => {
		await using ui = await nativeShell();
		const themes = Promise.resolve(["dark"]);
		spyOn(themeLoader, "listThemes").mockReturnValue(themes);
		const text = signal("");
		ui.shell.dock.slot("composer").set(() =>
			jsx("editor", {
				text,
				cursor: () => text().length,
				onEdit: (edit: TextEdit) => text.set(text().slice(0, edit.from) + edit.text + text().slice(edit.to)),
			}),
		);
		const ctx = {
			shell: ui.shell,
			session: { getAvailableThinkingLevels: () => [], getAvailableModels: () => [] },
			statusLine: { previewSettings: () => {}, facts: corpusStatusFacts, settings: () => ({}) },
			statusLinePreviewRow: () => "",
		} as unknown as InteractiveModeContext;
		new SelectorController(ctx).showSettingsSelector();
		await themes;
		const prefs = ui.node("prefs");
		expect(prefs.parent).toBe("layer");
		const sections = prefs.p.sections as TspPrefsSection[];
		const progress = sections.flatMap(section => section.rows).find(row => row.id === cfgTerminalShowProgress.id)!;
		expect(progress.control).toEqual({ k: "switch", on: false });
		ui.send({ ev: "change", sf: ui.sf, id: prefs.id, item: progress.id, value: true });
		expect(cfgTerminalShowProgress.get(Settings.instance)).toBe(true);
		ui.send({ ev: "change", sf: ui.sf, id: prefs.id, item: progress.id, value: null });
		expect(cfgTerminalShowProgress.get(Settings.instance)).toBe(false);
		ui.send({ ev: "focus", sf: ui.sf, id: ui.node("editor").id });
		ui.type("draft");
		expect(text()).toBe("draft");
		ui.send({ ev: "focus", sf: ui.sf, id: prefs.id });
		ui.type("theme");
		expect(ui.node("prefs").p.query).toBe("theme");
		expect(text()).toBe("draft");
	});

	it("offers Native, then each todo backend under its label (or its id) with its description, once startup-deferred extensions have bound", async () => {
		spyOn(themeLoader, "listThemes").mockResolvedValue(["dark"]);
		const opened = Promise.withResolvers<settingsModule.SettingsContext>();
		spyOn(settingsModule, "SettingsWindow").mockImplementation(props => {
			opened.resolve(props.context);
			return jsx("prefs", {});
		});
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
		const { ctx } = shellContext({
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
		});

		new SelectorController(ctx).showSettingsSelector();
		const context = await opened.promise;
		const options = context.runtimeOptions?.get("todo.backend") as readonly SubmenuOption[] | undefined;

		expect(options?.[0]?.value).toBe("native");
		expect(options?.slice(1)).toEqual([
			{ value: "tracker", label: "Tracker", description: "Mirrors todos" },
			{ value: "plain", label: "plain", description: undefined },
		]);
	});

	// Regression: clicking Tern's composer model chip again while the picker was
	// still opening (or already open) stacked another picker per click.
	it("opens one model picker per close, focusing it on repeat requests", () => {
		const pickers: modelPickerModule.ModelPickerProps[] = [];
		spyOn(modelPickerModule, "ModelPicker").mockImplementation(props => {
			pickers.push(props);
			return screen();
		});
		const { ctx, overlays, focused } = shellContext({ session: pickerSession, viewSession: pickerSession });
		const controller = new SelectorController(ctx);

		controller.showModelSelector({ temporaryOnly: true });
		focused.set(null);
		controller.showModelSelector({ temporaryOnly: true });
		expect(pickers).toHaveLength(1);
		expect(focused()?.kind).toBe("picker");

		pickers[0]?.callbacks.onCancel();
		expect(overlays.open()).toBe(false);
		controller.showModelSelector({ temporaryOnly: true });
		expect(pickers).toHaveLength(2);
	});

	it("mounts the searchable session picker directly in Tern's layer so its sheet can fit the composer", () => {
		const { ctx, overlays, focused } = shellContext({ session: pickerSession, viewSession: pickerSession });
		spyOn(ctx.shell, "native").mockReturnValue(true);
		new SelectorController(ctx).showModelSelector({ temporaryOnly: true });

		// The native picker positions its sheet relative to the layer, not an enclosing dialog's body.
		const root = overlays.nodes()[0]!;
		expect(root.kind).toBe("picker");
		expect(focused()).toBe(root);
		root.handlers.onKey?.({ id: "p", text: "p", kind: "press", raw: "p" });
		expect(root.props()).toMatchObject({ anchor: "composer", query: "p" });
		overlays.closeAll();
	});

	it("raises an open model picker another overlay covers instead of focusing it hidden", () => {
		spyOn(modelPickerModule, "ModelPicker").mockImplementation(() => screen());
		const { ctx, overlays } = shellContext({ session: pickerSession, viewSession: pickerSession });
		const controller = new SelectorController(ctx);
		controller.showModelSelector({ temporaryOnly: true });
		const picker = overlays.top();
		overlays.show(() => jsx("col", {}));

		controller.showModelSelector({ temporaryOnly: true });
		expect(overlays.nodes()).toHaveLength(2);
		expect(overlays.top()).toBe(picker);
	});

	it("opens one agents dashboard while it loads, and opens again after a failed load", async () => {
		const failed = Promise.withResolvers<void>();
		let load: () => Promise<void> = () => failed.promise;
		const hubs = spyOn(agentsHubModule, "AgentsHub").mockImplementation(props => {
			props.ref?.({ reload: () => load(), onKey: () => false });
			return screen();
		});
		const { ctx, overlays } = shellContext({
			session: { model: undefined, modelRegistry: {}, effectiveExtensionRoots: [] },
		});
		const controller = new SelectorController(ctx);

		const first = controller.showAgentsDashboard();
		await controller.showAgentsDashboard();
		expect(hubs).toHaveBeenCalledTimes(1);
		failed.reject(new Error("discovery failed"));
		await expect(first).rejects.toThrow("discovery failed");
		expect(overlays.open()).toBe(false);

		load = async () => {};
		await controller.showAgentsDashboard();
		expect(hubs).toHaveBeenCalledTimes(2);
		expect(overlays.nodes()).toHaveLength(1);
	});

	// Regression: a second /usage (or status-line cost click) while the dashboard
	// was open stacked another fullscreen dashboard on top of the first.
	it("opens one usage dashboard per close, focusing it on repeat requests", () => {
		spyOn(activityClient, "loadDailyActivity").mockResolvedValue(undefined);
		const dashboards = spyOn(usageDashboardModule, "UsageDashboard").mockImplementation(() => jsx("col", {}));
		const { ctx, overlays, focused } = shellContext({
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
		});
		const controller = new SelectorController(ctx);
		const reports = [{ provider: "anthropic", fetchedAt: Date.now(), limits: [] }];

		controller.showUsageDashboard(reports);
		const layer = overlays.top();
		focused.set(null);
		controller.showUsageDashboard(reports);
		expect(dashboards).toHaveBeenCalledTimes(1);
		expect(focused()).toBe(layer?.node ?? null);

		// Esc reaches the dashboard through its layer and closes it.
		const escape: KeyEvent = { id: "escape", kind: "press", raw: "\x1b" };
		layer?.node.handlers.onKey?.(escape);
		expect(overlays.open()).toBe(false);
		controller.showUsageDashboard(reports);
		expect(dashboards).toHaveBeenCalledTimes(2);
	});
});
