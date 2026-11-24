import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelStringWithRouting, parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking/levels";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { signal, type UiNode } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import * as modelHubModule from "../../../src/ui/overlays/pickers/model-hub";
import type { ModelHubState } from "../../../src/ui/overlays/pickers/model-hub-state";
import * as modelPickerModule from "../../../src/ui/overlays/pickers/model-picker";
import { Overlays } from "../../../src/ui/shell/overlays";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

const model = (id: string) => getBundledModel("anthropic", id) as Model;

// Writes made through the model hub and the session-only picker, driven through the controller's real callbacks.
describe("SelectorController model selector writes", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-selector-model-writes-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		await session?.dispose();
		session = undefined;
		authStorage.close();
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		tempDir.removeSync();
	});

	function start(
		settings: Settings,
		initial: Model,
		scope?: Pick<AgentSessionConfig, "scopedModels" | "scopedModelsFromSettings">,
	): { controller: SelectorController; showError: () => unknown } {
		const live = new AgentSession({
			agent: new Agent({ initialState: { model: initial, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			obfuscator: new SecretObfuscator([]),
			...scope,
		});
		session = live;
		const showError = vi.fn();
		const focused = signal<UiNode | null>(null);
		const ctx = {
			session: live,
			viewSession: live,
			focusedAgentId: undefined,
			settings,
			shell: {
				native: () => false,
				focus: (node: UiNode | null) => focused.set(node),
				size: () => ({ columns: 120, rows: 40 }),
				overlays: new Overlays({ focused, focus: node => focused.set(node), fallback: () => null }),
			},
			keybindings: { keysFor: () => [] },
			statusLine: { refresh: () => {} },
			updateEditorBorderColor: () => {},
			showModelCycleTrack: () => {},
			showStatus: () => {},
			showWarning: () => {},
			showError,
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);
		return { controller, showError };
	}

	function openModelHub(controller: SelectorController): modelHubModule.ModelHubProps["callbacks"] {
		let callbacks: modelHubModule.ModelHubProps["callbacks"] | undefined;
		vi.spyOn(modelHubModule, "ModelHub").mockImplementation(props => {
			callbacks = props.callbacks;
			return jsx("picker", {});
		});
		controller.showModelSelector();
		if (!callbacks) throw new Error("model hub was not opened");
		return callbacks;
	}

	type PickerProps = modelPickerModule.ModelPickerProps;
	function openModelPicker(controller: SelectorController): {
		callbacks: PickerProps["callbacks"];
		options: NonNullable<PickerProps["options"]>;
	} {
		let opened: { callbacks: PickerProps["callbacks"]; options: NonNullable<PickerProps["options"]> } | undefined;
		vi.spyOn(modelPickerModule, "ModelPicker").mockImplementation(props => {
			opened = { callbacks: props.callbacks, options: props.options ?? {} };
			return jsx("picker", {});
		});
		controller.showModelSelector({ temporaryOnly: true });
		if (!opened) throw new Error("model picker was not opened");
		return opened;
	}

	it("shows and keeps the session's own level on its current model, not its role's", async () => {
		const sonnet = model("claude-sonnet-4-5");
		const settings = Settings.isolated({ modelRoles: { default: "anthropic/claude-sonnet-4-5:high" } });
		const { controller, showError } = start(settings, sonnet);
		session!.setThinkingLevel(Effort.Low);
		const first = openModelPicker(controller);

		// The slider opens on the level the session runs at.
		expect(first.options.thinkingLevelFor?.(sonnet)).toBe(Effort.Low);
		// Esc after moving the slider on the current model keeps the moved level.
		first.callbacks.onKeepThinking?.(Effort.Medium);
		first.callbacks.onCancel();
		expect(session!.configuredThinkingLevel()).toBe(Effort.Medium);

		// Picking the current model again with the slider untouched keeps it.
		const second = openModelPicker(controller);
		await second.callbacks.onPick(sonnet, "anthropic/claude-sonnet-4-5", { overContext: false });
		expect(session!.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(showError).not.toHaveBeenCalled();
	});

	it("shows auto's resolved level once a turn settles it, and an untouched pick keeps auto", async () => {
		const sonnet = model("claude-sonnet-4-5");
		const { controller, showError } = start(Settings.isolated(), sonnet);
		vi.spyOn(session!.agent, "prompt").mockResolvedValue(undefined);
		vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.High);
		session!.setThinkingLevel(AUTO_THINKING);

		// Unresolved auto shows as auto.
		const pending = openModelPicker(controller);
		expect(pending.options.thinkingLevelFor?.(sonnet)).toBe(AUTO_THINKING);
		pending.callbacks.onCancel();

		await session!.prompt("Implement a focused parser fix");
		const { callbacks, options } = openModelPicker(controller);
		expect(options.thinkingLevelFor?.(sonnet)).toBe(Effort.High);

		await callbacks.onPick(sonnet, "anthropic/claude-sonnet-4-5", { overContext: false });
		expect(session!.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(showError).not.toHaveBeenCalled();
	});

	it("carries the session's level to a picked model, clamped to its ladder, over a role's level for it", async () => {
		const settings = Settings.isolated({ modelRoles: { smol: "anthropic/claude-opus-4-5:low" } });
		const { controller, showError } = start(settings, model("claude-opus-4-7"));
		session!.setThinkingLevel(Effort.Max);

		const { callbacks } = openModelPicker(controller);
		await callbacks.onPick(model("claude-opus-4-5"), "anthropic/claude-opus-4-5", { overContext: false });

		// Opus 4.5 tops out at xhigh: the nearest level to max, not the smol role's low.
		expect(session!.model?.id).toBe("claude-opus-4-5");
		expect(session!.configuredThinkingLevel()).toBe(Effort.XHigh);
		expect(showError).not.toHaveBeenCalled();
	});

	it("applies a session-only pick once when Enter repeats before the first apply settles", async () => {
		const opus = model("claude-opus-4-5");
		const { controller, showError } = start(Settings.isolated(), model("claude-sonnet-4-5"));
		const { callbacks } = openModelPicker(controller);

		// Two Enters land while the first apply is still awaiting the model switch; the picker stays on screen.
		const first = callbacks.onPick(opus, "anthropic/claude-opus-4-5", { overContext: false });
		const second = callbacks.onPick(opus, "anthropic/claude-opus-4-5", { overContext: false });
		await Promise.all([first, second]);

		// One pick is one session model change in the transcript, not one per Enter.
		const switches = session!.sessionManager.getBranch().filter(entry => entry.type === "model_change");
		expect(switches).toHaveLength(1);
		expect(session!.model?.id).toBe("claude-opus-4-5");
		expect(showError).not.toHaveBeenCalled();
	});

	it("applies a pick of a different model made while the first apply is in flight", async () => {
		const opus = model("claude-opus-4-5");
		const sonnet = model("claude-sonnet-4-5");
		const { controller, showError } = start(Settings.isolated(), model("claude-sonnet-4-5"));
		const { callbacks } = openModelPicker(controller);

		// A deliberate pick of another model lands while the first apply is still awaiting
		// the model switch; only a repeat of the same pick is dropped. The first apply is
		// the slower one: it must not land after and overwrite the newer pick.
		const realSetModelTemporary = session!.setModelTemporary.bind(session!);
		vi.spyOn(session!, "setModelTemporary").mockImplementation(async (picked, level) => {
			if (picked.id === "claude-opus-4-5") await new Promise(resolve => setTimeout(resolve, 50));
			return realSetModelTemporary(picked, level);
		});
		const first = callbacks.onPick(opus, "anthropic/claude-opus-4-5", { overContext: false });
		const second = callbacks.onPick(sonnet, "anthropic/claude-sonnet-4-5", { overContext: false });
		await Promise.all([first, second]);

		// The second pick applied despite the first being in flight and slower: the session
		// ends on it, with one model_change recorded for the final choice.
		const switches = session!.sessionManager.getBranch().filter(entry => entry.type === "model_change");
		expect(switches).toHaveLength(1);
		expect(session!.model?.id).toBe("claude-sonnet-4-5");
		expect(showError).not.toHaveBeenCalled();
	});

	it("applies a quick-role pick once when Enter repeats before the first apply settles", async () => {
		const settings = Settings.isolated({ modelRoles: { smol: "anthropic/claude-opus-4-5" }, cycleOrder: ["smol"] });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		const { callbacks, options } = openModelPicker(controller);
		const smol = options.quickRoles?.find(entry => entry.role === "smol");
		if (!smol) throw new Error("the smol quick role was not offered");

		// Two Enters land on the quick role while its first apply is still awaiting the model switch.
		const first = callbacks.onPickRole?.(smol);
		const second = callbacks.onPickRole?.(smol);
		await Promise.all([first, second]);

		const switches = session!.sessionManager.getBranch().filter(entry => entry.type === "model_change");
		expect(switches).toHaveLength(1);
		expect(session!.model?.id).toBe("claude-opus-4-5");
		expect(showError).not.toHaveBeenCalled();
	});

	it("saves only the edited fallback chain, never the chains a --config overlay supplies", async () => {
		const agentDir = tempDir.join("agent");
		const overlayPath = tempDir.join("overlay.yml");
		await Bun.write(overlayPath, YAML.stringify({ retry: { fallbackChains: { smol: ["overlay/cheap"] } } }));
		// The global instance, as in the app: the hub's status text reads the global settings.
		const settings = await Settings.init({ agentDir, cwd: tempDir.path(), configFiles: [overlayPath] });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));

		openModelHub(controller).onFallbackChainChange?.("slow", ["user/slow-fallback"]);
		await settings.flush();

		expect(showError).not.toHaveBeenCalled();
		const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as RawSettings;
		expect(saved).toEqual({ retry: { fallbackChains: { slow: ["user/slow-fallback"] } } });
	});

	it("switches the session to the project default when its already-assigned chip is picked", async () => {
		const agentDir = tempDir.join("agent");
		await Bun.write(
			tempDir.join(".omp", "config.yml"),
			YAML.stringify({ modelRoles: { default: "anthropic/claude-opus-4-5" } }),
		);
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		// The session moved off the configured default earlier (an in-session pick).
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));

		// The hub shows the project default as assigned, so picking it sends unassign.
		await openModelHub(controller).onUnassign("default");

		expect(showError).not.toHaveBeenCalled();
		expect(session?.model?.id).toBe("claude-opus-4-5");
	});

	it("ignores a stale settings-derived scope when falling back to the persisted default", async () => {
		await Bun.write(
			tempDir.join(".omp", "config.yml"),
			YAML.stringify({ modelRoles: { default: "anthropic/claude-opus-4-5" } }),
		);
		const settings = await Settings.init({ agentDir: tempDir.join("agent"), cwd: tempDir.path() });
		const sonnet = model("claude-sonnet-4-5");
		const { controller, showError } = start(settings, sonnet, {
			scopedModels: [{ model: sonnet }],
			scopedModelsFromSettings: true,
		});

		await openModelHub(controller).onUnassign("default");

		expect(showError).not.toHaveBeenCalled();
		expect(session?.model?.id).toBe("claude-opus-4-5");
	});

	it.each(["explicit", "settings"] as const)("keeps the live model on a disallowed %s-scope default", async scope => {
		authStorage.keys.setRuntime("openrouter", "test-key");
		const base = "openrouter/z-ai/glm-4.7";
		const allowed = `${base}@cerebras`;
		await Bun.write(
			tempDir.join(".omp", "config.yml"),
			YAML.stringify({
				modelRoles: { default: `${base}@sambanova` },
				enabledModels: scope === "settings" ? [allowed] : [],
			}),
		);
		const settings = await Settings.init({ agentDir: tempDir.join("agent"), cwd: tempDir.path() });
		const initial = model("claude-sonnet-4-5");
		const { controller, showError } = start(settings, initial);
		if (scope === "explicit") {
			const routed = parseModelPattern(allowed, [getBundledModel("openrouter", "z-ai/glm-4.7") as Model]).model;
			if (!routed) throw new Error(`Missing fixture model ${allowed}`);
			session?.setScopedModels([{ model: routed }]);
		}

		await openModelHub(controller).onUnassign("default");

		expect(showError).not.toHaveBeenCalled();
		expect(session?.model?.id).toBe(initial.id);
	});

	it("switches to the persisted default when only its route differs from the live model", async () => {
		authStorage.keys.setRuntime("openrouter", "test-key");
		const base = "openrouter/z-ai/glm-4.7";
		const fallback = `${base}@sambanova`;
		await Bun.write(tempDir.join(".omp", "config.yml"), YAML.stringify({ modelRoles: { default: fallback } }));
		const settings = await Settings.init({ agentDir: tempDir.join("agent"), cwd: tempDir.path() });
		const { model: initial } = parseModelPattern(`${base}@cerebras`, [
			getBundledModel("openrouter", "z-ai/glm-4.7") as Model,
		]);
		if (!initial) throw new Error("Missing live route fixture");
		const { controller, showError } = start(settings, initial);

		await openModelHub(controller).onUnassign("default");

		expect(showError).not.toHaveBeenCalled();
		expect(session?.model && formatModelStringWithRouting(session.model)).toBe(fallback);
	});

	it("refreshes the open hub once a confirmed compaction point has moved the model to its extended window", async () => {
		const settings = await Settings.init({ agentDir: tempDir.join("agent"), cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		const registry = session!.modelRegistry;
		const terra = registry.find("openai", "gpt-5.6-terra");
		if (!terra) throw new Error("Expected bundled gpt-5.6-terra");
		const refreshed = Promise.withResolvers<number | null | undefined>();
		vi.spyOn(modelHubModule, "ModelHub").mockImplementation(props => {
			props.onState?.({
				// The window the hub would re-read when it refreshes.
				refreshAfterExternalMutation: () =>
					refreshed.resolve(registry.find("openai", "gpt-5.6-terra")?.contextWindow),
			} as unknown as ModelHubState);
			queueMicrotask(() => {
				expect(props.callbacks.onCompactionPointChange?.(terra, "400k", true)).toBeUndefined();
			});
			return jsx("picker", {});
		});
		controller.showModelSelector();

		expect(await refreshed.promise).toBe(1_050_000);
		expect(showError).not.toHaveBeenCalled();
	});
});
