/**
 * Contracts: /vibe mode toggle on InteractiveMode.
 *
 * 1. Vibe tools do not exist in the session registry before the mode is entered.
 * 2. Entering registers and activates exactly `read`, parent-owned `todo`, plus
 *    the vibe tools.
 * 3. Exiting unregisters the vibe tools and restores the pre-vibe active toolset
 *    exactly, including the legitimate empty set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, VIBE_MODE_CONTEXT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function vibeModeEntryCount(manager: SessionManager): number {
	return manager.getEntries().filter(entry => entry.type === "mode_change" && entry.mode === "vibe").length;
}

class ExitFaultStorage extends FileSessionStorage {
	failNextAtomicWrite = false;
	#readGate:
		| {
				filePath: string;
				started: ReturnType<typeof Promise.withResolvers<void>>;
				release: ReturnType<typeof Promise.withResolvers<void>>;
		  }
		| undefined;

	gateNextRead(filePath: string): { started: Promise<void>; release: () => void } {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		this.#readGate = { filePath, started, release };
		return { started: started.promise, release: release.resolve };
	}

	override async readText(filePath: string): Promise<string> {
		const gate = this.#readGate;
		if (gate?.filePath === filePath) {
			this.#readGate = undefined;
			gate.started.resolve();
			await gate.release.promise;
		}
		return super.readText(filePath);
	}

	override async writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.failNextAtomicWrite) {
			this.failNextAtomicWrite = false;
			throw Object.assign(new Error("journal atomic publish failed"), { code: "ENOSPC" });
		}
		await super.writeTextAtomic(filePath, content, options);
	}
}

describe("InteractiveMode vibe mode toggle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let streamFn: StreamFn | undefined;
	let mode: InteractiveMode;
	let modelRegistry: ModelRegistry;
	let storage: ExitFaultStorage;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-vibe-toggle-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		VibeSessionRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		// prompt() preflights credentials via modelRegistry.getApiKey; the
		// in-memory auth storage has no anthropic key, so stub it.
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		const registryTools = [stubTool("read"), stubTool("todo")];
		storage = new ExitFaultStorage();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				convertToLlm,
				streamFn: (...args) => {
					if (!streamFn) throw new Error("No test stream configured");
					return streamFn(...args);
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path(), storage),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
			builtInToolNames: registryTools.map(tool => tool.name),
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, new EventBus());
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		VibeSessionRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("preserves the parent Todo tool and restores the exact pre-vibe toolset on exit", async () => {
		expect(session.getAllToolNames().toSorted()).toEqual(["read", "todo"]);
		expect(session.getActiveToolNames()).toEqual([]);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		const inMode = session.getActiveToolNames();
		expect(inMode).toContain("read");
		expect(inMode).toContain("todo");
		for (const name of VIBE_TOOL_NAMES) {
			expect(inMode).toContain(name);
		}
		expect(inMode.toSorted()).toEqual(["read", "todo", ...VIBE_TOOL_NAMES].toSorted());
		expect(session.getAllToolNames().toSorted()).toEqual(["read", "todo", ...VIBE_TOOL_NAMES].toSorted());

		// Toggle off: the empty previous toolset must come back — only the
		// ephemeral vibe tools must leave the registry.
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.getAllToolNames().toSorted()).toEqual(["read", "todo"]);
	});

	it("removes the Vibe directive from provider context on exit", async () => {
		const vibeDirectivePerCall: boolean[] = [];
		streamFn = (_model, context) => {
			vibeDirectivePerCall.push(JSON.stringify(context).includes("<vibe-mode>"));
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
			});
			return stream;
		};

		await mode.handleVibeModeCommand();
		await session.prompt("Delegate this");
		await mode.handleVibeModeCommand();
		await session.prompt("Use the restored tools");

		expect(vibeDirectivePerCall).toEqual([true, false]);
	});

	it("removes a queued Vibe directive when exiting during a model turn", async () => {
		const vibeDirectivePerCall: boolean[] = [];
		const firstStarted = Promise.withResolvers<void>();
		streamFn = (_model, context, options) => {
			vibeDirectivePerCall.push(JSON.stringify(context).includes("<vibe-mode>"));
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				if (vibeDirectivePerCall.length === 1) {
					options?.signal?.addEventListener(
						"abort",
						() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
						{ once: true },
					);
					firstStarted.resolve();
				} else {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				}
			});
			return stream;
		};

		const prompt = session.prompt("Start normally");
		await firstStarted.promise;
		await mode.handleVibeModeCommand();
		expect(
			session.agent
				.peekSteeringQueue()
				.some(message => message.role === "custom" && message.customType === VIBE_MODE_CONTEXT_MESSAGE_TYPE),
		).toBe(true);

		await mode.handleVibeModeCommand();
		await prompt;
		await session.waitForIdle();
		await session.prompt("Use the restored tools");

		expect(vibeDirectivePerCall).toEqual([false, false]);
	});

	it("omits persisted Vibe directives from restored model context", () => {
		session.sessionManager.appendCustomMessageEntry(
			VIBE_MODE_CONTEXT_MESSAGE_TYPE,
			"<vibe-mode>stale</vibe-mode>",
			false,
		);

		const restoredMessages = convertToLlm(session.sessionManager.buildSessionContext().messages);

		expect(JSON.stringify(restoredMessages)).not.toContain("<vibe-mode>");
	});

	it("cancels an in-flight model turn before removing Vibe tools", async () => {
		const started = Promise.withResolvers<void>();
		streamFn = (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				options?.signal?.addEventListener(
					"abort",
					() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
					{ once: true },
				);
				started.resolve();
			});
			return stream;
		};
		await mode.handleVibeModeCommand();
		const prompt = session.prompt("Delegate this");
		await started.promise;
		expect(session.isStreaming).toBe(true);

		await mode.handleVibeModeCommand();
		await prompt;

		expect(session.isStreaming).toBe(false);
		expect(session.getToolByName("vibe_spawn")).toBeUndefined();
	});

	it("holds a user steer queued during Vibe teardown until the tools are removed", async () => {
		const toolNamesPerCall: string[][] = [];
		const firstStarted = Promise.withResolvers<void>();
		streamFn = (_model, context, options) => {
			toolNamesPerCall.push((context.tools ?? []).map(tool => tool.name));
			const isFirst = toolNamesPerCall.length === 1;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				if (isFirst) {
					options?.signal?.addEventListener(
						"abort",
						() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
						{ once: true },
					);
					firstStarted.resolve();
				} else {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Resumed") });
				}
			});
			return stream;
		};

		await mode.handleVibeModeCommand();
		const prompt = session.prompt("Delegate this");
		await firstStarted.promise;

		const abortSettled = Promise.withResolvers<void>();
		const releaseTeardown = Promise.withResolvers<void>();
		const abort = session.abort.bind(session);
		vi.spyOn(session, "abort").mockImplementation(async options => {
			await abort(options);
			abortSettled.resolve();
			await releaseTeardown.promise;
		});
		const exit = mode.handleVibeModeCommand();
		await abortSettled.promise;
		// Queue while teardown is still guarded. The regular queue path clears its
		// retry block, but must not clear the independent mode-exit suppression.
		await session.steer("and then do the other thing");
		// Drain the microtasks in which an unguarded schedule calls
		// agent.continue(). The queued steer must remain owned by the queue until
		// teardown releases.
		for (let index = 0; index < 5; index++) await Promise.resolve();
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		expect(toolNamesPerCall.length).toBe(1);
		releaseTeardown.resolve();

		await exit;
		await prompt;
		await session.waitForIdle();

		expect(toolNamesPerCall.length).toBe(2);
		for (const name of VIBE_TOOL_NAMES) {
			expect(toolNamesPerCall[1]).not.toContain(name);
		}
		expect(session.getVibeModeState()).toBeUndefined();
		expect(session.getToolByName("vibe_spawn")).toBeUndefined();
	});

	it("holds IRC wakes during Vibe teardown until the tools are removed", async () => {
		const toolNamesPerCall: string[][] = [];
		const firstStarted = Promise.withResolvers<void>();
		streamFn = (_model, context, options) => {
			toolNamesPerCall.push((context.tools ?? []).map(tool => tool.name));
			const isFirst = toolNamesPerCall.length === 1;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				if (isFirst) {
					options?.signal?.addEventListener(
						"abort",
						() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
						{ once: true },
					);
					firstStarted.resolve();
				} else {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Resumed") });
				}
			});
			return stream;
		};

		await mode.handleVibeModeCommand();
		const prompt = session.prompt("Delegate this");
		await firstStarted.promise;
		await session.deliverIrcMessage({ id: "m1", from: "peer", to: "me", body: "first", ts: Date.now() });

		const abortSettled = Promise.withResolvers<void>();
		const releaseTeardown = Promise.withResolvers<void>();
		const abort = session.abort.bind(session);
		vi.spyOn(session, "abort").mockImplementation(async options => {
			await abort(options);
			abortSettled.resolve();
			await releaseTeardown.promise;
		});
		const exit = mode.handleVibeModeCommand();
		await abortSettled.promise;
		await session.deliverIrcMessage({ id: "m2", from: "peer", to: "me", body: "second", ts: Date.now() });
		for (let index = 0; index < 5; index++) await Promise.resolve();
		expect(toolNamesPerCall).toHaveLength(1);
		releaseTeardown.resolve();

		await exit;
		await prompt;
		await session.waitForIdle();

		expect(toolNamesPerCall).toHaveLength(2);
		for (const name of VIBE_TOOL_NAMES) {
			expect(toolNamesPerCall[1]).not.toContain(name);
		}
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "irc:incoming",
			),
		).toHaveLength(2);
	});

	it("keeps a same-named non-built-in Todo tool unavailable in Vibe mode", async () => {
		const model = session.model;
		if (!model) throw new Error("Expected active model");
		const foreignTodoSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
			toolRegistry: new Map(["read", "todo"].map(name => [name, stubTool(name)])),
			builtInToolNames: ["read"],
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
		});
		const foreignTodoMode = new InteractiveMode(
			foreignTodoSession,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new EventBus(),
		);

		try {
			await foreignTodoMode.handleVibeModeCommand();
			expect(foreignTodoSession.getActiveToolNames().toSorted()).toEqual(["read", ...VIBE_TOOL_NAMES].toSorted());

			await foreignTodoMode.handleVibeModeCommand();
			expect(foreignTodoSession.getActiveToolNames()).toEqual([]);
			expect(foreignTodoSession.getAllToolNames().toSorted()).toEqual(["read", "todo"]);
		} finally {
			foreignTodoMode.stop();
			await foreignTodoSession.dispose();
		}
	});

	it("preserves workers, Todo access, and mode metadata on a same-session reload", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const registry = VibeSessionRegistry.global();
		const suspend = vi.spyOn(registry, "suspendScope");
		const terminate = vi.spyOn(registry, "killAll");

		const readGate = storage.gateNextRead(sessionFile);
		const switching = session.switchSession(sessionFile);
		await readGate.started;
		const suspendCallsBeforeRead = suspend.mock.calls.length;
		readGate.release();
		expect(suspendCallsBeforeRead).toBe(1);
		expect(await switching).toBe(true);

		expect(mode.vibeModeEnabled).toBe(true);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "todo", ...VIBE_TOOL_NAMES]));
		expect(suspend).toHaveBeenCalledTimes(1);
		expect(terminate).not.toHaveBeenCalled();
		expect(vibeModeEntryCount(session.sessionManager)).toBe(1);
	});

	it("restores the target's pre-vibe toolset when switching from one vibe session into another", async () => {
		const model = session.model;
		if (!model) throw new Error("Expected active model");
		// The shared fixture's pre-vibe active set is empty, which cannot
		// distinguish a restored snapshot from a lost one. Use sessions whose
		// pre-vibe toolset contains a tool vibe strips (`bash`).
		const openFixture = () => {
			const opened = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
					},
				}),
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				settings: Settings.isolated({}),
				modelRegistry,
				toolRegistry: new Map(["read", "todo", "bash"].map(name => [name, stubTool(name)])),
				builtInToolNames: ["read", "todo", "bash"],
				createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
			});
			return {
				session: opened,
				mode: new InteractiveMode(opened, "test", undefined, undefined, undefined, undefined, new EventBus()),
			};
		};

		// Target session: left in vibe mode on disk.
		const { session: targetSession, mode: targetMode } = openFixture();
		let targetFile: string;
		try {
			await targetMode.init({ suppressWelcomeIntro: true });
			await targetSession.setActiveToolsByName(["read", "todo", "bash"]);
			await targetMode.handleVibeModeCommand();
			expect(targetSession.getActiveToolNames()).not.toContain("bash");
			await targetSession.sessionManager.ensureOnDisk();
			const file = targetSession.sessionFile;
			if (!file) throw new Error("Expected persisted session file");
			targetFile = file;
		} finally {
			targetMode.stop();
			await targetSession.dispose();
		}

		// Source session, also in vibe mode, switches into the target. Because the
		// source is in vibe, `#clearTransientModeState` takes the
		// `removeVibeToolsPreservingActive` path: it deliberately keeps the live
		// active set rather than applying the source's own snapshot. That live set
		// is the reduced vibe set, so the re-entry driven by reconciliation must
		// take its snapshot from the target's persisted mode_change entry rather
		// than from re-reading the live toolset.
		//
		// Switching in from a non-vibe session is unaffected: the teardown path
		// does not run, so the live toolset is still the source's full set. Neither
		// is a cold start, where the process builds the full toolset before
		// reconciliation runs.
		const { session: sourceSession, mode: sourceMode } = openFixture();
		try {
			await sourceMode.init({ suppressWelcomeIntro: true });
			await sourceSession.setActiveToolsByName(["read", "todo", "bash"]);
			await sourceMode.handleVibeModeCommand();
			expect(sourceMode.vibeModeEnabled).toBe(true);

			expect(await sourceSession.switchSession(targetFile)).toBe(true);
			expect(sourceMode.vibeModeEnabled).toBe(true);

			await sourceMode.handleVibeModeCommand();
			expect(sourceMode.vibeModeEnabled).toBe(false);
			expect(sourceSession.getActiveToolNames().toSorted()).toEqual(["bash", "read", "todo"]);
		} finally {
			sourceMode.stop();
			await sourceSession.dispose();
		}
	});

	it("keeps the freshly built toolset when resuming a vibe session from outside vibe mode", async () => {
		const model = session.model;
		if (!model) throw new Error("Expected active model");
		const openFixture = (toolNames: string[]) => {
			const opened = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
					},
				}),
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				settings: Settings.isolated({}),
				modelRegistry,
				toolRegistry: new Map(toolNames.map(name => [name, stubTool(name)])),
				builtInToolNames: toolNames,
				createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
			});
			return {
				session: opened,
				mode: new InteractiveMode(opened, "test", undefined, undefined, undefined, undefined, new EventBus()),
			};
		};

		// Target session entered vibe when only `read` and `todo` existed, so its
		// persisted snapshot predates `bash`.
		const { session: targetSession, mode: targetMode } = openFixture(["read", "todo"]);
		let targetFile: string;
		try {
			await targetMode.init({ suppressWelcomeIntro: true });
			await targetSession.setActiveToolsByName(["read", "todo"]);
			await targetMode.handleVibeModeCommand();
			await targetSession.sessionManager.ensureOnDisk();
			const file = targetSession.sessionFile;
			if (!file) throw new Error("Expected persisted session file");
			targetFile = file;
		} finally {
			targetMode.stop();
			await targetSession.dispose();
		}

		// The resuming process is not in vibe mode, so the teardown path never
		// runs and its live toolset — built from the current CLI flags and
		// settings, here including `bash` — is the real pre-vibe set. The stale
		// persisted snapshot must not override it, or `bash` would be dropped for
		// the rest of the session.
		const { session: resumed, mode: resumedMode } = openFixture(["read", "todo", "bash"]);
		try {
			await resumedMode.init({ suppressWelcomeIntro: true });
			await resumed.setActiveToolsByName(["read", "todo", "bash"]);
			expect(resumedMode.vibeModeEnabled).toBe(false);

			expect(await resumed.switchSession(targetFile)).toBe(true);
			expect(resumedMode.vibeModeEnabled).toBe(true);
			expect(resumed.getActiveToolNames()).not.toContain("bash");

			await resumedMode.handleVibeModeCommand();
			expect(resumedMode.vibeModeEnabled).toBe(false);
			expect(resumed.getActiveToolNames().toSorted()).toEqual(["bash", "read", "todo"]);
		} finally {
			resumedMode.stop();
			await resumed.dispose();
		}
	});

	it("passes the session's active model into vibe rehydration on resume", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const expectedModel = session.model;
		if (!expectedModel) throw new Error("Expected an active session model");
		const registry = VibeSessionRegistry.global();
		let rehydrateCalled = false;
		let activeModelDuringRehydrate: string | undefined;
		vi.spyOn(registry, "rehydrate").mockImplementation(async parent => {
			rehydrateCalled = true;
			activeModelDuringRehydrate = parent.getActiveModelString?.();
			return 0;
		});

		expect(await session.switchSession(sessionFile)).toBe(true);

		// Rehydration must resolve workers against the reopened session's active
		// model (so the `good`/pi/task worker tracks it), not the settings default.
		expect(rehydrateCalled).toBe(true);
		expect(activeModelDuringRehydrate).toBe(`${expectedModel.provider}/${expectedModel.id}`);
	});

	it("suspends the old scope without tombstones when switching to another vibe parent", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const originalSessionId = session.sessionManager.getSessionId();
		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendModeChange("vibe");
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();
		const registry = VibeSessionRegistry.global();
		const suspend = vi.spyOn(registry, "suspendScope");
		const terminate = vi.spyOn(registry, "killAll");

		expect(await session.switchSession(targetFile)).toBe(true);

		expect(mode.vibeModeEnabled).toBe(true);
		expect(suspend).toHaveBeenCalledTimes(1);
		expect(suspend.mock.calls[0]?.[0]).toMatchObject({ parentSessionId: originalSessionId });
		expect(terminate).not.toHaveBeenCalled();
		expect(vibeModeEntryCount(session.sessionManager)).toBe(1);
	});

	it("does not clobber the target's active tools with the source snapshot when switching out of vibe", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		// Pre-vibe snapshot on the source session is empty; entering vibe activates
		// read, parent-owned todo, and the vibe tools.
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		expect(session.getActiveToolNames()).toContain("read");

		// Target is a distinct, non-vibe session.
		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendModeChange("none");
		await targetManager.ensureOnDisk();
		const targetFile = targetManager.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await targetManager.close();

		expect(await session.switchSession(targetFile)).toBe(true);

		expect(mode.vibeModeEnabled).toBe(false);
		// The transient vibe tools are gone, but the genuinely-active `read` and
		// parent-owned `todo` tools must survive — the source's empty pre-vibe
		// snapshot must not wipe them.
		expect(session.getActiveToolNames()).toEqual(["read", "todo"]);
		for (const name of VIBE_TOOL_NAMES) {
			expect(session.getActiveToolNames()).not.toContain(name);
		}
	});

	it("rejects new, drop, fork, and move transitions at the AgentSession boundary while vibe is active", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");

		await expect(session.newSession()).rejects.toThrow("Exit vibe mode first");
		await expect(session.newSession({ drop: true })).rejects.toThrow("Exit vibe mode first");
		await expect(session.fork()).rejects.toThrow("Exit vibe mode first");
		await expect(session.moveSession(path.join(tempDir.path(), "other-project"))).rejects.toThrow(
			"Exit vibe mode first",
		);
		expect(session.sessionFile).toBe(sessionFile);
		expect(session.sessionManager.getCwd()).toBe(tempDir.path());
		expect(mode.vibeModeEnabled).toBe(true);
	});

	it("warns instead of rejecting for interactive session transitions while vibe is active", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const warning = vi.spyOn(mode, "showWarning");

		await expect(mode.handleClearCommand()).resolves.toBeUndefined();
		await expect(mode.handleDropCommand()).resolves.toBeUndefined();
		await expect(mode.handleForkCommand()).resolves.toBeUndefined();
		await expect(mode.handleMoveCommand(path.join(tempDir.path(), "other-project"))).resolves.toBeUndefined();

		expect(warning).toHaveBeenCalledTimes(4);
		expect(warning).toHaveBeenCalledWith("Exit vibe mode first.");
		expect(session.sessionFile).toBe(sessionFile);
		expect(mode.vibeModeEnabled).toBe(true);
	});

	it("keeps vibe mode and tools active after a real storage failure, then allows a retry", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		const activeTools = session.getActiveToolNames();
		storage.failNextAtomicWrite = true;

		const exitError = await mode.handleVibeModeCommand().catch(error => error);
		expect(exitError).toBeInstanceOf(Error);
		expect(String(exitError)).toContain("journal atomic publish failed");

		expect(mode.vibeModeEnabled).toBe(true);
		expect(session.getVibeModeState()).toEqual({ enabled: true });
		expect(session.getActiveToolNames()).toEqual(activeTools);
		expect(vibeModeEntryCount(session.sessionManager)).toBe(1);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
	});

	it("exits vibe mode after a tree branch re-anchors the owner scope (issue #10468)", async () => {
		// Status-line worktree discovery hits the native VCS addon during init,
		// which is irrelevant here; short-circuit it to the no-repository case.
		vi.spyOn(vcs, "git").mockReturnValue(null);
		vi.spyOn(vcs, "repo").mockReturnValue(null);
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);

		// A user turn taken while in vibe mode, so branching from it carries the
		// vibe mode_change entry and the branch reopens in vibe mode.
		const entryId = session.sessionManager.appendMessage({
			role: "user",
			content: "keep going",
			timestamp: Date.now(),
		});
		await session.sessionManager.ensureOnDisk();
		const originalSessionId = session.sessionManager.getSessionId();

		const result = await session.branch(entryId);
		expect(result.cancelled).toBe(false);
		expect(session.sessionManager.getSessionId()).not.toBe(originalSessionId);
		// Reconciliation re-anchored the vibe owner scope to the branched session.
		expect(mode.vibeModeEnabled).toBe(true);

		// Before the fix this threw "Vibe parent session changed before mode exit
		// could be persisted." because the owner scope stayed on the pre-branch
		// session; the toggle must now disable vibe mode cleanly.
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
		expect(session.getVibeModeState()).toBeUndefined();
	});

	it("exits vibe mode after a /btw branch re-anchors the owner scope (issue #10468)", async () => {
		vi.spyOn(vcs, "git").mockReturnValue(null);
		vi.spyOn(vcs, "repo").mockReturnValue(null);
		await mode.init({ suppressWelcomeIntro: true });
		session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() - 2 });
		session.sessionManager.appendMessage(createAssistantMessage("seed response"));
		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(true);
		await session.sessionManager.ensureOnDisk();
		const originalSessionId = session.sessionManager.getSessionId();
		const leafId = session.sessionManager.getLeafId();
		if (!leafId) throw new Error("Expected session leaf");

		const result = await session.branchFromBtw(
			"why did that happen?",
			createAssistantMessage("because reasons"),
			leafId,
			originalSessionId,
		);
		expect(result.cancelled).toBe(false);
		expect(session.sessionManager.getSessionId()).not.toBe(originalSessionId);
		expect(mode.vibeModeEnabled).toBe(true);

		await mode.handleVibeModeCommand();
		expect(mode.vibeModeEnabled).toBe(false);
		expect(session.getVibeModeState()).toBeUndefined();
	});
});
