import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as theme from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

beforeAll(async () => {
	await theme.initTheme();
});

describe("SelectorController prompt-affecting settings", () => {
	it("refreshes the active prompt when xdev docs mode changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("tools.xdevDocs", "catalog");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	describe("queue-mode toggles from the settings panel", () => {
		let tempDir: TempDir;
		let authStorage: AuthStorage;
		let settings: Settings;
		let session: AgentSession;
		let controller: SelectorController;
		let configPath: string;

		beforeEach(async () => {
			tempDir = TempDir.createSync("@pi-selector-queue-");
			const agentDir = tempDir.path();
			configPath = path.join(agentDir, "config.yml");

			authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
			settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: SessionManager.create(agentDir, agentDir),
				settings,
				modelRegistry,
				obfuscator: new SecretObfuscator([]),
			});
			controller = new SelectorController({ session } as unknown as InteractiveModeContext);
		});

		afterEach(async () => {
			authStorage.close();
			try {
				await tempDir.remove();
			} catch {}
		});

		it("applies panel queue-mode toggles live and persists them globally", async () => {
			controller.handleSettingChange("steeringMode", "all");
			controller.handleSettingChange("followUpMode", "all");
			controller.handleSettingChange("interruptMode", "wait");
			await settings.flush();

			expect(session.steeringMode).toBe("all");
			expect(session.followUpMode).toBe("all");
			expect(session.interruptMode).toBe("wait");
			expect(settings.getGlobalSettings()).toMatchObject({
				steeringMode: "all",
				followUpMode: "all",
				interruptMode: "wait",
			});
			const onDisk = await Bun.file(configPath).text();
			expect(onDisk).toContain("steeringMode: all");
			expect(onDisk).toContain("followUpMode: all");
			expect(onDisk).toContain("interruptMode: wait");
		});
	});
});

describe("SelectorController settings overlay close", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	it("keeps custom segment options when closing /settings", async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-close-segment-options-");
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		const customOptions = { path: { abbreviate: false, maxLength: 12 } };
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ ask: { enabled: false } }, null, 2));
		await Bun.write(
			path.join(projectDir, ".omp", "config.yml"),
			YAML.stringify({ statusLine: { segmentOptions: customOptions } }, null, 2),
		);
		await Settings.init({ cwd: projectDir, agentDir });
		vi.spyOn(theme, "getAvailableThemes").mockResolvedValue(["dark-one", "titanium"]);

		const editor = { id: "editor", getTopBorderAvailableWidth: () => 80 };
		const overlay = { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
		const updateSettings = vi.fn();
		let selector: { handleInput: (data: string) => void } | undefined;
		const ctx = {
			editor,
			editorContainer: { children: [editor] },
			session: {
				getAvailableThinkingLevels: () => [],
				thinkingLevel: undefined,
				getAvailableModels: () => [],
				model: undefined,
			},
			statusLine: {
				updateSettings,
				invalidate: vi.fn(),
				getPreviewLines: () => [],
			},
			ui: {
				showOverlay: vi.fn(component => {
					selector = component as { handleInput: (data: string) => void };
					return overlay;
				}),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				invalidate: vi.fn(),
				imageBudget: undefined,
				terminal: { columns: 80 },
			},
		} as unknown as InteractiveModeContext;

		new SelectorController(ctx).showSettingsSelector();
		await Promise.resolve();
		expect(selector).toBeDefined();
		selector!.handleInput("\x1b");

		expect(updateSettings).toHaveBeenCalled();
		expect(updateSettings.mock.calls.at(-1)?.[0]).toMatchObject({
			segmentOptions: customOptions,
		});
		expect(overlay.hide).toHaveBeenCalledTimes(1);
	});

	it("previews scoped symbol and color-blind options then restores them on close", async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-close-presentation-");
		const projectDir = tempDir.join("project");
		const agentDir = tempDir.join("agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ symbolPreset: "ascii", colorBlindMode: false }, null, 2),
		);
		await Bun.write(
			path.join(projectDir, ".omp", "config.yml"),
			YAML.stringify({ symbolPreset: "nerd", colorBlindMode: true }, null, 2),
		);
		await Settings.init({ cwd: projectDir, agentDir });
		const previewed: Array<{ name: string; symbolPreset?: string; colorBlindMode?: boolean }> = [];
		vi.spyOn(theme, "getAvailableThemes").mockResolvedValue(["dark-one", "titanium"]);
		vi.spyOn(theme, "previewTheme").mockImplementation(async (name, event) => {
			previewed.push({
				name,
				symbolPreset: event?.symbolPreset,
				colorBlindMode: event?.colorBlindMode,
			});
			return { success: true };
		});

		const editor = { id: "editor", getTopBorderAvailableWidth: () => 80 };
		const overlay = { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
		let selector: { handleInput: (data: string) => void } | undefined;
		const ctx = {
			editor,
			editorContainer: { children: [editor] },
			session: {
				getAvailableThinkingLevels: () => [],
				thinkingLevel: undefined,
				getAvailableModels: () => [],
				model: undefined,
			},
			statusLine: {
				updateSettings: vi.fn(),
				invalidate: vi.fn(),
				getPreviewLines: () => [],
			},
			ui: {
				showOverlay: vi.fn(component => {
					selector = component as { handleInput: (data: string) => void };
					return overlay;
				}),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				invalidate: vi.fn(),
				imageBudget: undefined,
				terminal: { columns: 80 },
			},
		} as unknown as InteractiveModeContext;

		new SelectorController(ctx).showSettingsSelector();
		await Promise.resolve();
		expect(selector).toBeDefined();
		expect(previewed.at(-1)).toMatchObject({ symbolPreset: "nerd", colorBlindMode: true });

		selector!.handleInput("\x1bs");
		await Promise.resolve();
		expect(previewed.at(-1)).toMatchObject({ symbolPreset: "ascii", colorBlindMode: false });

		selector!.handleInput("\x1b");
		await Promise.resolve();
		expect(previewed.at(-1)).toMatchObject({ symbolPreset: "nerd", colorBlindMode: true });
		expect(overlay.hide).toHaveBeenCalledTimes(1);
	});
});
