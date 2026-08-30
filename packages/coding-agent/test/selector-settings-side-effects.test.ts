import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ResolvedRoleModel } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { setTerminalHyperlinks, TERMINAL } from "@oh-my-pi/pi-tui";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("selector setting side effects", () => {
	it("refreshes the status line when git integration changes at runtime", () => {
		const updateSettings = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			statusLine: { updateSettings },
			ui: { requestRender },
		} as unknown as InteractiveModeContext);

		Settings.instance.override("git.enabled", false);
		controller.handleSettingChange("git.enabled", false);

		expect(updateSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				preset: Settings.instance.get("statusLine.preset"),
				leftSegments: Settings.instance.get("statusLine.leftSegments"),
				rightSegments: Settings.instance.get("statusLine.rightSegments"),
			}),
		);
		// The setting-change side effect is a single render request — the lazy
		// top-border provider rebuilds during paint (#4145).
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("invalidates the UI and requests a repaint when tui.tight changes", () => {
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			ui: { invalidate, requestRender },
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("tui.tight", true);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
	it("applies tui.hyperlinks changes to live renderers", () => {
		const originalHyperlinks = TERMINAL.hyperlinks;
		const statusInvalidate = vi.fn();
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			statusLine: { invalidate: statusInvalidate },
			ui: { invalidate, requestRender },
		} as unknown as InteractiveModeContext);

		try {
			setTerminalHyperlinks(false);
			Settings.instance.override("tui.hyperlinks", "always");
			controller.handleSettingChange("tui.hyperlinks", "always");
			expect(TERMINAL.hyperlinks).toBe(true);

			Settings.instance.override("tui.hyperlinks", "off");
			controller.handleSettingChange("tui.hyperlinks", "off");
			expect(TERMINAL.hyperlinks).toBe(false);
			expect(statusInvalidate).toHaveBeenCalledTimes(2);
			expect(invalidate).toHaveBeenCalledTimes(2);
			expect(requestRender).toHaveBeenCalledTimes(2);
		} finally {
			setTerminalHyperlinks(originalHyperlinks);
		}
	});
	it("applies memory backend changes to the live session", () => {
		const applyMemoryBackend = vi.fn(async () => {});
		const controller = new SelectorController({
			session: { applyMemoryBackend },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("memory.backend", "mnemopi");

		expect(applyMemoryBackend).toHaveBeenCalledTimes(1);
	});
	it("stops the live advisor runtime when advisor.enabled is turned off in /settings", () => {
		const setAdvisorEnabled = vi.fn();
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			session: { setAdvisorEnabled },
			statusLine: { invalidate },
			ui: { requestRender },
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("advisor.enabled", false);

		expect(setAdvisorEnabled).toHaveBeenCalledWith(false);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	for (const id of ["terminal.showImages", "showImages"]) {
		for (const visible of [false, true]) {
			it(`updates every image owner and rebuilds the transcript when ${id}=${visible}`, () => {
				const setShowImages = vi.fn();
				const setImagesVisible = vi.fn();
				const clearInlineImages = vi.fn();
				const requestRender = vi.fn();
				const tool = Object.create(ToolExecutionComponent.prototype) as ToolExecutionComponent;
				tool.setShowImages = setShowImages;
				const assistant = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
				assistant.setImagesVisible = setImagesVisible;
				const controller = new SelectorController({
					chatContainer: { children: [tool, assistant] },
					ui: { clearInlineImages, requestRender },
				} as unknown as InteractiveModeContext);

				controller.handleSettingChange(id, visible);

				expect(setShowImages).toHaveBeenCalledWith(visible);
				expect(setImagesVisible).toHaveBeenCalledWith(visible);
				expect(clearInlineImages).toHaveBeenCalledTimes(visible ? 0 : 1);
				expect(requestRender).toHaveBeenCalledTimes(1);
				if (!visible) {
					expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(
						requestRender.mock.invocationCallOrder[0],
					);
				}
			});
		}
	}

	for (const hidden of [true, false]) {
		it(`delegates display.hideToolActivity=${hidden} to the transcript container`, () => {
			const setToolActivityVisible = vi.fn();
			const setToolExpanded = vi.fn();
			const tool = Object.create(ToolExecutionComponent.prototype) as ToolExecutionComponent;
			tool.setExpanded = setToolExpanded;
			const setReadExpanded = vi.fn();
			const readGroup = Object.create(ReadToolGroupComponent.prototype) as ReadToolGroupComponent;
			readGroup.setExpanded = setReadExpanded;
			const setToolResultImagesVisible = vi.fn();
			const assistant = Object.create(AssistantMessageComponent.prototype) as AssistantMessageComponent;
			assistant.setToolResultImagesVisible = setToolResultImagesVisible;
			const clearInlineImages = vi.fn();
			const requestRender = vi.fn();
			const ctx = {
				hideToolActivity: !hidden,
				toolOutputExpanded: true,
				chatContainer: { children: [tool, readGroup, assistant], setToolActivityVisible },
				ui: { clearInlineImages, requestRender },
			};
			const controller = new SelectorController(ctx as unknown as InteractiveModeContext);

			controller.handleSettingChange("display.hideToolActivity", hidden);

			expect(ctx.hideToolActivity).toBe(hidden);
			expect(setToolActivityVisible).toHaveBeenCalledWith(!hidden);
			expect(setToolResultImagesVisible).toHaveBeenCalledWith(!hidden);
			expect(setToolExpanded).toHaveBeenCalledTimes(hidden ? 0 : 1);
			expect(setReadExpanded).toHaveBeenCalledTimes(hidden ? 0 : 1);
			expect(ctx.toolOutputExpanded).toBe(hidden);
			expect(clearInlineImages).toHaveBeenCalledTimes(hidden ? 1 : 0);
			expect(requestRender).toHaveBeenCalledTimes(1);
			if (hidden) {
				expect(clearInlineImages.mock.invocationCallOrder[0]).toBeLessThan(
					requestRender.mock.invocationCallOrder[0],
				);
			}
		});
	}

	for (const enabled of [false, true]) {
		it(`rebuilds the transcript when display.showTokenUsage=${enabled} changes in /settings`, () => {
			const rebuildChatFromMessages = vi.fn();
			const resetDisplay = vi.fn();
			const controller = new SelectorController({
				rebuildChatFromMessages,
				ui: { resetDisplay },
			} as unknown as InteractiveModeContext);

			controller.handleSettingChange("display.showTokenUsage", enabled);

			expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
			expect(resetDisplay).toHaveBeenCalledTimes(1);
			expect(rebuildChatFromMessages.mock.invocationCallOrder[0]).toBeLessThan(
				resetDisplay.mock.invocationCallOrder[0],
			);
		});
	}

	it("clears stale default role thinking when auto is selected", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const previousModel = getBundledModel("openai", "gpt-5.5");
		const nextModel = getBundledModel("openai", "gpt-5.6");
		if (!previousModel || !nextModel) throw new Error("Expected bundled OpenAI models for selector test");

		const settings = Settings.isolated({
			defaultThinkingLevel: ThinkingLevel.High,
			modelRoles: { default: `${previousModel.provider}/${previousModel.id}:high` },
		});
		const setModel = vi.fn(async () => ({ switched: true }));
		const autoApplied = Promise.withResolvers<void>();
		const setThinkingLevel = vi.fn((level: ThinkingLevel | typeof AUTO_THINKING, persist: boolean) => {
			if (level === AUTO_THINKING && persist) {
				settings.set("defaultThinkingLevel", level);
				autoApplied.resolve();
			}
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: nextModel,
				modelRegistry: {
					getAll: () => [previousModel, nextModel],
					getAvailable: () => [previousModel, nextModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: nextModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as
			| { handleInput(data: string): void; render(width: number): string[]; dispose(): void }
			| undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A"); // All models → Roles.
			hub.handleInput("\n"); // Enter the role rows.
			hub.handleInput("\n"); // Assign DEFAULT.
			hub.handleInput("\n"); // Pick the scoped replacement model.

			const levels = [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(nextModel)];
			const highIndex = levels.indexOf(ThinkingLevel.High);
			const autoIndex = levels.indexOf(AUTO_THINKING);
			if (highIndex < autoIndex) throw new Error("Expected auto before high in the thinking strip");
			for (let i = autoIndex; i < highIndex; i++) hub.handleInput("\x1b[D");
			hub.handleInput("\n");
			await autoApplied.promise;

			expect(setModel).toHaveBeenLastCalledWith(
				nextModel,
				"default",
				expect.objectContaining({
					thinkingLevel: ThinkingLevel.Inherit,
					persist: true,
				}),
			);
			expect(setThinkingLevel).toHaveBeenLastCalledWith(AUTO_THINKING, true);
		} finally {
			hub.dispose();
		}
	});
	it("keeps non-default auto thinking on the role without changing the active session", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const activeModel = getBundledModel("openai", "gpt-5.5");
		const taskModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!activeModel || !taskModel) throw new Error("Expected bundled active and task models for selector test");

		const activeSelector = `${activeModel.provider}/${activeModel.id}`;
		const taskSelector = `${taskModel.provider}/${taskModel.id}`;
		const settings = Settings.isolated({
			defaultThinkingLevel: ThinkingLevel.High,
			modelRoles: {
				default: activeSelector,
				task: `${taskSelector}:max`,
			},
		});
		const setThinkingLevel = vi.fn();
		const assignmentApplied = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.startsWith("TASK model:")) assignmentApplied.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: activeModel,
				modelRegistry: {
					getAll: () => [activeModel, taskModel],
					getAvailable: () => [activeModel, taskModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: activeModel }, { model: taskModel }],
				getContextUsage: () => undefined,
				setThinkingLevel,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as
			| { handleInput(data: string): void; render(width: number): string[]; dispose(): void }
			| undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A"); // All models → Roles.
			hub.handleInput("\n"); // Enter the role rows.
			for (let i = 0; i < 8; i++) hub.handleInput("\x1b[B"); // Default → task.
			hub.handleInput("t");

			const levels = [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(taskModel)];
			const autoIndex = levels.indexOf(AUTO_THINKING);
			const maxIndex = levels.indexOf(ThinkingLevel.Max);
			if (maxIndex < autoIndex) throw new Error("Expected task model to support max thinking");
			for (let i = autoIndex; i < maxIndex; i++) hub.handleInput("\x1b[D");
			hub.handleInput("\n");
			await assignmentApplied.promise;

			expect(settings.getModelRole("task")).toBe(`${taskSelector}:auto`);
			expect(settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
			expect(setThinkingLevel).not.toHaveBeenCalled();
			const lines = hub.render(220).map(line => stripVTControlCharacters(line));
			const defaultRow = lines.find(line => line.includes("DEFAULT"));
			const taskRow = lines.find(line => line.includes("TASK"));
			expect(defaultRow).toContain("high");
			expect(defaultRow).not.toContain("auto");
			expect(taskRow).toContain("auto");
			expect(taskRow).not.toContain("max");
		} finally {
			hub.dispose();
		}
	});
	it("routes project default assignments without persisting the global role", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const model = getBundledModel("openai", "gpt-5.6");
		if (!model) throw new Error("Expected bundled OpenAI model for selector test");
		const settings = Settings.isolated({ modelRoleStorage: "project" });
		const setModel = vi.fn(async () => ({ switched: true }));
		const assignmentApplied = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.startsWith("Project default model:")) assignmentApplied.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model,
				modelRegistry: {
					getAll: () => [model],
					getAvailable: () => [model],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A"); // All models → Roles.
			hub.handleInput("\n"); // Enter the role rows.
			hub.handleInput("\n"); // Assign DEFAULT.
			hub.handleInput("\n"); // Pick the scoped model.
			hub.handleInput("\n"); // Save the assignment to the project.
			await assignmentApplied.promise;

			expect(setModel).toHaveBeenCalledWith(
				model,
				"default",
				expect.objectContaining({
					thinkingLevel: ThinkingLevel.Inherit,
					persist: false,
				}),
			);
			expect(settings.getProjectModelRole("default")).toBe(`${model.provider}/${model.id}`);
			expect(settings.getGlobalModelRole("default")).toBeUndefined();
			expect(showStatus).toHaveBeenCalledWith(`Project default model: ${model.provider}/${model.id}`);
		} finally {
			hub.dispose();
		}
	});

	it("edits a shadowed global default without switching the live project session", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !globalModel) throw new Error("Expected bundled OpenAI models for selector test");

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const globalSelector = `${globalModel.provider}/${globalModel.id}`;
		const settings = Settings.isolated({ modelRoleStorage: "project" });
		settings.setProjectModelRole("default", projectSelector);
		const setModel = vi.fn(async () => ({ switched: true }));
		const assignmentApplied = Promise.withResolvers<void>();
		const capturedRuntimeAssignmentApplied = Promise.withResolvers<void>();
		let globalStatusCount = 0;
		const showStatus = vi.fn((message: string) => {
			if (!message.startsWith("Global default model:")) return;
			globalStatusCount++;
			if (globalStatusCount === 1) assignmentApplied.resolve();
			if (globalStatusCount === 2) capturedRuntimeAssignmentApplied.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: projectModel,
				modelRegistry: {
					getAll: () => [projectModel, globalModel],
					getAvailable: () => [projectModel, globalModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: projectModel }, { model: globalModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A"); // All models → Roles.
			hub.handleInput("\n"); // Enter the role rows.
			hub.handleInput("\n"); // Assign DEFAULT.
			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput("\x1b[B"); // Effective project model → new global fallback.
			hub.handleInput("\n"); // Pick the global fallback model.
			hub.handleInput("\x1b[B"); // Project scope → global scope.
			hub.handleInput("\n");
			await assignmentApplied.promise;

			expect(setModel).not.toHaveBeenCalled();
			expect(settings.getGlobalModelRole("default")).toBe(globalSelector);
			expect(settings.getProjectModelRole("default")).toBe(projectSelector);
			expect(showStatus).toHaveBeenCalledWith(`Global default model: ${globalSelector}`);

			settings.overrideModelRoles({ default: globalSelector });
			settings.setProjectModelRole("default", projectSelector);
			expect(settings.getModelRoleProvenance("default")).toBe("runtime");
			expect(settings.isProjectModelRoleRuntimeOverrideActive("default")).toBe(true);

			hub.handleInput("\x1b"); // Thinking strip → Roles.
			hub.handleInput("\n"); // Assign DEFAULT again.
			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput("\x1b[B"); // Effective project model → new global fallback.
			hub.handleInput("\n"); // Pick the global fallback model.
			hub.handleInput("\x1b[B"); // Project scope → global scope.
			hub.handleInput("\n");
			await capturedRuntimeAssignmentApplied.promise;

			expect(setModel).not.toHaveBeenCalled();
			expect(settings.getGlobalModelRole("default")).toBe(globalSelector);
			expect(settings.getModelRole("default")).toBe(projectSelector);
		} finally {
			hub.dispose();
		}
	});

	it("switches the live session when a global edit replaces a runtime override in project mode", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !globalModel) throw new Error("Expected bundled OpenAI models for selector test");

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const globalSelector = `${globalModel.provider}/${globalModel.id}`;
		const settings = Settings.isolated({ modelRoleStorage: "project" });
		settings.setProjectModelRole("default", projectSelector);
		// Simulate a CLI --model override: runtime override distinct from the project value.
		settings.overrideModelRoles({ default: `anthropic/claude-sonnet-4-5` });
		const setModel = vi.fn(async () => ({ switched: true }));
		const assignmentApplied = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.startsWith("Global default model:")) assignmentApplied.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: projectModel,
				modelRegistry: {
					getAll: () => [projectModel, globalModel],
					getAvailable: () => [projectModel, globalModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: projectModel }, { model: globalModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A"); // All models → Roles.
			hub.handleInput("\n"); // Enter the role rows.
			hub.handleInput("\n"); // Assign DEFAULT.
			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput("\x1b[B"); // Effective project model → new global fallback.
			hub.handleInput("\n"); // Pick the global fallback model.
			hub.handleInput("\x1b[B"); // Project scope → global scope.
			hub.handleInput("\n");
			await assignmentApplied.promise;

			// The runtime override makes the global edit effective, so the live
			// session must switch to the newly assigned global model.
			expect(setModel).toHaveBeenCalledWith(globalModel, "default", expect.objectContaining({ persist: true }));
			expect(settings.getProjectModelRole("default")).toBe(projectSelector);
			expect(showStatus).toHaveBeenCalledWith(`Global default model: ${globalSelector}`);
		} finally {
			hub.dispose();
		}
	});

	it("switches a global edit when a byte-identical startup runtime override shadows the project default", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !globalModel) throw new Error("Expected bundled OpenAI models for selector test");

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const globalSelector = `${globalModel.provider}/${globalModel.id}`;
		const testDir = path.join(os.tmpdir(), `selector-runtime-identical-${Snowflake.next()}`);
		const projectDir = path.join(testDir, "project");
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".omp", "config.yml"), `modelRoles:\n  default: ${projectSelector}\n`);

		try {
			const settings = await Settings.loadIsolated({
				cwd: projectDir,
				agentDir: testDir,
				inMemory: true,
				overrides: {
					modelRoleStorage: "project",
					modelRoles: { default: projectSelector },
				},
			});
			expect(settings.getProjectModelRole("default")).toBe(projectSelector);
			expect(settings.getModelRole("default")).toBe(projectSelector);
			expect(settings.getModelRoleProvenance("default")).toBe("runtime");

			let liveModel = projectModel;
			const setModel = vi.fn(async () => {
				liveModel = globalModel;
				settings.setModelRole("default", globalSelector);
				return { switched: true };
			});
			const assignmentApplied = Promise.withResolvers<void>();
			const showStatus = vi.fn((message: string) => {
				if (message.startsWith("Global default model:")) assignmentApplied.resolve();
			});
			let captured: unknown;
			const controller = new SelectorController({
				ui: {
					requestRender: vi.fn(),
					setFocus: vi.fn(),
					showOverlay: vi.fn((component: unknown) => {
						captured = component;
						return { hide: vi.fn() };
					}),
					terminal: { rows: 40 },
				},
				editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
				editor: {},
				settings,
				session: {
					model: liveModel,
					modelRegistry: {
						getAll: () => [projectModel, globalModel],
						getAvailable: () => [projectModel, globalModel],
						getError: () => undefined,
						refresh: async () => {},
						refreshProvider: async () => {},
						getDiscoverableProviders: () => [],
						getProviderDiscoveryState: () => undefined,
						authStorage: { hasAuth: () => false },
					},
					scopedModels: [{ model: projectModel }, { model: globalModel }],
					getContextUsage: () => undefined,
					setModel,
					setThinkingLevel: vi.fn(),
				},
				statusLine: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				keybindings: { getKeys: () => [], getDisplayString: () => "" },
				showStatus,
				showError: vi.fn(),
			} as unknown as InteractiveModeContext);

			controller.showModelSelector();
			const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
			if (!hub) throw new Error("Expected model hub overlay to be shown");
			try {
				hub.handleInput("\x1b[A"); // All models → Roles.
				hub.handleInput("\n"); // Enter the role rows.
				hub.handleInput("\n"); // Assign DEFAULT.
				hub.handleInput("\t"); // Sidebar → model list.
				hub.handleInput("\x1b[B"); // Effective project model → new global default.
				hub.handleInput("\n"); // Pick the global model.
				hub.handleInput("\x1b[B"); // Project scope → global scope.
				hub.handleInput("\n");
				await assignmentApplied.promise;

				expect(setModel).toHaveBeenCalledWith(globalModel, "default", expect.objectContaining({ persist: true }));
				expect(liveModel).toBe(globalModel);
				expect(settings.getGlobalModelRole("default")).toBe(globalSelector);
				expect(settings.getProjectModelRole("default")).toBe(projectSelector);
				expect(settings.getModelRole("default")).toBe(globalSelector);
				expect(settings.getModelRoleProvenance("default")).toBe("runtime");
				expect(showStatus).toHaveBeenCalledWith(`Global default model: ${globalSelector}`);
			} finally {
				hub.dispose();
			}
		} finally {
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	it("persists project and global defaults shadowed by a config overlay without switching", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const overlayModel = getBundledModel("openai", "gpt-5.5");
		const projectModel = getBundledModel("openai", "gpt-5.6");
		if (!overlayModel || !projectModel) throw new Error("Expected bundled OpenAI models for selector test");

		const overlaySelector = `${overlayModel.provider}/${overlayModel.id}`;
		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const testDir = path.join(os.tmpdir(), `selector-overlay-assignment-${Snowflake.next()}`);
		const projectDir = path.join(testDir, "project");
		const overlayPath = path.join(testDir, "overlay.yml");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(overlayPath, `modelRoles:\n  default: ${overlaySelector}\n`);

		try {
			const settings = await Settings.loadIsolated({
				cwd: projectDir,
				agentDir: testDir,
				configFiles: [overlayPath],
				overrides: { modelRoleStorage: "project" },
			});
			expect(settings.getModelRole("default")).toBe(overlaySelector);
			expect(settings.getModelRoleProvenance("default")).toBe("overlay");

			const setModel = vi.fn(async () => ({ switched: true }));
			const projectAssignmentApplied = Promise.withResolvers<void>();
			const autoApplied = Promise.withResolvers<void>();
			const globalAssignmentApplied = Promise.withResolvers<void>();
			const showStatus = vi.fn((message: string) => {
				if (message.startsWith("Project default model:")) projectAssignmentApplied.resolve();
				if (
					message.startsWith("Project default model:") &&
					settings.get("defaultThinkingLevel") === AUTO_THINKING
				) {
					autoApplied.resolve();
				}
				if (message.startsWith("Global default model:")) globalAssignmentApplied.resolve();
			});
			let captured: unknown;
			const controller = new SelectorController({
				ui: {
					requestRender: vi.fn(),
					setFocus: vi.fn(),
					showOverlay: vi.fn((component: unknown) => {
						captured = component;
						return { hide: vi.fn() };
					}),
					terminal: { rows: 40 },
				},
				editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
				editor: {},
				settings,
				session: {
					model: overlayModel,
					modelRegistry: {
						getAll: () => [overlayModel, projectModel],
						getAvailable: () => [overlayModel, projectModel],
						getError: () => undefined,
						refresh: async () => {},
						refreshProvider: async () => {},
						getDiscoverableProviders: () => [],
						getProviderDiscoveryState: () => undefined,
						authStorage: { hasAuth: () => false },
					},
					scopedModels: [{ model: overlayModel }, { model: projectModel }],
					getContextUsage: () => undefined,
					setModel,
					setThinkingLevel: vi.fn(),
				},
				statusLine: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				keybindings: { getKeys: () => [], getDisplayString: () => "" },
				showStatus,
				showError: vi.fn(),
			} as unknown as InteractiveModeContext);

			controller.showModelSelector();
			const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
			if (!hub) throw new Error("Expected model hub overlay to be shown");
			try {
				hub.handleInput("\x1b[A"); // All models → Roles.
				hub.handleInput("\n"); // Enter the role rows.
				hub.handleInput("\n"); // Assign DEFAULT.
				hub.handleInput("\t"); // Sidebar → model list.
				hub.handleInput("\x1b[B"); // Overlay model → hidden project default.
				hub.handleInput("\n"); // Pick the project model.
				hub.handleInput("\n"); // Save to project scope.
				await projectAssignmentApplied.promise;
				hub.handleInput("\x1b[C"); // Inherit → off.
				hub.handleInput("\x1b[C"); // Off → auto.
				hub.handleInput("\n");
				await autoApplied.promise;
				expect(settings.get("defaultThinkingLevel")).toBe(AUTO_THINKING);
				await settings.flush();

				expect(settings.getProjectModelRole("default")).toBe(projectSelector);
				expect(settings.getGlobalModelRole("default")).toBeUndefined();
				expect(settings.getModelRole("default")).toBe(overlaySelector);
				expect(settings.getModelRoleProvenance("default")).toBe("overlay");
				expect(await Bun.file(path.join(projectDir, ".omp", "config.yml")).text()).toContain(
					`default: ${projectSelector}`,
				);
				expect(setModel).not.toHaveBeenCalled();
				expect(showStatus).toHaveBeenCalledWith(`Project default model: ${projectSelector}`);

				hub.handleInput("\x1b"); // Thinking strip → Roles.
				hub.handleInput("\n"); // Assign DEFAULT again.
				hub.handleInput("\t"); // Sidebar → model list.
				hub.handleInput("\x1b[B"); // Overlay model → hidden project fallback.
				hub.handleInput("\n"); // Pick the current project fallback.
				hub.handleInput("\x1b[B"); // Project scope → global scope.
				hub.handleInput("\n"); // Save the hidden global fallback.
				await globalAssignmentApplied.promise;

				expect(settings.getGlobalModelRole("default")).toBe(projectSelector);
				expect(settings.getModelRole("default")).toBe(overlaySelector);
				expect(settings.getModelRoleProvenance("default")).toBe("overlay");
				expect(setModel).not.toHaveBeenCalled();
			} finally {
				hub.dispose();
			}
		} finally {
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	it("switches the live default in global mode even when project settings retain an override", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !globalModel) throw new Error("Expected bundled OpenAI models for selector test");

		const settings = Settings.isolated({});
		settings.setProjectModelRole("default", `${projectModel.provider}/${projectModel.id}`);
		const setModel = vi.fn(async () => ({ switched: true }));
		const assignmentApplied = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.startsWith("Default model:")) assignmentApplied.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: projectModel,
				modelRegistry: {
					getAll: () => [projectModel, globalModel],
					getAvailable: () => [projectModel, globalModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: projectModel }, { model: globalModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput("\x1b[B"); // Effective project model → new global default.
			hub.handleInput("\n"); // Open the selected model's role strip.
			hub.handleInput("\n"); // Assign DEFAULT in global-only mode.
			await assignmentApplied.promise;

			expect(setModel).toHaveBeenCalledWith(globalModel, "default", expect.objectContaining({ persist: true }));
			expect(showStatus).toHaveBeenCalledWith(`Default model: ${globalModel.provider}/${globalModel.id}`);
		} finally {
			hub.dispose();
		}
	});

	it("replaces malformed default retry fallback chains from the model selector action", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const settings = Settings.isolated({});
		settings.set("retry.fallbackChains", { default: "not-an-array" } as unknown as Record<string, string[]>);
		const fallback = buildModel({
			id: "retry-fallback-model",
			name: "retry-fallback-model",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			provider: "test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: undefined,
				modelRegistry: {
					getAll: () => [fallback],
					getAvailable: () => [fallback],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: fallback }],
				getContextUsage: () => undefined,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError,
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as
			| { handleInput(data: string): void; render(width: number): string[]; dispose(): void }
			| undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\n");
			const frame = stripVTControlCharacters(hub.render(220).join("\n"));
			expect(frame).toContain("retry-fallback");
			hub.handleInput("\x1b[D");
			hub.handleInput("\n");
			await Promise.resolve();

			expect(showError).not.toHaveBeenCalled();
			expect(settings.get("retry.fallbackChains")).toEqual({ default: ["test/retry-fallback-model"] });
			expect(showStatus).toHaveBeenCalledWith("DEFAULT fallbacks: test/retry-fallback-model");
		} finally {
			hub.dispose();
		}
	});

	it("applies an @ quick role through the role-switch session API", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for quick-role picker test");
		setThemeInstance(testTheme);

		const smol = buildModel({
			id: "smol-model",
			name: "smol-model",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			provider: "test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const slow = buildModel({
			id: "slow-model",
			name: "slow-model",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			provider: "test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const quickRoles: ResolvedRoleModel[] = [
			{ role: "smol", model: smol, explicitThinkingLevel: false },
			{ role: "slow", model: slow, explicitThinkingLevel: false },
		];
		const applyRoleModel = vi.fn(async () => {});
		const setModelTemporary = vi.fn(async () => {});
		const showModelCycleTrack = vi.fn();
		const showError = vi.fn();
		let picker: { handleInput(data: string): void } | undefined;
		const settings = Settings.isolated({ cycleOrder: ["smol", "slow"] });
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					picker = component as { handleInput(data: string): void };
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: slow,
				modelRegistry: {
					getAll: () => [smol, slow],
					getAvailable: () => [smol, slow],
					getError: () => undefined,
					refresh: async () => {},
				},
				scopedModels: [{ model: smol }, { model: slow }],
				getContextUsage: () => undefined,
				getRoleModelCycle: () => ({ models: quickRoles, currentIndex: 1 }),
				applyRoleModel,
				setModelTemporary,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showModelCycleTrack,
			showError,
		} as unknown as InteractiveModeContext);

		controller.showModelSelector({ temporaryOnly: true });
		if (!picker) throw new Error("Expected temporary model picker overlay");
		picker.handleInput("@");
		picker.handleInput("\n");
		await Promise.resolve();

		expect(applyRoleModel).toHaveBeenCalledWith(quickRoles[1]);
		expect(setModelTemporary).not.toHaveBeenCalled();
		expect(showModelCycleTrack).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});

	it("switches the live session to the global default when the project default is unassigned", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !globalModel) throw new Error("Expected bundled OpenAI models for selector test");

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const globalSelector = `${globalModel.provider}/${globalModel.id}`;
		const settings = Settings.isolated({ modelRoleStorage: "project" });
		settings.setProjectModelRole("default", projectSelector);
		settings.setModelRole("default", globalSelector);

		const setModel = vi.fn(async () => ({ switched: true }));
		const setThinkingLevel = vi.fn();
		const statusInvalidate = vi.fn();
		const updateEditorBorderColor = vi.fn();
		const showError = vi.fn();
		const roleCleared = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.includes("role cleared")) roleCleared.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: projectModel,
				modelRegistry: {
					getAll: () => [projectModel, globalModel],
					getAvailable: () => [projectModel, globalModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: projectModel }, { model: globalModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel,
			},
			statusLine: { invalidate: statusInvalidate },
			updateEditorBorderColor,
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError,
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A"); // All models → Roles.
			hub.handleInput("\n"); // Enter the role rows (scope → list focus).
			hub.handleInput("\x7f"); // Backspace on DEFAULT to unassign.
			await roleCleared.promise;
			// The async setModel continuation needs a microtask to settle.
			await Promise.resolve();

			expect(settings.getProjectModelRole("default")).toBeUndefined();
			expect(settings.getGlobalModelRole("default")).toBe(globalSelector);
			expect(setModel).toHaveBeenCalledWith(globalModel, "default", expect.objectContaining({ persist: false }));
			expect(statusInvalidate).toHaveBeenCalled();
			expect(updateEditorBorderColor).toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
		} finally {
			hub.dispose();
		}
	});

	it("switches to the project default when clearing a runtime-backed global default", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		const runtimeModel = getBundledModel("openai", "gpt-5.1");
		if (!projectModel || !globalModel || !runtimeModel) {
			throw new Error("Expected bundled OpenAI models for selector test");
		}

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const globalSelector = `${globalModel.provider}/${globalModel.id}`;
		const runtimeSelector = `${runtimeModel.provider}/${runtimeModel.id}`;
		const settings = Settings.isolated({ modelRoleStorage: "project" });
		settings.setProjectModelRole("default", projectSelector);
		settings.setModelRole("default", globalSelector);
		settings.overrideModelRoles({ default: runtimeSelector });

		const switchCompleted = Promise.withResolvers<void>();
		const setModel = vi.fn(async () => {
			switchCompleted.resolve();
			return { switched: true };
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: runtimeModel,
				modelRegistry: {
					getAll: () => [projectModel, globalModel, runtimeModel],
					getAvailable: () => [projectModel, globalModel, runtimeModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: projectModel }, { model: globalModel }, { model: runtimeModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput("\x1b[A"); // Runtime model → global fallback.
			hub.handleInput("\n"); // Open scoped role chips.
			hub.handleInput("\x1b[C"); // Project default → global default.
			hub.handleInput("\n"); // Clear the global default.
			await switchCompleted.promise;

			expect(settings.getGlobalModelRole("default")).toBeUndefined();
			expect(settings.getProjectModelRole("default")).toBe(projectSelector);
			expect(settings.getModelRole("default")).toBe(projectSelector);
			expect(setModel).toHaveBeenCalledWith(projectModel, "default", expect.objectContaining({ persist: false }));
		} finally {
			hub.dispose();
		}
	});

	it("serializes a later default edit behind a pending cleared-project fallback", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !globalModel) throw new Error("Expected bundled OpenAI models for selector test");

		const settings = Settings.isolated({ modelRoleStorage: "project" });
		settings.setProjectModelRole("default", `${projectModel.provider}/${projectModel.id}`);
		settings.setModelRole("default", `${globalModel.provider}/${globalModel.id}`);

		const pendingFallback = Promise.withResolvers<{ switched: boolean }>();
		const supersedingEdit = Promise.withResolvers<{ switched: boolean }>();
		const supersedingEditStarted = Promise.withResolvers<void>();
		let setModelCallCount = 0;
		const setModel = vi.fn(() => {
			setModelCallCount++;
			if (setModelCallCount === 1) {
				return pendingFallback.promise;
			}
			supersedingEditStarted.resolve();
			return supersedingEdit.promise;
		});
		const roleCleared = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.includes("role cleared")) roleCleared.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: projectModel,
				modelRegistry: {
					getAll: () => [projectModel, globalModel],
					getAvailable: () => [projectModel, globalModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: projectModel }, { model: globalModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A"); // All models → Roles.
			hub.handleInput("\n"); // Enter the role rows.
			hub.handleInput("\x7f"); // Clear project DEFAULT and begin its global fallback switch.
			await roleCleared.promise;

			expect(setModel).toHaveBeenCalledTimes(1);

			hub.handleInput("\n"); // Start a later DEFAULT assignment.
			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput("\x1b[A"); // Global fallback → project model.
			hub.handleInput("\n"); // Pick the project model.
			hub.handleInput("\n"); // Start the project-scoped default edit.
			await Promise.resolve();

			expect(setModel).toHaveBeenCalledTimes(1);
			pendingFallback.resolve({ switched: false });
			await supersedingEditStarted.promise;
			expect(setModel).toHaveBeenCalledTimes(2);
			supersedingEdit.resolve({ switched: false });
			await Promise.resolve();
		} finally {
			hub.dispose();
		}
	});

	it("does not switch the live session when unassigning a project default with no global fallback", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		if (!projectModel) throw new Error("Expected bundled OpenAI model for selector test");

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const settings = Settings.isolated({ modelRoleStorage: "project" });
		settings.setProjectModelRole("default", projectSelector);

		const setModel = vi.fn(async () => ({ switched: true }));
		const showError = vi.fn();
		const roleCleared = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.includes("role cleared")) roleCleared.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: projectModel,
				modelRegistry: {
					getAll: () => [projectModel],
					getAvailable: () => [projectModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: projectModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError,
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A"); // All models → Roles.
			hub.handleInput("\n"); // Enter the role rows (scope → list focus).
			hub.handleInput("\x7f"); // Backspace on DEFAULT to unassign.
			await roleCleared.promise;
			await Promise.resolve();

			expect(settings.getProjectModelRole("default")).toBeUndefined();
			expect(settings.getGlobalModelRole("default")).toBeUndefined();
			expect(setModel).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
		} finally {
			hub.dispose();
		}
	});

	it("does not switch the live model when a --config overlay remains effective over the global default after the project default is unassigned", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		const overlayModel = getBundledModel("openai", "gpt-5.1");
		if (!projectModel || !globalModel || !overlayModel)
			throw new Error("Expected bundled OpenAI models for selector test");

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const globalSelector = `${globalModel.provider}/${globalModel.id}`;
		const overlaySelector = `${overlayModel.provider}/${overlayModel.id}`;

		const testDir = path.join(os.tmpdir(), `selector-overlay-clear-${Snowflake.next()}`);
		const projectDir = path.join(testDir, "project");
		const overlayPath = path.join(testDir, "overlay.yml");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(overlayPath, `modelRoles:\n  default: ${overlaySelector}\n`);

		try {
			const settings = await Settings.loadIsolated({
				cwd: projectDir,
				agentDir: testDir,
				inMemory: true,
				configFiles: [overlayPath],
				overrides: { modelRoleStorage: "project" },
			});
			settings.setModelRole("default", globalSelector);
			settings.setProjectModelRole("default", projectSelector);

			// Sanity: the config overlay is authoritative over both the global and
			// project layers in the merged view.
			expect(settings.getGlobalModelRole("default")).toBe(globalSelector);
			expect(settings.getProjectModelRole("default")).toBe(projectSelector);
			expect(settings.getModelRole("default")).toBe(overlaySelector);

			const setModel = vi.fn(async () => ({ switched: true }));
			const statusInvalidate = vi.fn();
			const updateEditorBorderColor = vi.fn();
			const showError = vi.fn();
			const roleCleared = Promise.withResolvers<void>();
			const showStatus = vi.fn((message: string) => {
				if (message.includes("role cleared")) roleCleared.resolve();
			});
			let captured: unknown;
			const controller = new SelectorController({
				ui: {
					requestRender: vi.fn(),
					setFocus: vi.fn(),
					showOverlay: vi.fn((component: unknown) => {
						captured = component;
						return { hide: vi.fn() };
					}),
					terminal: { rows: 40 },
				},
				editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
				editor: {},
				settings,
				session: {
					model: projectModel,
					modelRegistry: {
						getAll: () => [projectModel, globalModel, overlayModel],
						getAvailable: () => [projectModel, globalModel, overlayModel],
						getError: () => undefined,
						refresh: async () => {},
						refreshProvider: async () => {},
						getDiscoverableProviders: () => [],
						getProviderDiscoveryState: () => undefined,
						authStorage: { hasAuth: () => false },
					},
					scopedModels: [{ model: projectModel }, { model: globalModel }, { model: overlayModel }],
					getContextUsage: () => undefined,
					setModel,
					setThinkingLevel: vi.fn(),
				},
				statusLine: { invalidate: statusInvalidate },
				updateEditorBorderColor,
				keybindings: { getKeys: () => [], getDisplayString: () => "" },
				showStatus,
				showError,
			} as unknown as InteractiveModeContext);

			controller.showModelSelector();
			const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
			if (!hub) throw new Error("Expected model hub overlay to be shown");
			try {
				hub.handleInput("\x1b[A"); // All models → Roles.
				hub.handleInput("\n"); // Enter the role rows (scope → list focus).
				hub.handleInput("\x7f"); // Backspace on DEFAULT to unassign.
				await roleCleared.promise;
				await Promise.resolve();

				expect(settings.getProjectModelRole("default")).toBeUndefined();
				expect(settings.getGlobalModelRole("default")).toBe(globalSelector);
				// The config overlay remains authoritative after the clear.
				expect(settings.getModelRole("default")).toBe(overlaySelector);
				// The overlay is effective (distinct from the hidden global default),
				// so the live model must NOT switch to either fallback — the overlay
				// stays authoritative and no session-side persistence is warranted.
				expect(setModel).not.toHaveBeenCalled();
				expect(showError).not.toHaveBeenCalled();
			} finally {
				hub.dispose();
			}
		} finally {
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	it("does not switch the live model when a --config overlay byte-identical to the global default remains effective after the project default is unassigned", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const sharedModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !sharedModel) throw new Error("Expected bundled OpenAI models for selector test");

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const sharedSelector = `${sharedModel.provider}/${sharedModel.id}`;

		const testDir = path.join(os.tmpdir(), `selector-overlay-identical-${Snowflake.next()}`);
		const projectDir = path.join(testDir, "project");
		const overlayPath = path.join(testDir, "overlay.yml");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(overlayPath, `modelRoles:\n  default: ${sharedSelector}\n`);

		try {
			const settings = await Settings.loadIsolated({
				cwd: projectDir,
				agentDir: testDir,
				inMemory: true,
				configFiles: [overlayPath],
				overrides: { modelRoleStorage: "project" },
			});
			settings.setModelRole("default", sharedSelector);
			settings.setProjectModelRole("default", projectSelector);

			// Sanity: the config overlay and global layer carry the same raw value,
			// but the overlay is the effective source in the merged view.
			expect(settings.getGlobalModelRole("default")).toBe(sharedSelector);
			expect(settings.getProjectModelRole("default")).toBe(projectSelector);
			expect(settings.getModelRole("default")).toBe(sharedSelector);
			expect(settings.getModelRoleProvenance("default")).toBe("overlay");

			const setModel = vi.fn(async () => ({ switched: true }));
			const showError = vi.fn();
			const roleCleared = Promise.withResolvers<void>();
			const showStatus = vi.fn((message: string) => {
				if (message.includes("role cleared")) roleCleared.resolve();
			});
			let captured: unknown;
			const controller = new SelectorController({
				ui: {
					requestRender: vi.fn(),
					setFocus: vi.fn(),
					showOverlay: vi.fn((component: unknown) => {
						captured = component;
						return { hide: vi.fn() };
					}),
					terminal: { rows: 40 },
				},
				editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
				editor: {},
				settings,
				session: {
					model: projectModel,
					modelRegistry: {
						getAll: () => [projectModel, sharedModel],
						getAvailable: () => [projectModel, sharedModel],
						getError: () => undefined,
						refresh: async () => {},
						refreshProvider: async () => {},
						getDiscoverableProviders: () => [],
						getProviderDiscoveryState: () => undefined,
						authStorage: { hasAuth: () => false },
					},
					scopedModels: [{ model: projectModel }, { model: sharedModel }],
					getContextUsage: () => undefined,
					setModel,
					setThinkingLevel: vi.fn(),
				},
				statusLine: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				keybindings: { getKeys: () => [], getDisplayString: () => "" },
				showStatus,
				showError,
			} as unknown as InteractiveModeContext);

			controller.showModelSelector();
			const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
			if (!hub) throw new Error("Expected model hub overlay to be shown");
			try {
				hub.handleInput("\x1b[A"); // All models → Roles.
				hub.handleInput("\n"); // Enter the role rows (scope → list focus).
				hub.handleInput("\x7f"); // Backspace on DEFAULT to unassign.
				await roleCleared.promise;
				await Promise.resolve();

				expect(settings.getProjectModelRole("default")).toBeUndefined();
				expect(settings.getGlobalModelRole("default")).toBe(sharedSelector);
				// The overlay is still effective with the same raw value as global.
				expect(settings.getModelRole("default")).toBe(sharedSelector);
				expect(settings.getModelRoleProvenance("default")).toBe("overlay");
				// Provenance is "overlay" (not "global"), so the live model must NOT
				// switch even though the raw values are byte-identical.
				expect(setModel).not.toHaveBeenCalled();
				expect(showError).not.toHaveBeenCalled();
			} finally {
				hub.dispose();
			}
		} finally {
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});

	it("re-enables auto thinking from defaultThinkingLevel when the global default has no explicit thinking", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !globalModel) throw new Error("Expected bundled OpenAI models for selector test");

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const globalSelector = `${globalModel.provider}/${globalModel.id}`;
		const settings = Settings.isolated({ modelRoleStorage: "project", defaultThinkingLevel: AUTO_THINKING });
		settings.setProjectModelRole("default", projectSelector);
		settings.setModelRole("default", globalSelector);

		const setModel = vi.fn(async () => ({ switched: true }));
		const setThinkingLevel = vi.fn((level: unknown, persist?: boolean) => {
			if (level === AUTO_THINKING && persist) {
				settings.set("defaultThinkingLevel", AUTO_THINKING);
			}
		});
		const roleCleared = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.includes("role cleared")) roleCleared.resolve();
		});
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: projectModel,
				modelRegistry: {
					getAll: () => [projectModel, globalModel],
					getAvailable: () => [projectModel, globalModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: projectModel }, { model: globalModel }],
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A");
			hub.handleInput("\n");
			hub.handleInput("\x7f");
			await roleCleared.promise;
			await Promise.resolve();

			expect(setModel).toHaveBeenCalledWith(
				globalModel,
				"default",
				expect.objectContaining({ persist: false, thinkingLevel: ThinkingLevel.Inherit }),
			);
			expect(setThinkingLevel).toHaveBeenCalledWith(AUTO_THINKING, true);
		} finally {
			hub.dispose();
		}
	});

	it("resolves the global fallback from scoped models when nonempty", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const projectModel = getBundledModel("openai", "gpt-5.5");
		const globalModel = getBundledModel("openai", "gpt-5.6");
		if (!projectModel || !globalModel) throw new Error("Expected bundled OpenAI models for selector test");

		const projectSelector = `${projectModel.provider}/${projectModel.id}`;
		const globalSelector = `${globalModel.provider}/${globalModel.id}`;
		const settings = Settings.isolated({ modelRoleStorage: "project" });
		settings.setProjectModelRole("default", projectSelector);
		settings.setModelRole("default", globalSelector);

		const setModel = vi.fn(async () => ({ switched: true }));
		const roleCleared = Promise.withResolvers<void>();
		const showStatus = vi.fn((message: string) => {
			if (message.includes("role cleared")) roleCleared.resolve();
		});
		// scopedModels contains ONLY projectModel; the global model is NOT in scopedModels.
		const scopedModels = [{ model: projectModel }];
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: projectModel,
				modelRegistry: {
					getAll: () => [projectModel, globalModel],
					getAvailable: () => [projectModel, globalModel],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels,
				getContextUsage: () => undefined,
				setModel,
				setThinkingLevel: vi.fn(),
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as { handleInput(data: string): void; dispose(): void } | undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\x1b[A");
			hub.handleInput("\n");
			hub.handleInput("\x7f");
			await roleCleared.promise;
			await Promise.resolve();

			// Global model is not in scopedModels, so resolveModelRoleValue cannot
			// match it → setModel must NOT be called.
			expect(setModel).not.toHaveBeenCalled();
		} finally {
			hub.dispose();
		}
	});
});
