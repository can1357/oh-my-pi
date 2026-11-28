import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentState } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pluginHelpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { buildModelScopeNotification, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { beginStartupComposer } from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { stopPendingStartupComposer } from "@oh-my-pi/pi-coding-agent/modes/startup-frame";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import {
	__resetDirsFromEnvForTests,
	getProjectDir,
	isInteractiveHost,
	setAgentDir,
	setInteractiveHost,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { createTestSession, type TestSessionContext } from "./utilities";
import { initTheme } from "../src/ui/theme/service";

function scopedModel(id: string): ScopedModel {
	return {
		model: buildModel({
			id,
			name: id,
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		}),
		explicitThinkingLevel: false,
	};
}

function setSessionModel(session: TestSessionContext["session"], model: Model | undefined): void {
	const agentState: Partial<AgentState> = session.agent.state;
	agentState.model = model;
}

describe("buildModelScopeNotification", () => {
	it("does not emit startup model scope chrome while suppressed", () => {
		expect(buildModelScopeNotification([scopedModel("claude-sonnet-4-5")], true)).toBeNull();
	});
});

const NO_MODEL_WARNING = "No default model selected. Use /login.";
const FALLBACK_NOTICE = "Model claude-missing not found. Using anthropic/claude-3-5-haiku";
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_PROFILE", "OMP_PROFILE"] as const;

// The startup model fallback notice is computed before the first-run setup runs; the setup
// may select a model before the startup notices are shown (issue #8053).
describe("startup model fallback notice after first-run setup", () => {
	let tmp: string;
	let settings: Settings;
	let testSession: TestSessionContext;
	let mode: InteractiveMode | undefined;
	let originalProject: string;
	let savedInteractiveHost: boolean;
	const savedEnv = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
		savedInteractiveHost = isInteractiveHost();
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-startup-warning-"));
		setAgentDir(path.join(tmp, "agent"));
		originalProject = getProjectDir();
		setProjectDir(tmp);
		resetSettingsForTest();
		initTheme();
		settings = await Settings.init({ inMemory: true, cwd: tmp });
		cfgStartupCheckUpdate.override(settings, false);
		cfgStartupChangelogMode.override(settings, "hidden");
		cfgStartupSetupWizard.override(settings, false);
		cfgStartupShowSplash.override(settings, false);
		cfgMarketplaceAutoUpdate.override(settings, "off");
		testSession = await createTestSession({ inMemory: true });
		// The launch has no default model: sdk.ts starts its agent with an undefined initial model.
		setSessionModel(testSession.session, undefined);
	});

	afterEach(async () => {
		mode?.stop();
		mode = undefined;
		stopPendingStartupComposer();
		await testSession.cleanup();
		vi.restoreAllMocks();
		clearOmpExtensionCliRoots();
		resetSettingsForTest();
		setProjectDir(originalProject);
		setInteractiveHost(savedInteractiveHost);
		for (const key of ENV_KEYS) {
			const value = savedEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		// The startup opened process-wide agent, history, session-index and model databases under tmp.
		AgentStorage.close();
		// startup-composer.test.ts leaves the process-wide history database open on its deleted
		// directory, and closing that handle fails its checkpoint. close() has already dropped it.
		try {
			HistoryStorage.close();
		} catch (err) {
			// The stale handle left by startup-composer.test.ts; see above.
			if (err instanceof Error && err.message.includes("disk I/O error")) return;
			if ((err as { code?: string })?.code?.startsWith("SQLITE_IOERR")) return;
			throw err;
		}
		closeSessionIndex();
		closeModelCache();
		await fs.rm(tmp, { recursive: true, force: true });
	});

	/**
	 * Runs the real interactive startup with `fallbackMessage` as the session's fallback notice and returns the
	 * warnings shown before the first prompt. `setupModelId`, when given, is the model the stubbed setup selects.
	 */
	async function startupWarnings(fallbackMessage: string, setupModelId?: string): Promise<string[]> {
		const interrupted = new Error("stop at the first prompt");
		const shown: string[] = [];
		const showWarning = InteractiveMode.prototype.showWarning;
		spyOn(InteractiveMode.prototype, "showWarning").mockImplementation(function (
			this: InteractiveMode,
			message,
			...rest
		) {
			shown.push(message);
			return showWarning.call(this, message, ...rest);
		});
		const renderInitialMessages = InteractiveMode.prototype.renderInitialMessages;
		spyOn(InteractiveMode.prototype, "renderInitialMessages").mockImplementation(async function (
			this: InteractiveMode,
			options,
		) {
			// Stubbed setup step: runs before the startup notices are shown.
			if (setupModelId) {
				const model = scopedModel(setupModelId).model;
				// Sign-in stores a credential for the provider before the model it selects.
				this.session.modelRegistry.authStorage.keys.setRuntime(model.provider, "setup-test-key");
				await this.session.setModel(model, "default", { persist: false });
			}
			await renderInitialMessages.call(this, options);
		});
		spyOn(InteractiveMode.prototype, "getUserInput").mockImplementation(async function (this: InteractiveMode) {
			mode = this;
			throw interrupted;
		});
		spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
		spyOn(pluginHelpers, "preloadPluginRoots").mockResolvedValue(undefined);
		beginStartupComposer({
			driver: memoryTerminal({ columns: 80, rows: 24 }).options,
			version: "test",
			cache: false,
		});
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const authStorage = await AuthStorage.create(path.join(tmp, "auth.db"));
		try {
			const rawArgs = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp"];
			await expect(
				runRootCommand(parseArgs(rawArgs), rawArgs, {
					settings,
					discoverAuthStorage: async () => authStorage,
					createAgentSession: async options => {
						if (!options?.preloadedExtensions || !options.eventBus) throw new Error("Missing startup context");
						await options.sessionManager?.close();
						return {
							session: testSession.session,
							setToolUIContext: () => {},
							extensionsResult: options.preloadedExtensions,
							eventBus: options.eventBus,
							modelFallbackMessage: fallbackMessage,
						};
					},
				}),
			).rejects.toBe(interrupted);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
			authStorage.close();
		}
		return shown;
	}

	it("does not show the no-model warning once setup has selected a model", async () => {
		expect(await startupWarnings(NO_MODEL_WARNING, "claude-sonnet-4-5")).not.toContain(NO_MODEL_WARNING);
	});

	it("keeps the no-model warning when setup leaves the session without a model", async () => {
		expect(await startupWarnings(NO_MODEL_WARNING)).toContain(NO_MODEL_WARNING);
	});

	it("keeps a model fallback notice when setup leaves the session's model unchanged", async () => {
		setSessionModel(testSession.session, scopedModel("claude-3-5-haiku").model);
		expect(await startupWarnings(FALLBACK_NOTICE)).toContain(FALLBACK_NOTICE);
	});

	it("does not show a model fallback notice once setup has selected a different model", async () => {
		setSessionModel(testSession.session, scopedModel("claude-3-5-haiku").model);
		expect(await startupWarnings(FALLBACK_NOTICE, "claude-sonnet-4-5")).not.toContain(FALLBACK_NOTICE);
	});
});
