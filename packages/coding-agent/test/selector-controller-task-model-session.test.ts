import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { Component, NativeUiEvent, OverlayHandle, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";

import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

import * as themeModule from "@oh-my-pi/pi-tui/theme";

/** The overlay members `ui` the picker reads and drives. */
interface OverlayUi {
	overlayStack: TUI["overlayStack"];
	setFocus: (component: Component | null) => void;
	showOverlay: (component: Component, options?: OverlayOptions) => OverlayHandle;
}

/** A `ui` whose overlays live on `overlayStack` as TUI's do: shown on top, removed on hide. */
function overlayUi(): { ui: OverlayUi; shown: Component[] } {
	const overlayStack: TUI["overlayStack"] = [];
	const shown: Component[] = [];
	const showOverlay = (component: Component, _options?: OverlayOptions): OverlayHandle => {
		const entry = { component, options: undefined, preFocus: null, hidden: false, released: false };
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
	return { ui: { overlayStack, setFocus: vi.fn(), showOverlay }, shown };
}

/**
 * A picker-ready context on a shared `settings` instance, an `Alt+P` keybinding,
 * and a session whose id is mutable through `readSessionId`. The session captures
 * the resolver the controller registers, so a test can read the per-session task
 * pick the spawn path sees, keyed by the requesting session id.
 */
interface TaskResolver {
	(agentName: string, sessionId: string | null): string | string[] | undefined;
}

function taskPickerContext(
	ui: OverlayUi,
	models: Model[],
	current: Model | undefined,
	settings: Settings,
	readSessionId: () => string,
	resolver: { current?: TaskResolver },
) {
	return createInteractiveModeContext({
		settings,
		sessionManager: { getSessionId: readSessionId, getCwd: () => process.cwd() },
		session: {
			model: current,
			scopedModels: [],
			getContextUsage: () => undefined,
			effectiveServiceTier: () => undefined,
			getRoleModelCycle: () => undefined,
			resolveTemporaryModelThinkingLevel: () => undefined,
			setModelTemporary: vi.fn(async () => {}),
			applyRoleModel: vi.fn(async () => {}),
			registerSessionTaskModelResolver: (fn: TaskResolver) => {
				resolver.current = fn;
				return () => {
					if (resolver.current === fn) resolver.current = undefined;
				};
			},
			modelRegistry: {
				getError: () => undefined,
				getAvailable: () => models,
				getAll: () => models,
				refreshIfStale: async () => false,
			},
		},
		ui,
		keybindings: { getKeys: () => ["alt+p"], getDisplayString: () => "" },
	});
}

const taskEvent = { type: "action", key: "", act: "task", mods: [] } satisfies NativeUiEvent;

describe("session-scoped task model pick", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false);
	});

	afterAll(() => {
		resetSettingsForTest();
	});
	// Regression: a Task-subagent model pick (Alt+P) used to write the runtime
	// override onto the shared root settings, so every concurrent session —
	// including the default — spawned its subagents on the picked model. The pick
	// is now keyed by session id on the controller and read through the resolver
	// the session registers, so a session sharing the root Settings never sees it.
	test("a task pick records the pick for its session only, never the shared settings", () => {
		const settings = Settings.isolated();
		const taskModel = createMockModel({ provider: "openai", id: "task-target" }).model;
		const hostModel = createMockModel({ provider: "anthropic", id: "host-model" }).model;
		const selector = `${taskModel.provider}/${taskModel.id}`;

		const resolver: { current?: TaskResolver } = {};
		const sessionId = "session-a";
		const { ui, shown } = overlayUi();
		const ctx = taskPickerContext(ui, [taskModel], hostModel, settings, () => sessionId, resolver);
		const controller = new SelectorController(ctx);

		// Session A starts unpicked: no pick recorded, no persisted `task` entry.
		expect(resolver.current!("task", "session-a")).toBeUndefined();
		expect(cfgTaskAgentModelOverrides.get(settings).task).toBeUndefined();

		// Pick the task model while viewing session A.
		controller.showModelSelector({ temporaryOnly: true });
		const picker = shown[0]!;
		picker.handleNativeEvent?.(taskEvent); // Alt+P: toggle to task-model target
		picker.handleNativeEvent?.({ type: "activate", key: "", item: selector } satisfies NativeUiEvent);

		// The pick is recorded for session A; the shared settings override is never written.
		expect(resolver.current!("task", "session-a")).toBe(selector);
		expect(cfgTaskAgentModelOverrides.get(settings).task).toBeUndefined();

		// A concurrent session reading the resolver for its own id gets no pick,
		// and the resolver answers only the task agent.
		expect(resolver.current!("task", "session-b")).toBeUndefined();
		expect(resolver.current!("coder", "session-a")).toBeUndefined();
	});

	// A pick equal to the persisted task model is recorded for the session, the
	// persisted entry stays intact, and no runtime override is stacked on the
	// shared settings. A session without a pick reads the persisted value.
	test("a session pick matching the persisted task model leaves the persisted entry readable", () => {
		const settings = Settings.isolated();
		cfgTaskAgentModelOverrides.set(settings, { task: "openai/persisted-task" });
		const taskModel = createMockModel({ provider: "openai", id: "persisted-task" }).model;
		const selector = `${taskModel.provider}/${taskModel.id}`;

		const resolver: { current?: TaskResolver } = {};
		const sessionId = "session-a";
		const { ui, shown } = overlayUi();
		const ctx = taskPickerContext(ui, [taskModel], undefined, settings, () => sessionId, resolver);
		const controller = new SelectorController(ctx);

		controller.showModelSelector({ temporaryOnly: true });
		const picker = shown[0]!;
		picker.handleNativeEvent?.(taskEvent);
		picker.handleNativeEvent?.({ type: "activate", key: "", item: selector } satisfies NativeUiEvent);

		// Session A's pick is recorded; the persisted entry stays, no override written.
		expect(resolver.current!("task", "session-a")).toBe(selector);
		expect(cfgTaskAgentModelOverrides.get(settings).task).toBe("openai/persisted-task");

		// A session with no pick (B) reads the persisted value through settings.
		expect(resolver.current!("task", "session-b")).toBeUndefined();
	});

	// Persisting an agent's model through `/agents` is the user committing that
	// choice; the reconciliation drops the session pick so the saved entry wins,
	// not a stale Alt+P pick.
	test("persisting a task model through the agents hub drops the session pick", () => {
		const settings = Settings.isolated();
		cfgTaskAgentModelOverrides.set(settings, { task: "openai/persisted-task" });
		const taskModel = createMockModel({ provider: "openai", id: "task-target" }).model;
		const selector = `${taskModel.provider}/${taskModel.id}`;

		const resolver: { current?: TaskResolver } = {};
		const sessionId = "session-a";
		const { ui, shown } = overlayUi();
		const ctx = taskPickerContext(ui, [taskModel], undefined, settings, () => sessionId, resolver);
		const controller = new SelectorController(ctx);

		controller.showModelSelector({ temporaryOnly: true });
		const picker = shown[0]!;
		picker.handleNativeEvent?.(taskEvent);
		picker.handleNativeEvent?.({ type: "activate", key: "", item: selector } satisfies NativeUiEvent);
		expect(resolver.current!("task", "session-a")).toBe(selector);

		// `/agents` persists a task model for session A; the pick is dropped.
		controller.reconcilePersistedAgentModel("task");
		expect(resolver.current!("task", "session-a")).toBeUndefined();
		expect(cfgTaskAgentModelOverrides.get(settings).task).toBe("openai/persisted-task");
	});
});
