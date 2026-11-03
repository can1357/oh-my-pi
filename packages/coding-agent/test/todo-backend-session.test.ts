import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { findScopedSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
	cfgCompactionAutoContinue,
	cfgCompactionKeepRecentTokens,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTodoBackend } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE, type TodoParams } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createTodoBackendRecorder, flushTodoWrites, type RecordedTodoBackendCall } from "./helpers/todo-backend";

describe("todo backends in a real session", () => {
	let tempDir: TempDir;
	const authStorages: AuthStorage[] = [];
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-backend-session-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		await tempDir.remove();
	});

	async function createSession(
		options: Partial<CreateAgentSessionOptions> & { backend?: string } = {},
	): Promise<AgentSession> {
		const { backend, ...rest } = options;
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated(backend ? { "todo.backend": backend } : {}),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read", "todo"],
			...rest,
		});
		sessions.push(session);
		return session;
	}

	/** Run one `todo` call through the session's real tool. */
	function todo(session: AgentSession, params: TodoParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const tool = session.getToolByName("todo");
		if (!tool) throw new Error("todo tool is not active");
		return tool.execute(`call-${Snowflake.next()}`, params, signal);
	}

	const taskContents = (session: AgentSession) =>
		session.getTodoPhases().flatMap(phase => phase.tasks.map(task => task.content));

	const userTodoEdits = (session: AgentSession) =>
		session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE);

	/** A tracker whose `apply` blocks while `gate.held`; `gate.started` fires when a held apply begins. */
	function createGate() {
		const gate = {
			held: false,
			started: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
			beforeApply: async () => {
				if (!gate.held) return;
				gate.started.resolve();
				await gate.release.promise;
			},
		};
		return gate;
	}

	const text = (result: AgentToolResult) =>
		result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

	function collectNotices(session: AgentSession): string[] {
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "todo-backend") notices.push(event.message);
		});
		return notices;
	}

	/** Write an extension source file; a deferred one binds only on `loadDeferredExtensions`. */
	function writeSource(name: string, source: string): string {
		const file = tempDir.join(name);
		fs.writeFileSync(file, source);
		return file;
	}

	async function createSessionWithDeferred(deferredPath: string, backend: string): Promise<AgentSession> {
		const eventBus = new EventBus();
		const eager = writeSource("eager.ts", "export default function() {}\n");
		const preloaded = await loadExtensions([eager], tempDir.path(), eventBus);
		return createSession({
			backend,
			eventBus,
			preloadedExtensions: preloaded,
			deferredExtensionPaths: [deferredPath],
		});
	}

	test("concurrent todo calls reach the backend one at a time, in call order, with `next` equal to the committed list", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		let inFlight = 0;
		let overlapped = false;
		recorder.beforeApply = async () => {
			inFlight++;
			if (inFlight > 1) overlapped = true;
			await setImmediate();
			inFlight--;
		};
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });

		await Promise.all([
			todo(session, { op: "init", items: ["one"] }),
			todo(session, { op: "append", phase: "Tasks", items: ["two"] }),
			todo(session, { op: "append", phase: "Tasks", items: ["three"] }),
		]);

		const applies = recorder.calls.filter(call => call.method === "apply");
		expect(overlapped).toBe(false);
		expect(applies.map(call => call.op)).toEqual(["init", "append", "append"]);
		expect(applies.map(call => call.phases.flatMap(phase => phase.tasks.map(task => task.content)))).toEqual([
			["one"],
			["one", "two"],
			["one", "two", "three"],
		]);
		expect(applies.at(-1)?.phases).toEqual(session.getTodoPhases());
	});

	test("a throwing apply fails the call and leaves the list and details.phases unchanged", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		await todo(session, { op: "init", items: ["keep"] });
		const before = structuredClone(session.getTodoPhases());

		recorder.applyError = new Error("tracker is down");
		const result = await todo(session, { op: "append", phase: "Tasks", items: ["lost"] });

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Tracker tracker");
		expect(text(result)).toContain("tracker is down");
		expect(result.details).toMatchObject({ op: "append", phases: before, storage: "memory" });
		expect(session.getTodoPhases()).toEqual(before);

		// The failed call does not poison the queue.
		recorder.applyError = undefined;
		const retried = await todo(session, { op: "append", phase: "Tasks", items: ["again"] });
		expect(retried.isError).toBeUndefined();
		expect(session.getTodoPhases()[0]?.tasks.map(task => task.content)).toEqual(["keep", "again"]);
	});

	test("a backend call that never settles fails after the handler budget, aborts its signal and holds no later write", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		await todo(session, { op: "init", items: ["base"] });
		const before = structuredClone(session.getTodoPhases());
		const signals: AbortSignal[] = [];
		const hang = (signal: AbortSignal) => {
			signals.push(signal);
			return new Promise<void>(() => {});
		};
		testSetExtensionHandlerTimeoutMs(50);
		try {
			recorder.beforeApply = hang;
			const stuckApply = await todo(session, { op: "append", phase: "Tasks", items: ["stuck"] });
			expect(stuckApply.isError).toBe(true);
			expect(text(stuckApply)).toContain("did not respond within 50ms");
			expect(session.getTodoPhases()).toEqual(before);

			recorder.beforeApply = undefined;
			recorder.beforeReplace = hang;
			const edited: TodoPhase[] = [{ name: "Tasks", tasks: [{ content: "edited", status: "pending" }] }];
			await expect(session.commitTodoPhases(edited)).rejects.toThrow("did not respond within 50ms");
			expect(session.getTodoPhases()).toEqual(before);
			expect(signals.map(signal => signal.aborted)).toEqual([true, true]);

			recorder.beforeReplace = undefined;
			expect(await session.commitTodoPhases(edited)).toEqual(edited);
			expect(session.getTodoPhases()).toEqual(edited);
		} finally {
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		}
	});

	test("create, apply and replace run in the session's settings scope", async () => {
		const scopes: Array<[string, Settings | undefined]> = [];
		const scoped: ExtensionFactory = pi => {
			pi.registerTodoBackend({
				id: "scoped",
				label: "Scoped",
				create() {
					scopes.push(["create", findScopedSettings()]);
					return {
						async apply() {
							scopes.push(["apply", findScopedSettings()]);
						},
						async replace() {
							scopes.push(["replace", findScopedSettings()]);
						},
					};
				},
			});
		};
		const session = await createSession({ backend: "scoped", extensions: [scoped] });

		await todo(session, { op: "init", items: ["one"] });
		await session.commitTodoPhases(session.getTodoPhases());

		expect(scopes.map(([call]) => call)).toEqual(["create", "apply", "replace"]);
		for (const [, settings] of scopes) expect(settings).toBe(session.settings);
	});

	test("view and failed batches never call apply", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		await todo(session, { op: "init", items: ["only"] });
		const afterInit = recorder.calls.filter(call => call.method === "apply").length;

		await todo(session, { op: "view" });
		const failed = await todo(session, { op: "done", task: "does not exist" });

		expect(failed.isError).toBe(true);
		expect(recorder.calls.filter(call => call.method === "apply")).toHaveLength(afterInit);
	});

	test("undeclared argument keys never reach apply", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });

		await todo(session, {
			op: "init",
			items: ["a"],
			phase: "Work",
			bogus: "x",
			constructor: "y",
			toString: 1,
		} as TodoParams);

		const [call] = recorder.calls.filter(call => call.method === "apply");
		if (!call?.params) throw new Error("expected one apply call");
		expect(Object.keys(call.params).sort()).toEqual(["items", "op", "phase"]);
	});

	test("subagent and /tan sessions do not use the backend", async () => {
		const calls: RecordedTodoBackendCall[] = [];
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker", calls });
		const subagent = await createSession({
			backend: "tracker",
			extensions: [recorder.extension()],
			taskDepth: 1,
			parentTaskPrefix: "0-Explore",
			agentId: "0-Explore",
			parentAgentId: "Main",
		});
		const clone = await createSession({
			backend: "tracker",
			extensions: [recorder.extension()],
			parentTaskPrefix: "Main-tan-1",
			agentId: "Main-tan-1",
			agentDisplayName: "tan",
			parentAgentId: "Main",
		});
		const notices = [collectNotices(subagent), collectNotices(clone)];

		for (const session of [subagent, clone]) {
			expect(await session.runTodoWrite(async active => active)).toBeUndefined();
		}

		expect(calls).toEqual([]);
		expect(recorder.created).toBe(0);
		expect(notices).toEqual([[], []]);
	});

	test("an unregistered id falls back to native todos with one notice naming the id", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const session = await createSession({ backend: "ghost", extensions: [recorder.extension()] });
		// Subscribe the way the modes do: after createAgentSession returned.
		const notices = collectNotices(session);

		const result = await todo(session, { op: "init", items: ["native works"] });
		await todo(session, { op: "append", phase: "Tasks", items: ["still native"] });

		expect(result.isError).toBeUndefined();
		expect(session.getTodoPhases()[0]?.tasks).toHaveLength(2);
		expect(recorder.calls).toEqual([]);
		expect(recorder.created).toBe(0);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('"ghost"');
		expect(notices[0]).toContain("native");
	});

	test("a throwing create falls back to native todos with one notice carrying the error", async () => {
		const recorder = createTodoBackendRecorder("broken", { label: "Tracker broken" });
		recorder.createError = new Error("no credentials");
		const session = await createSession({ backend: "broken", extensions: [recorder.extension()] });
		// Subscribe the way the modes do: after createAgentSession returned.
		const notices = collectNotices(session);

		const result = await todo(session, { op: "init", items: ["native works"] });
		await todo(session, { op: "append", phase: "Tasks", items: ["still native"] });

		expect(result.isError).toBeUndefined();
		expect(session.getTodoPhases()[0]?.tasks).toHaveLength(2);
		expect(recorder.calls.filter(call => call.method === "apply")).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('"broken"');
		expect(notices[0]).toContain("no credentials");
	});

	test("resuming a session whose backend extension is gone keeps the transcript plan and native writes", async () => {
		const sessionManager = SessionManager.inMemory();
		const plan: TodoPhase[] = [
			{
				name: "Resume",
				tasks: [
					{ content: "from transcript", status: "in_progress" },
					{ content: "next", status: "pending" },
				],
			},
		];
		sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: plan });

		const session = await createSession({ backend: "tracker", sessionManager });

		expect(session.getTodoPhases()).toEqual(plan);
		const result = await todo(session, { op: "done", task: "from transcript" });
		expect(result.isError).toBeUndefined();
		expect(session.getTodoPhases()[0]?.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});

	test("a backend registered by a deferred extension is used once it loads, without a notice", async () => {
		const log = tempDir.join("deferred-backend.log");
		const deferred = writeSource(
			"deferred-tracker.ts",
			`import * as fs from "node:fs";
export default function(pi) {
	pi.registerTodoBackend({
		id: "late",
		label: "Late",
		create: () => ({
			apply: async (op) => { fs.appendFileSync(${JSON.stringify(log)}, "apply:" + op + "\\n"); },
			replace: async () => {},
		}),
	});
}
`,
		);
		const session = await createSessionWithDeferred(deferred, "late");
		const notices = collectNotices(session);

		// Nothing may be announced before the deferred extension binds: "late" is unregistered until then.
		await setImmediate();
		expect(notices).toEqual([]);

		// A write starts the deferred load and waits for the resolution.
		const result = await todo(session, { op: "init", items: ["via deferred backend"] });

		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(log, "utf8")).toBe("apply:init\n");
		expect(notices).toEqual([]);
	});

	test("a mid-session switch finishes the in-flight write on the old backend, then uses the new one", async () => {
		const calls: RecordedTodoBackendCall[] = [];
		const a = createTodoBackendRecorder("a", { label: "Tracker a", calls });
		const b = createTodoBackendRecorder("b", { label: "Tracker b", calls });
		const applyStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		a.beforeApply = async () => {
			applyStarted.resolve();
			await release.promise;
		};
		const session = await createSession({ backend: "a", extensions: [a.extension(), b.extension()] });

		const first = todo(session, { op: "init", items: ["one"] });
		await applyStarted.promise;
		cfgTodoBackend.override(session.settings, "b");
		const second = todo(session, { op: "append", phase: "Tasks", items: ["two"] });
		release.resolve();
		await Promise.all([first, second]);

		expect(calls.filter(call => call.method === "apply").map(call => `${call.backend}:${call.op}`)).toEqual([
			"a:init",
			"b:append",
		]);

		// Nothing reaches the old backend after the switch.
		await todo(session, { op: "append", phase: "Tasks", items: ["three"] });
		const applies = calls.filter(call => call.method === "apply");
		expect(applies.filter(call => call.backend === "a")).toHaveLength(1);
		expect(applies.filter(call => call.backend === "b")).toHaveLength(2);
	});

	test("switching to native stops mirroring, and a switch alone calls neither apply nor replace", async () => {
		const calls: RecordedTodoBackendCall[] = [];
		const a = createTodoBackendRecorder("a", { label: "Tracker a", calls });
		const b = createTodoBackendRecorder("b", { label: "Tracker b", calls });
		const session = await createSession({ backend: "a", extensions: [a.extension(), b.extension()] });
		await todo(session, { op: "init", items: ["one"] });
		const seededCalls = calls.length;
		expect(b.created).toBe(0);

		cfgTodoBackend.override(session.settings, "b");
		expect(await session.runTodoWrite(async active => active?.id)).toBe("b");
		cfgTodoBackend.override(session.settings, "native");
		expect(await session.runTodoWrite(async active => active)).toBeUndefined();

		expect(b.created).toBe(1);
		expect(calls.slice(seededCalls)).toEqual([]);

		const result = await todo(session, { op: "append", phase: "Tasks", items: ["native now"] });
		expect(result.isError).toBeUndefined();
		expect(b.created).toBe(1);
		expect(calls.slice(seededCalls)).toEqual([]);
	});

	test("aborting while apply is pending returns at once, aborts apply's signal, never commits, and frees the queue", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const gate = createGate();
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		await todo(session, { op: "init", items: ["base"] });
		const before = structuredClone(session.getTodoPhases());
		let heldSignal: AbortSignal | undefined;
		recorder.beforeApply = signal => {
			heldSignal ??= signal;
			return gate.beforeApply();
		};

		gate.held = true;
		const controller = new AbortController();
		const pending = todo(session, { op: "append", phase: "Tasks", items: ["ghost"] }, controller.signal);
		await gate.started.promise;
		controller.abort();
		const result = await pending;

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("aborted");
		expect(result.details).toMatchObject({ op: "append", phases: before });
		expect(heldSignal?.aborted).toBe(true);

		// The aborted apply has not returned, yet the next write runs and carries the full list.
		gate.held = false;
		await todo(session, { op: "append", phase: "Tasks", items: ["real"] });
		const lastApply = recorder.calls.filter(call => call.method === "apply").at(-1);
		expect(lastApply?.phases.flatMap(phase => phase.tasks.map(task => task.content))).toEqual(["base", "real"]);
		expect(taskContents(session)).toEqual(["base", "real"]);

		gate.release.resolve();
		await flushTodoWrites(session);
		expect(taskContents(session)).toEqual(["base", "real"]);
	});

	test("aborting a write that is still queued skips it: apply is never called for it", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const gate = createGate();
		gate.held = true;
		recorder.beforeApply = gate.beforeApply;
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		const first = todo(session, { op: "init", items: ["one"] });
		await gate.started.promise;

		const controller = new AbortController();
		const queued = todo(session, { op: "append", phase: "Tasks", items: ["never"] }, controller.signal);
		controller.abort();
		const result = await queued;
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("aborted");

		gate.held = false;
		gate.release.resolve();
		await first;
		await flushTodoWrites(session);

		expect(recorder.calls.filter(call => call.method === "apply").map(call => call.op)).toEqual(["init"]);
		expect(taskContents(session)).toEqual(["one"]);
	});

	test("/new while an edit is queued rejects it and leaves the new session empty", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const gate = createGate();
		recorder.beforeApply = gate.beforeApply;
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		await todo(session, { op: "init", items: ["old"] });

		gate.held = true;
		const inFlight = todo(session, { op: "append", phase: "Tasks", items: ["late"] });
		await gate.started.promise;
		const edit = session.commitTodoPhases([{ name: "Stale", tasks: [{ content: "stale", status: "pending" }] }]);
		// Capture settlement now; asserting with `expect(...).rejects` on a still-pending promise would block until the gate opens.
		const editSettled = edit.then(
			() => undefined,
			(error: unknown) => error,
		);
		const inFlightSettled = inFlight.then(
			() => undefined,
			(error: unknown) => error,
		);

		await session.newSession();
		gate.held = false;
		gate.release.resolve();
		expect((await editSettled)?.toString()).toContain("The session changed before the todo edit was saved");
		const inFlightResult = await inFlightSettled;
		expect(inFlightResult === undefined ? "" : String(inFlightResult)).toContain(
			"The session changed before the todo edit was saved",
		);

		expect(session.getTodoPhases()).toEqual([]);
		expect(userTodoEdits(session)).toHaveLength(0);
		expect(recorder.calls.some(call => call.method === "replace")).toBe(false);
	});

	test("a commit whose replace settles while switchSession is swapping files never lands in the target session", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const replaceGate = createGate();
		recorder.beforeReplace = async () => {
			replaceGate.started.resolve();
			await replaceGate.release.promise;
		};
		const sessionDir = tempDir.join("sessions");
		const target = SessionManager.create(tempDir.path(), sessionDir);
		target.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await target.flush();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("target session has no file");
		const session = await createSession({
			backend: "tracker",
			extensions: [recorder.extension()],
			sessionManager: SessionManager.create(tempDir.path(), sessionDir),
		});

		const edit = session.commitTodoPhases([{ name: "Stale", tasks: [{ content: "stale", status: "pending" }] }]);
		const editSettled = edit.then(
			() => undefined,
			(error: unknown) => error,
		);
		await replaceGate.started.promise;

		// Release the held replace while the session manager is mid-swap: the commit then runs
		// before any post-swap reload could have invalidated it.
		const originalSetSessionFile = session.sessionManager.setSessionFile.bind(session.sessionManager);
		session.sessionManager.setSessionFile = async (sessionFile: string) => {
			replaceGate.release.resolve();
			await originalSetSessionFile(sessionFile);
			await editSettled;
		};
		await session.switchSession(targetFile);

		expect((await editSettled)?.toString()).toContain("The session changed before the todo edit was saved");
		expect(session.sessionFile).toBe(targetFile);
		expect(userTodoEdits(session)).toHaveLength(0);
		expect(session.getTodoPhases()).toEqual([]);
	});

	test("a maintenance reload while a commit's replace is pending does not reject the commit", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const replaceGate = createGate();
		replaceGate.held = true;
		recorder.beforeReplace = async () => {
			replaceGate.started.resolve();
			await replaceGate.release.promise;
		};
		const hook: ExtensionFactory = pi => {
			pi.on("session_before_compact", async event => ({
				compaction: {
					summary: "compacted",
					shortSummary: undefined,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			}));
		};
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled test model missing");
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension(), hook], model });
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.set(session.settings, false);
		session.sessionManager.appendMessage(createAssistantMessage("previous answer"));
		session.sessionManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });

		const edit = session.commitTodoPhases([{ name: "Kept", tasks: [{ content: "kept", status: "pending" }] }]);
		const editSettled = edit.then(
			() => undefined,
			(error: unknown) => error,
		);
		await replaceGate.started.promise;
		await session.compact();
		expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		replaceGate.release.resolve();

		expect(await editSettled).toBeUndefined();
		expect(taskContents(session)).toEqual(["kept"]);
		expect(userTodoEdits(session)).toHaveLength(1);
	});
});
