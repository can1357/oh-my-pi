import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as modelHubModule from "@oh-my-pi/pi-tui/overlays/model-hub";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

const model = (id: string) => getBundledModel("anthropic", id) as Model;

// Settings writes made through the model hub, driven through the controller's real hub callbacks.
describe("SelectorController model hub writes", () => {
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

	function start(settings: Settings, initial: Model): { controller: SelectorController; showError: () => unknown } {
		const live = new AgentSession({
			agent: new Agent({ initialState: { model: initial, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			obfuscator: new SecretObfuscator([]),
		});
		session = live;
		const showError = vi.fn();
		const controller = new SelectorController(
			createInteractiveModeContext({
				session: live,
				settings,
				ui: { showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => false }) },
				keybindings: { getKeys: () => [], getDisplayString: () => "" },
				showError,
			}),
		);
		return { controller, showError };
	}

	function openModelHub(controller: SelectorController): modelHubModule.ModelHubCallbacks {
		let callbacks: modelHubModule.ModelHubCallbacks | undefined;
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (...args: unknown[]) {
			callbacks = args[4] as modelHubModule.ModelHubCallbacks;
			return { refreshAfterExternalMutation: () => {}, dispose: () => {} };
		} as never);
		controller.showModelSelector();
		if (!callbacks) throw new Error("model hub was not opened");
		return callbacks;
	}

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
});
