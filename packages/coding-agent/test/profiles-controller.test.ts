import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, SqliteAuthCredentialStore, type UsageReport } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ProfileDashboard } from "@oh-my-pi/pi-coding-agent/modes/components/profile-dashboard";
import type { ProfileEditorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/profile-editor";
import { ProfilesController, type ProfilesHost } from "@oh-my-pi/pi-coding-agent/modes/controllers/profiles-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { parseProfileText, saveSetup } from "@oh-my-pi/pi-coding-agent/profiles/setups";
import { PROFILE_EMOJIS } from "@oh-my-pi/pi-coding-agent/profiles/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "@oh-my-pi/pi-coding-agent/task/settings";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { AgentsHubComponent } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import type { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const NEW_SESSION = "Start a new session";
const HOUR = 3_600_000;
const SONNET_45 = "anthropic/claude-sonnet-4-5";
const SONNET_46 = "anthropic/claude-sonnet-4-6";

function quotaReport(now: number, provider = "anthropic"): UsageReport {
	return {
		provider,
		fetchedAt: now,
		limits: [
			{
				id: "5h",
				label: "5h",
				scope: { provider, windowId: "5h", shared: true },
				window: { id: "5h", label: "5h", durationMs: 5 * HOUR, resetsAt: now + 5 * HOUR },
				amount: { unit: "percent", usedFraction: 0.18 },
			},
		],
	};
}
/** A saved profile holding an entry a newer omp wrote and this version skips on load. */
const FOCUS_WITH_FUTURE_ENTRY = [
	"$setup:",
	"  version: 1",
	"  enabledGroups: [context]",
	"modelRoles:",
	"  smol: anthropic/claude-haiku-4-5",
	"compaction:",
	"  enabled: true",
	"futureSection:",
	"  flag: true",
	"",
].join("\n");
/** The saved `focus` profile plus a safety setting; imports and exports never carry it. */
const FOCUS_WITH_SAFETY_SETTING = [
	"$setup:",
	"  version: 1",
	"  enabledGroups: [context]",
	"modelRoles:",
	"  smol: anthropic/claude-haiku-4-5",
	"compaction:",
	"  enabled: true",
	"tools:",
	"  approvalMode: yolo",
	"",
].join("\n");
/** Narrow TUI stub: the agents hub only reads terminal rows and requests renders. */
const TUI_STUB = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

interface DialogOptions {
	signal?: AbortSignal;
}

interface ShownDialog<T> {
	promise: Promise<T>;
	signal: AbortSignal | undefined;
	message: string;
}

/** Like the real dialogs: resolve with `answer`, or with `aborted` once the signal fires. */
function dialog<T>(answer: Promise<T>, aborted: T, signal: AbortSignal | undefined): Promise<T> {
	if (signal?.aborted) return Promise.resolve(aborted);
	const { promise, resolve } = Promise.withResolvers<T>();
	signal?.addEventListener("abort", () => resolve(aborted), { once: true });
	void answer.then(resolve);
	return promise;
}

/** Resolves on the next `fire(value)`; each call to `next()` waits for a later one. */
function signalQueue<T>() {
	let pending = Promise.withResolvers<T>();
	return {
		next: () => pending.promise,
		fire: (value: T) => {
			pending.resolve(value);
			pending = Promise.withResolvers<T>();
		},
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("ProfilesController", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let configPath: string;
	let authStorage: AuthStorage;
	let liveSession: AgentSession | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@omp-profiles-controller-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		setAgentDir(agentDir);
		setProjectDir(projectDir);
		configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, "compaction:\n  enabled: false\n");
		await saveSetup(
			"focus",
			{
				metadata: { version: 1, enabledGroups: ["context"] },
				config: { modelRoles: { smol: "anthropic/claude-haiku-4-5" }, compaction: { enabled: true } },
			},
			{ agentDir },
		);
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	});

	afterEach(async () => {
		await liveSession?.dispose();
		liveSession = undefined;
		authStorage.close();
		AgentStorage.close();
		// AgentStorage's one-off schema statements are finalized only by GC, and
		// until then SQLite keeps agent.db open; Windows cannot delete an open file,
		// so removal would retry for seconds and can outlast the test timeout.
		Bun.gc(true);
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		await tempDir.remove();
	});

	/**
	 * Saved profile `focus` holding `lines` plus an entry this version skips.
	 * Warning about that entry is the last step of a new-session load.
	 */
	async function saveFocus(lines: string[]): Promise<void> {
		const document = ["$setup:", "  version: 1", ...lines, "futureSection:", "  flag: true", ""];
		await Bun.write(path.join(agentDir, "setups", "focus.yml"), document.join("\n"));
	}

	/** A real session starting on Sonnet 4.5 at `thinkingLevel`, with usage kept offline. */
	function startLiveSession(settings: Settings, modelRegistry: ModelRegistry, thinkingLevel: ThinkingLevel) {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled claude-sonnet-4-5 model");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(projectDir),
			settings,
			modelRegistry,
			thinkingLevel,
		});
		liveSession = session;
		vi.spyOn(session, "fetchUsageReports").mockResolvedValue(null);
		return session;
	}

	/** The live session's model and configured thinking selector, e.g. `["anthropic/claude-sonnet-4-5", "auto"]`. */
	function liveSelection(session: AgentSession): Array<string | undefined> {
		return [session.model && `${session.model.provider}/${session.model.id}`, session.configuredThinkingLevel()];
	}

	async function harness(
		options: {
			fetchUsageReports?: () => Promise<UsageReport[] | null>;
			/** Drive a real AgentSession on Sonnet 4.5 at this thinking level instead of the session stub. */
			liveThinking?: ThinkingLevel;
		} = {},
	) {
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		// The live session's models are available only with an Anthropic credential.
		if (options.liveThinking !== undefined) authStorage.keys.setRuntime("anthropic", "fixture-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
		const live =
			options.liveThinking === undefined
				? undefined
				: startLiveSession(settings, modelRegistry, options.liveThinking);
		const choice = Promise.withResolvers<string | undefined>();
		/** Queued selector answers, used before the pending `choice`. */
		const choices: Array<string | undefined> = [];
		const confirm = Promise.withResolvers<boolean>();
		const confirmShown = Promise.withResolvers<ShownDialog<boolean>>();
		const refreshed = Promise.withResolvers<void>();
		const inputs: Array<string | undefined> = [];
		const prompts: string[] = [];
		const confirmTitles: string[] = [];
		const editors = signalQueue<ProfileEditorComponent>();
		let editorsOpened = 0;
		const settingsShown = signalQueue<void>();
		const rendered = signalQueue<void>();
		const hubs = signalQueue<{ hub: AgentsHubComponent; initialAgent: string | undefined }>();
		const startNewSession = vi.fn(async (_label: string) => true);
		const warnings = signalQueue<string>();
		const showWarning = vi.fn((message: string) => warnings.fire(message));
		const ctx = {
			settings,
			session: live ?? {
				model: undefined,
				modelRegistry,
				isStreaming: false,
				configuredThinkingLevel: () => undefined,
				getAvailableModels: () => [],
				refreshBaseSystemPrompt: async () => refreshed.resolve(),
				setModelTemporary: async () => {},
				setThinkingLevel: () => {},
				sessionId: "profiles-test",
				fetchUsageReports: options.fetchUsageReports ?? (async () => null),
				getUsageReportingModelSelectors: () => [],
			},
			sessionManager: { getCwd: () => projectDir },
			ui: { requestRender: () => rendered.fire(), setFocus: () => {}, terminal: { rows: 40 } },
			statusLine: {},
			showWarning,
			startNewSession,
			showHookSelector: (_title: string, _items: unknown, options?: DialogOptions) =>
				dialog(choices.length > 0 ? Promise.resolve(choices.shift()) : choice.promise, undefined, options?.signal),
			showHookConfirm: (title: string, message: string, options?: DialogOptions) => {
				confirmTitles.push(title);
				const promise = dialog(confirm.promise, false, options?.signal);
				confirmShown.resolve({ promise, signal: options?.signal, message });
				return promise;
			},
			showHookInput: async (title: string, _placeholder?: string, options?: DialogOptions) => {
				prompts.push(title);
				return options?.signal?.aborted ? undefined : inputs.shift();
			},
		} as unknown as InteractiveModeContext;
		const host: ProfilesHost = {
			showFullscreenMenu: (component: Component) => {
				editorsOpened++;
				editors.fire(component as ProfileEditorComponent);
				return { hide: () => {}, setHidden: () => {} } as unknown as OverlayHandle;
			},
			showModelHub: () => () => {},
			showAgentsDashboard: async options => {
				if (!options.deps) throw new Error("Only the profile draft's agents hub is under test");
				const done = () => options.onDone?.();
				const hub = await AgentsHubComponent.create(
					TUI_STUB,
					options.deps,
					{ onCancel: done },
					{ title: options.title, initialAgent: options.initialAgent },
				);
				hubs.fire({ hub, initialAgent: options.initialAgent });
				return done;
			},
			acquireDefaultRoleMutation: async () => () => {},
		};
		const controller = new ProfilesController(ctx, host);
		let dashboard: ProfileDashboard | undefined;
		const selector = {
			setProfilesContent: (component: Component) => {
				dashboard = component as ProfileDashboard;
			},
			selectTab: () => {},
		} as unknown as SettingsSelectorComponent;
		// Every Profiles interaction ends by revealing the Settings overlay again.
		const overlay = {
			setHidden: (hidden: boolean) => {
				if (!hidden) settingsShown.fire();
			},
			hide: () => {},
		} as unknown as OverlayHandle;
		const closeSettings = vi.fn(() => controller.close());
		const mount = () => controller.mount(selector, overlay, closeSettings);
		/** Select the saved `focus` profile, press `l`, and choose a new session. */
		const loadFocus = () => {
			dashboard!.handleInput("\x1b[B");
			dashboard!.handleInput("l");
			choice.resolve(NEW_SESSION);
		};
		await mount();
		return {
			settings,
			controller,
			choice,
			choices,
			confirm,
			confirmShown: confirmShown.promise,
			refreshed: refreshed.promise,
			inputs,
			prompts,
			confirmTitles,
			nextEditor: editors.next,
			editorsOpened: () => editorsOpened,
			nextSettingsShown: settingsShown.next,
			startNewSession,
			showWarning,
			live,
			nextHub: hubs.next,
			closeSettings,
			mount,
			dashboard: () => dashboard!,
			screen: () => stripVTControlCharacters(dashboard!.render(160, 40).join("\n")),
			/**
			 * Wait on real render requests until `predicate` holds. If the awaited
			 * change never happens this never settles, and Bun on Windows does not
			 * time such a test out, so keep predicates specific.
			 */
			renderedUntil: async (predicate: () => boolean) => {
				while (!predicate()) await rendered.next();
			},
			loadFocus,
			/** Confirm loading a {@link saveFocus} profile in a new session; resolves with its skipped-entry warning once done. */
			loadFocusInNewSession: () => {
				const warned = warnings.next();
				loadFocus();
				confirm.resolve(true);
				return warned;
			},
			/** Reopen Settings after a load, unload the profile, and wait until Settings shows again. */
			unload: async () => {
				await mount();
				const shown = settingsShown.next();
				dashboard!.handleInput("u");
				await shown;
			},
		};
	}

	it("applies a new-session load after the session starts, live through listeners, without writing config.yml", async () => {
		const configBytes = await Bun.file(configPath).bytes();
		const h = await harness();
		const compactionChanges: Array<[next: boolean, previous: boolean]> = [];
		cfgCompactionEnabled.listen(h.settings, (next, previous) => {
			compactionChanges.push([next, previous]);
		});
		let compactionAtStart: unknown;
		h.startNewSession.mockImplementation(async () => {
			compactionAtStart = cfgCompactionEnabled.get(h.settings);
			return true;
		});
		h.loadFocus();
		h.confirm.resolve(true);
		await h.refreshed;

		expect(h.closeSettings).toHaveBeenCalledTimes(1);
		expect(compactionAtStart).toBe(false);
		expect(cfgCompactionEnabled.get(h.settings)).toBe(true);
		expect(h.settings.getModelRole("smol")).toBe("anthropic/claude-haiku-4-5");
		expect(await Bun.file(configPath).bytes()).toEqual(configBytes);
		// Listeners apply every setting's live effect, so loading a profile reaches them like a Settings edit.
		expect(compactionChanges).toEqual([[true, false]]);
	});

	it("leaves the setup unapplied and says so when a hook cancels the new session", async () => {
		const h = await harness();
		const started = Promise.withResolvers<{ result: Promise<boolean> }>();
		h.startNewSession.mockImplementation(() => {
			const result = Promise.resolve(false);
			started.resolve({ result });
			return result;
		});
		h.loadFocus();
		h.confirm.resolve(true);
		const { result } = await started.promise;
		// The controller awaited this promise first, so its continuation has already run.
		await result;

		expect(cfgCompactionEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getModelRole("smol")).toBeUndefined();
		// Settings closed before the session switch, so only a chat warning can reach the user.
		expect(h.showWarning).toHaveBeenCalledTimes(1);
		expect(h.showWarning.mock.calls[0]![0]).toContain("focus");
	});

	it("lists the safety settings a profile sets before starting a session with it", async () => {
		await Bun.write(path.join(agentDir, "setups", "focus.yml"), FOCUS_WITH_SAFETY_SETTING);
		const h = await harness();
		h.loadFocus();
		const shown = await h.confirmShown;
		expect(shown.message).toContain("Tool Approval");
		expect(shown.message).toContain("yolo");
		h.confirm.resolve(false);
		expect(await shown.promise).toBe(false);
		expect(h.startNewSession).not.toHaveBeenCalled();
	});

	it("unloads a loaded profile, restoring config values with their live effects; Unload needs a loaded profile", async () => {
		const configBytes = await Bun.file(configPath).bytes();
		const h = await harness();
		expect(h.screen()).not.toContain("u to unload profile");
		h.dashboard().handleInput("u");
		expect(h.confirmTitles).toEqual([]);

		h.loadFocus();
		h.confirm.resolve(true);
		await h.refreshed;
		await h.mount();
		const loaded = h.screen().split("\n");
		expect(loaded.find(line => line.includes("Active session"))).toContain("focus");
		expect(loaded.join("\n")).toContain("u to unload profile");

		const compactionChanges: boolean[] = [];
		cfgCompactionEnabled.listen(h.settings, next => {
			compactionChanges.push(next);
		});
		const unloaded = h.nextSettingsShown();
		h.dashboard().handleInput("u");
		await unloaded;
		expect(cfgCompactionEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getModelRole("smol")).toBeUndefined();
		expect(compactionChanges).toEqual([false]);
		expect(h.screen()).not.toContain("u to unload profile");
		expect(await Bun.file(configPath).bytes()).toEqual(configBytes);
	});

	it("moves a live session to a profile's Thinking Level on the same model, and back to the user's on unload", async () => {
		await Bun.write(configPath, "compaction:\n  enabled: false\ndefaultThinkingLevel: medium\n");
		await saveFocus(["defaultThinkingLevel: auto"]);
		const h = await harness({ liveThinking: ThinkingLevel.Low });
		const session = h.live!;

		expect(await h.loadFocusInNewSession()).toContain("skipped");
		// The default role is Automatic, so the model stays and only the Thinking Level applies.
		expect(liveSelection(session)).toEqual([SONNET_45, AUTO_THINKING]);
		expect(session.isAutoThinking).toBe(true);

		await h.unload();
		expect(liveSelection(session)).toEqual([SONNET_45, ThinkingLevel.Medium]);
		expect(session.isAutoThinking).toBe(false);
	});

	it("unloading a profile that re-pointed the default's alias target restores the user's model and thinking", async () => {
		await Bun.write(
			configPath,
			[
				"compaction:",
				"  enabled: false",
				"defaultThinkingLevel: medium",
				"modelRoles:",
				"  default: '@slow'",
				`  slow: ${SONNET_45}`,
				"",
			].join("\n"),
		);
		await saveFocus(["modelRoles:", `  slow: ${SONNET_46}:low`]);
		const h = await harness({ liveThinking: ThinkingLevel.Medium });
		const session = h.live!;

		expect(await h.loadFocusInNewSession()).toContain("skipped");
		expect(liveSelection(session)).toEqual([SONNET_46, ThinkingLevel.Low]);

		// The default is still the user's own `@slow`; only what it resolves to changes.
		await h.unload();
		expect(liveSelection(session)).toEqual([SONNET_45, ThinkingLevel.Medium]);
	});

	it("keeps a session-only model on unload when the profile's default selects what the user's does", async () => {
		await Bun.write(configPath, `compaction:\n  enabled: false\nmodelRoles:\n  default: ${SONNET_45}\n`);
		await saveFocus(["modelRoles:", `  default: ${SONNET_45}`]);
		const h = await harness({ liveThinking: ThinkingLevel.High });
		const session = h.live!;
		expect(await h.loadFocusInNewSession()).toContain("skipped");
		await session.setModelTemporary(session.modelRegistry.find("anthropic", "claude-sonnet-4-6")!);

		await h.unload();
		expect(liveSelection(session)).toEqual([SONNET_46, ThinkingLevel.High]);
	});

	it("closing Settings while a load dialog is pending aborts it without starting a session", async () => {
		const h = await harness();
		h.loadFocus();
		const shown = await h.confirmShown;
		expect(shown.signal).toBeDefined();

		h.controller.close();
		expect(await shown.promise).toBe(false);
		h.confirm.resolve(true);

		expect(h.startNewSession).not.toHaveBeenCalled();
		expect(cfgCompactionEnabled.get(h.settings)).toBe(false);
	});

	it("re-prompts for a taken name without overwriting it, and a cancelled edit writes nothing", async () => {
		const focusPath = path.join(agentDir, "setups", "focus.yml");
		const focusBytes = await Bun.file(focusPath).bytes();
		const h = await harness();

		const cancelledEditor = h.nextEditor();
		h.dashboard().handleInput("s");
		const cancelledShown = h.nextSettingsShown();
		(await cancelledEditor).handleInput("\x1b");
		await cancelledShown;
		expect(fs.readdirSync(path.join(agentDir, "setups"))).toEqual(["focus.yml"]);

		h.inputs.push("focus", "fresh");
		const savingEditor = h.nextEditor();
		h.dashboard().handleInput("s");
		const savedShown = h.nextSettingsShown();
		(await savingEditor).handleInput("\x13");
		await savedShown;

		expect(h.prompts).toHaveLength(2);
		expect(h.prompts[1]).toContain("already exists");
		expect(await Bun.file(focusPath).bytes()).toEqual(focusBytes);
		expect(fs.readdirSync(path.join(agentDir, "setups")).sort()).toEqual(["focus.yml", "fresh.yml"]);
		expect(h.screen()).toContain("fresh");
	});

	it("writes a saved profile's emoji at once and alone, keeping entries this version skipped", async () => {
		const focusPath = path.join(agentDir, "setups", "focus.yml");
		await Bun.write(focusPath, FOCUS_WITH_FUTURE_ENTRY);
		const readFocus = () => YAML.parse(fs.readFileSync(focusPath, "utf8")) as Record<string, Record<string, unknown>>;
		const emoji = PROFILE_EMOJIS[0]!.emoji;
		const h = await harness();
		const editorShown = h.nextEditor();
		h.dashboard().handleInput("\x1b[B");
		h.dashboard().handleInput("\r");
		const editor = await editorShown;

		editor.handleInput("\r");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		await h.renderedUntil(() => readFocus().$setup?.emoji === emoji);
		expect(h.screen()).toContain(`${emoji} focus`);

		expect(readFocus()).toEqual({
			$setup: { version: 1, enabledGroups: ["context"], emoji },
			modelRoles: { smol: "anthropic/claude-haiku-4-5" },
			compaction: { enabled: true },
			futureSection: { flag: true },
		});
		const closed = h.nextSettingsShown();
		editor.handleInput("\x1b");
		await closed;
		expect(readFocus().$setup?.emoji).toBe(emoji);
	});

	it("names the skipped entries an overwrite would drop before saving", async () => {
		const focusPath = path.join(agentDir, "setups", "focus.yml");
		await Bun.write(focusPath, FOCUS_WITH_FUTURE_ENTRY);
		const before = await Bun.file(focusPath).bytes();
		const h = await harness();
		const editorShown = h.nextEditor();
		h.dashboard().handleInput("\x1b[B");
		h.dashboard().handleInput("\r");
		(await editorShown).handleInput("\x13");

		const shown = await h.confirmShown;
		expect(shown.message).toContain("futureSection");
		h.confirm.resolve(false);
		expect(await shown.promise).toBe(false);
		expect(await Bun.file(focusPath).bytes()).toEqual(before);
	});

	it("exports a saved profile models-only to a new file and never replaces an existing one", async () => {
		const taken = path.join(projectDir, "taken.yml");
		await Bun.write(taken, "keep me\n");
		const target = path.join(projectDir, "shared.yml");
		const h = await harness();
		h.choices.push("Models only", "Save to file");
		h.inputs.push(taken, target);
		const done = h.nextSettingsShown();
		h.dashboard().handleInput("\x1b[B");
		h.dashboard().handleInput("x");
		await done;

		expect(await Bun.file(taken).text()).toBe("keep me\n");
		expect(h.prompts[1]).toContain("already exists");
		expect(parseProfileText(await Bun.file(target).text())).toEqual({
			metadata: { version: 1, enabledGroups: [] },
			config: { modelRoles: { smol: "anthropic/claude-haiku-4-5" } },
			warnings: [],
			withheld: [],
		});
	});

	it("exports a whole profile without its safety settings and names what it left out", async () => {
		await Bun.write(path.join(agentDir, "setups", "focus.yml"), FOCUS_WITH_SAFETY_SETTING);
		const target = path.join(projectDir, "shared.yml");
		const h = await harness();
		h.choices.push("Whole profile", "Save to file");
		h.inputs.push(target);
		const done = h.nextSettingsShown();
		h.dashboard().handleInput("\x1b[B");
		h.dashboard().handleInput("x");
		await done;

		const exported = YAML.parse(await Bun.file(target).text()) as Record<string, Record<string, unknown>>;
		expect(exported.compaction).toEqual({ enabled: true });
		expect(exported.tools?.approvalMode).toBeUndefined();
		expect(h.screen()).toContain("Tool Approval");
	});

	it("imports clipboard text into the editor when reviewing, flags skipped entries and unavailable models, and saves it new", async () => {
		vi.spyOn(clipboard, "readTextFromClipboard").mockResolvedValue(
			"$setup:\n  version: 1\nmodelRoles:\n  smol: nowhere/unknown-model\nretiredSection:\n  flag: true\n",
		);
		const h = await harness();
		h.choices.push("From clipboard", "Yes, review it first");
		h.inputs.push("focus", "shared");
		const editorShown = h.nextEditor();
		h.dashboard().handleInput("i");
		const editor = await editorShown;

		expect(stripVTControlCharacters(editor.render(160).join("\n"))).toContain("retiredSection");
		editor.handleInput("\x1b[B");
		expect(stripVTControlCharacters(editor.render(160).join("\n"))).toContain("not available");
		const saved = h.nextSettingsShown();
		editor.handleInput("\x13");
		await saved;

		expect(h.prompts).toHaveLength(2);
		expect(h.prompts[1]).toContain("already exists");
		const stored = parseProfileText(await Bun.file(path.join(agentDir, "setups", "shared.yml")).text());
		expect(stored.config).toEqual({ modelRoles: { smol: "nowhere/unknown-model" } });
		expect(h.screen()).toContain("Imported profile shared");
	});

	it("saves an import straight to a new name when review is declined", async () => {
		vi.spyOn(clipboard, "readTextFromClipboard").mockResolvedValue("modelRoles:\n  smol: nowhere/unknown-model\n");
		const h = await harness();
		h.choices.push("From clipboard", "No, save it now");
		h.inputs.push("focus", "quick");
		const done = h.nextSettingsShown();
		h.dashboard().handleInput("i");
		await done;

		expect(h.editorsOpened()).toBe(0);
		expect(h.prompts[1]).toContain("already exists");
		const stored = parseProfileText(await Bun.file(path.join(agentDir, "setups", "quick.yml")).text());
		expect(stored.config).toEqual({ modelRoles: { smol: "nowhere/unknown-model" } });
		expect(h.screen()).toContain("Imported profile quick");

		// The mark outlives closing Settings, and only the imported profile has it.
		h.controller.close();
		await h.mount();
		const rows = h.screen().split("\n");
		expect(rows.some(row => row.includes("quick (New)"))).toBe(true);
		expect(rows.some(row => row.includes("focus (New)"))).toBe(false);
	});

	it("imports without a shared profile's safety settings and names what it left out", async () => {
		vi.spyOn(clipboard, "readTextFromClipboard").mockResolvedValue(FOCUS_WITH_SAFETY_SETTING);
		const h = await harness();
		h.choices.push("From clipboard", "No, save it now");
		h.inputs.push("shared");
		const done = h.nextSettingsShown();
		h.dashboard().handleInput("i");
		await done;

		const stored = YAML.parse(await Bun.file(path.join(agentDir, "setups", "shared.yml")).text()) as Record<
			string,
			Record<string, unknown>
		>;
		expect(stored.compaction).toEqual({ enabled: true });
		expect(stored.tools?.approvalMode).toBeUndefined();
		expect(h.screen()).toContain("Tool Approval");
	});

	it("edits a draft's agents in the agents hub without touching live settings or offering agent creation", async () => {
		await Bun.write(
			path.join(agentDir, "setups", "focus.yml"),
			[
				"$setup:",
				"  version: 1",
				"  enabledGroups: [tasks]",
				"task:",
				"  agentModelOverrides:",
				"    reviewer: anthropic/claude-haiku-4-5",
				"",
			].join("\n"),
		);
		const configBytes = await Bun.file(configPath).bytes();
		const h = await harness();
		const editorShown = h.nextEditor();
		h.dashboard().handleInput("\x1b[B");
		h.dashboard().handleInput("\r");
		const editor = await editorShown;
		for (const character of "reviewer") editor.handleInput(character);
		const hubShown = h.nextHub();
		editor.handleInput("\r");
		const { hub, initialAgent } = await hubShown;
		expect(initialAgent).toBe("reviewer");
		expect(stripVTControlCharacters(hub.render(120).join("\n"))).not.toContain("New agent");

		hub.handleInput(" "); // disable reviewer
		hub.handleInput("\r"); // agent strip, model first
		hub.handleInput("\r"); // model values: pick model…, pattern…, clear override
		hub.handleInput("\x1b[C");
		hub.handleInput("\x1b[C");
		hub.handleInput("\r");
		hub.handleInput("\x1b"); // leave the hub
		const task = () =>
			editor.draft.config.task as { disabledAgents?: string[]; agentModelOverrides?: Record<string, unknown> };
		// A cleared override is stored as null (Automatic), which masks the user's own override once loaded.
		await h.renderedUntil(() => task().agentModelOverrides?.reviewer === null);

		expect(task().disabledAgents).toContain("reviewer");
		expect(cfgTaskDisabledAgents.get(h.settings)).not.toContain("reviewer");
		expect(cfgTaskAgentModelOverrides.get(h.settings)).toEqual({});
		expect(await Bun.file(configPath).bytes()).toEqual(configBytes);
	});

	it("writes nothing when the review question is cancelled", async () => {
		vi.spyOn(clipboard, "readTextFromClipboard").mockResolvedValue("modelRoles:\n  smol: nowhere/unknown-model\n");
		const h = await harness();
		h.choices.push("From clipboard", "Cancel");
		const done = h.nextSettingsShown();
		h.dashboard().handleInput("i");
		await done;

		expect(h.editorsOpened()).toBe(0);
		expect(h.prompts).toEqual([]);
		expect(fs.readdirSync(path.join(agentDir, "setups"))).toEqual(["focus.yml"]);
	});

	it("shows usage on saved profiles too, limited to the providers each one uses", async () => {
		authStorage.keys.setRuntime("anthropic", "fixture-key");
		const usage = Promise.withResolvers<UsageReport[] | null>();
		const h = await harness({ fetchUsageReports: () => usage.promise });
		expect(h.screen()).not.toContain("Anthropic");
		usage.resolve([quotaReport(Date.now()), quotaReport(Date.now(), "zai")]);
		// The controller awaited this promise first, so the reports are attached already.
		await usage.promise;
		expect(h.screen()).toContain("Anthropic");

		// The saved `focus` profile routes smol to Anthropic and nothing to Zai.
		h.dashboard().handleInput("\x1b[B");
		await h.renderedUntil(() => h.screen().includes("Saved profile") && !h.screen().includes("Loading preview"));
		const saved = h.screen().split("\n");
		const anthropic = saved.find(line => line.includes("Anthropic"));
		expect(anthropic).toContain("82%");
		expect(anthropic).toContain("smol");
		expect(saved.join("\n")).not.toContain("Zai");
	});

	it("returning to Profiles rediscovers added setups and drops missing ones", async () => {
		const h = await harness();
		expect(h.screen()).toContain("focus");

		fs.rmSync(path.join(agentDir, "setups", "focus.yml"));
		await saveSetup("added", { metadata: { version: 1, enabledGroups: [] }, config: {} }, { agentDir });
		await h.mount();

		const screen = h.screen();
		expect(screen).toContain("added");
		expect(screen).not.toContain("focus");
	});

	it("returning to Profiles reports a failed rediscovery and keeps the listed setups", async () => {
		const h = await harness();
		const setupsDir = path.join(agentDir, "setups");
		fs.rmSync(setupsDir, { recursive: true });
		fs.writeFileSync(setupsDir, "not a folder");

		// Settings starts this without awaiting it, where a rejection ends omp.
		await h.mount();

		const screen = h.screen();
		expect(screen).toContain("ENOTDIR");
		expect(screen).toContain("focus");
	});
});
