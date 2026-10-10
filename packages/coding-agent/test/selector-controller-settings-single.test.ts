import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { AgentsHubComponent } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import * as sessionPins from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
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
		};
	};
	return { shown, setFocus, overlayStack, ui: { overlayStack, setFocus, showOverlay } };
}

/** A context whose model picker reads a supplied current catalog. */
function pickerContext(ui: OverlayUi, models: Model[] = [], current?: Model) {
	return createInteractiveModeContext({
		session: {
			model: current,
			scopedModels: [],
			getContextUsage: () => undefined,
			effectiveServiceTier: () => undefined,
			getRoleModelCycle: () => undefined,
			setModelTemporary: vi.fn(async () => {}),
			applyRoleModel: vi.fn(async () => {}),
			modelRegistry: {
				getError: () => undefined,
				getAvailable: () => models,
				getAll: () => models,
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
					return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
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

	it("selects a seance source without resuming or offering deletion", async () => {
		const session: SessionInfo = {
			path: "/repo/.omp/sessions/source.jsonl",
			id: "source",
			cwd: "/repo",
			created: new Date(1),
			modified: new Date(2),
			messageCount: 1,
			size: 16,
			firstMessage: "Inspect the old session",
			allMessagesText: "Inspect the old session",
		};
		spyOn(SessionManager, "listForPicker").mockResolvedValue([session]);
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());
		const { ui, shown, overlayStack } = overlayUi();
		const ctx = createInteractiveModeContext({
			ui: { ...ui, terminal: { rows: 24 } },
			session: { switchSession: vi.fn(async () => true) },
			sessionManager: {
				getCwd: () => "/repo",
				getSessionDir: () => "/repo/.omp/sessions",
				getSessionFile: () => undefined,
			},
		});
		const controller = new SelectorController(ctx);
		const resume = spyOn(controller, "handleResumeSession").mockResolvedValue(true);
		const overlayCountAtSelection: number[] = [];
		const selected = vi.fn(async (_session: SessionInfo) => {
			overlayCountAtSelection.push(overlayStack.length);
		});

		await controller.showSessionSelector(undefined, selected);

		const selector = shown[0] as SessionSelectorComponent<SessionInfo>;
		const rendered = selector.render(80);
		const footer = rendered.slice(-4).join("\n");
		expect(footer).not.toMatch(/delete|backspace/i);
		selector.handleInput("\x7f");
		expect(selector.render(80).join("\n")).not.toContain("Delete session?");
		selector.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();

		expect(selected).toHaveBeenCalledWith(session);
		expect(overlayCountAtSelection).toEqual([0]);
		expect(resume).not.toHaveBeenCalled();
		expect(ctx.session.switchSession).not.toHaveBeenCalled();
	});

	it("returns a chosen model without changing host, role, or Task defaults", async () => {
		const { ui, shown } = overlayUi();
		const model = createMockModel({ provider: "openai", id: "seance-model" }).model;
		const hostModel = createMockModel({ provider: "anthropic", id: "host-model" }).model;
		const ctx = pickerContext(ui, [model], hostModel);
		const taskDefaults = structuredClone(cfgTaskAgentModelOverrides.get(ctx.settings));
		const selected = vi.fn();
		const controller = new SelectorController(ctx);

		controller.showModelSelector({
			selectOnly: { currentSelector: `${model.provider}/${model.id}`, onSelect: selected },
		});

		const picker = shown[0]!;
		picker.handleInput?.("\r");
		await Promise.resolve();

		expect(selected).toHaveBeenCalledWith(`${model.provider}/${model.id}`);
		expect(ctx.session.model).toBe(hostModel);
		expect(ctx.session.setModelTemporary).not.toHaveBeenCalled();
		expect(ctx.session.applyRoleModel).not.toHaveBeenCalled();
		expect(cfgTaskAgentModelOverrides.get(ctx.settings)).toEqual(taskDefaults);
		const onCancel = vi.fn();
		controller.showModelSelector({
			selectOnly: { currentSelector: `${model.provider}/${model.id}`, onSelect: selected, onCancel },
		});
		shown[1]?.handleInput?.("\x1b");
		await Promise.resolve();
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(selected).toHaveBeenCalledTimes(1);
	});
});
