import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { type AgentToolResult, validateAgentToolArguments } from "@oh-my-pi/pi-agent-core";
import { findScopedSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionFactory, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import {
	cfgCompactionAutoContinue,
	cfgCompactionKeepRecentTokens,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTodoBackend } from "@oh-my-pi/pi-coding-agent/tools/settings";
import {
	getLatestTodoPhasesFromEntries,
	type TodoParams,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import {
	createTodoBackendRecorder,
	createTodoSession,
	disposeTodoSession,
	flushTodoWrites,
	hold,
	type RecordedTodoBackendCall,
	settled,
	taskContents,
	type TodoSessionOptions,
	todo,
	userTodoEdits,
} from "./helpers/todo-backend";

describe("todo backends in a real session", () => {
	let tempDir: TempDir;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-backend-session-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await disposeTodoSession(session);
		await tempDir.remove();
	});

	async function createSession(options: TodoSessionOptions = {}): Promise<AgentSession> {
		const session = await createTodoSession(tempDir.path(), options);
		sessions.push(session);
		return session;
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
	async function writeSource(name: string, source: string): Promise<string> {
		const file = tempDir.join(name);
		await Bun.write(file, source);
		return file;
	}

	async function createSessionWithDeferred(deferredPath: string, backend: string): Promise<AgentSession> {
		const eventBus = new EventBus();
		const eager = await writeSource("eager.ts", "export default function() {}\n");
		const preloaded = await loadExtensions([eager], tempDir.path(), eventBus);
		return createSession({
			backend,
			eventBus,
			preloadedExtensions: preloaded,
			deferredExtensionPaths: [deferredPath],
		});
	}

	test("native todos commit inline, without waiting for deferred extensions", async () => {
		const deferred = await writeSource("deferred.ts", "export default function() {}\n");
		const session = await createSessionWithDeferred(deferred, "native");
		const list: TodoPhase[] = [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }];

		const committed = session.commitTodoPhases(list);

		expect(session.getTodoPhases()).toEqual(list);
		expect(session.hasPendingDeferredExtensions).toBe(true);
		expect(await committed).toEqual(list);
		expect(session.todoWritesQueued).toBe(false);
	});

	test("concurrent todo calls reach the backend one at a time, in call order, with `next` equal to the committed list", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		// Hold the first apply until all three calls have entered the write queue: a queue that let
		// them through would start the second apply while the first is still held.
		const allQueued = Promise.withResolvers<void>();
		const runTodoWrite = session.runTodoWrite.bind(session);
		let entered = 0;
		vi.spyOn(session, "runTodoWrite").mockImplementation((write, options) => {
			const result = runTodoWrite(write, options);
			if (++entered === 3) allQueued.resolve();
			return result;
		});
		let inFlight = 0;
		let overlapped = false;
		let held = false;
		recorder.beforeApply = async () => {
			inFlight++;
			if (inFlight > 1) overlapped = true;
			if (!held) {
				held = true;
				await allQueued.promise;
			}
			inFlight--;
		};

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

	test("a throwing apply fails the call with display-safe text and leaves the list and details.phases unchanged", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker\x1b[31m tracker" });
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		await todo(session, { op: "init", items: ["keep"] });
		const before = structuredClone(session.getTodoPhases());

		recorder.applyError = new Error("tracker\x1b[2J is\ndown");
		const result = await todo(session, { op: "append", phase: "Tasks", items: ["lost"] });

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Tracker tracker");
		expect(text(result)).toContain("tracker is down");
		expect(text(result)).not.toMatch(/[\x00-\x1f\x7f]/);
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
			return Promise.withResolvers<void>().promise;
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

		const phaseWithExtraKey = { phase: "Work", items: ["a"], evidence: "z" };
		await todo(session, {
			op: "init",
			list: [phaseWithExtraKey],
			bogus: "x",
			constructor: "y",
			toString: 1,
		} as TodoParams);

		const [call] = recorder.calls.filter(call => call.method === "apply");
		if (!call?.params) throw new Error("expected one apply call");
		expect(Object.keys(call.params).sort()).toEqual(["list", "op"]);
		expect(call.params.list).toEqual([{ phase: "Work", items: ["a"] }]);
	});

	test("apply gets the arguments the native op accepted, and none it rejected", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		const tool = session.getToolByName("todo");
		if (!tool) throw new Error("todo tool is not active");
		const modelCall = (args: Record<string, unknown>) =>
			tool.execute(
				"call",
				validateAgentToolArguments(tool, { type: "toolCall", id: "call", name: "todo", arguments: args }),
			);
		await todo(session, { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });

		const accepted = await modelCall({ op: "done", task: "a", reason: null });
		const rejected = await modelCall({ op: "done", task: "b", list: [{ phase: "x", items: [] }] });

		expect(accepted.isError).toBeUndefined();
		expect(text(rejected)).toStartWith("Invalid todo arguments:");
		expect(recorder.calls.filter(call => call.method === "apply").map(call => call.params)).toEqual([
			{ op: "init", list: [{ phase: "Work", items: ["a", "b"] }] },
			{ op: "done", task: "a" },
		]);
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

	test("a suspended extension's backend is not used: native todos and a notice until it resumes", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		const runner = session.extensionRunner;
		if (!runner) throw new Error("extension runner is not available");
		const notices = collectNotices(session);
		const applies = () => recorder.calls.filter(call => call.method === "apply").length;

		await todo(session, { op: "init", items: ["backed"] });
		expect(applies()).toBe(1);

		runner.setSuspendedExtensions(() => true);
		await flushTodoWrites(session);
		const suspended = await todo(session, { op: "append", phase: "Tasks", items: ["native while suspended"] });

		expect(suspended.isError).toBeUndefined();
		expect(applies()).toBe(1);
		expect(taskContents(session)).toEqual(["backed", "native while suspended"]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('"tracker"');

		runner.setSuspendedExtensions(() => false);
		await flushTodoWrites(session);
		await todo(session, { op: "append", phase: "Tasks", items: ["backed again"] });

		expect(applies()).toBe(2);
		expect(taskContents(session)).toEqual(["backed", "native while suspended", "backed again"]);
	});

	test("a dialog opened in create is aborted when the handler budget runs out, and the session falls back to native todos", async () => {
		const dialogSignals: Array<AbortSignal | undefined> = [];
		const hanging: ExtensionFactory = pi => {
			pi.registerTodoBackend({
				id: "asker",
				label: "Tracker asker",
				async create(ctx) {
					await ctx.ui.select("Pick a workspace", ["a", "b"]);
					throw new Error("unreachable: the dialog never resolves");
				},
			});
		};
		const session = await createSession({ backend: "asker", extensions: [hanging] });
		const ui = {
			select: (_title: string, _options: string[], dialogOptions?: { signal?: AbortSignal }) => {
				dialogSignals.push(dialogOptions?.signal);
				const dialog = Promise.withResolvers<string | undefined>();
				dialogOptions?.signal?.addEventListener("abort", () => dialog.resolve(undefined), { once: true });
				return dialog.promise;
			},
		} as unknown as ExtensionUIContext;
		await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {}, uiContext: ui });
		const notices = collectNotices(session);

		testSetExtensionHandlerTimeoutMs(50);
		try {
			const result = await todo(session, { op: "init", items: ["native works"] });

			expect(result.isError).toBeUndefined();
			expect(taskContents(session)).toEqual(["native works"]);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain('"asker"');
			expect(dialogSignals).toHaveLength(1);
			expect(dialogSignals[0]?.aborted).toBe(true);
		} finally {
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		}
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
		const deferred = await writeSource(
			"deferred-tracker.ts",
			`import * as fs from "node:fs/promises";
export default function(pi) {
	pi.registerTodoBackend({
		id: "late",
		label: "Late",
		create: () => ({
			apply: async (op) => { await fs.appendFile(${JSON.stringify(log)}, "apply:" + op + "\\n"); },
			replace: async () => {},
		}),
	});
}
`,
		);
		const session = await createSessionWithDeferred(deferred, "late");
		const notices = collectNotices(session);

		// A write starts the deferred load and waits for the resolution; "late" is unregistered until the load binds it.
		const result = await todo(session, { op: "init", items: ["via deferred backend"] });

		expect(result.isError).toBeUndefined();
		expect(await Bun.file(log).text()).toBe("apply:init\n");
		expect(notices).toEqual([]);
	});

	test("a mid-session switch finishes the in-flight write on the old backend, then uses the new one", async () => {
		const calls: RecordedTodoBackendCall[] = [];
		const a = createTodoBackendRecorder("a", { label: "Tracker a", calls });
		const b = createTodoBackendRecorder("b", { label: "Tracker b", calls });
		const gate = hold(a, "apply");
		const session = await createSession({ backend: "a", extensions: [a.extension(), b.extension()] });

		const first = todo(session, { op: "init", items: ["one"] });
		await gate.started.promise;
		cfgTodoBackend.override(session.settings, "b");
		const second = todo(session, { op: "append", phase: "Tasks", items: ["two"] });
		gate.release.resolve();
		await Promise.all([first, second]);

		expect(calls.filter(call => call.method === "apply").map(call => `${call.backend}:${call.op}`)).toEqual([
			"a:init",
			"b:append",
		]);
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
		expect(await session.runTodoWrite(async active => active?.label)).toBe("Tracker b");
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
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		await todo(session, { op: "init", items: ["base"] });
		const before = structuredClone(session.getTodoPhases());
		const gate = hold(recorder, "apply");
		const controller = new AbortController();
		const pending = todo(session, { op: "append", phase: "Tasks", items: ["ghost"] }, controller.signal);
		const heldSignal = await gate.started.promise;
		controller.abort();
		const result = await pending;

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("aborted");
		expect(result.details).toMatchObject({ op: "append", phases: before });
		expect(heldSignal.aborted).toBe(true);

		// The aborted apply has not returned, yet the next write runs and carries the full list.
		recorder.beforeApply = undefined;
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
		const gate = hold(recorder, "apply");
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		const first = todo(session, { op: "init", items: ["one"] });
		await gate.started.promise;

		const controller = new AbortController();
		const queued = todo(session, { op: "append", phase: "Tasks", items: ["never"] }, controller.signal);
		controller.abort();
		const result = await queued;
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("aborted");

		gate.release.resolve();
		await first;
		await flushTodoWrites(session);

		expect(recorder.calls.filter(call => call.method === "apply").map(call => call.op)).toEqual(["init"]);
		expect(taskContents(session)).toEqual(["one"]);
	});

	test("/new while an edit is queued rejects it and leaves the new session empty", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		await todo(session, { op: "init", items: ["old"] });

		const gate = hold(recorder, "apply");
		const inFlight = todo(session, { op: "append", phase: "Tasks", items: ["late"] });
		await gate.started.promise;
		const edit = session.commitTodoPhases([{ name: "Stale", tasks: [{ content: "stale", status: "pending" }] }]);
		// Capture settlement now; asserting with `expect(...).rejects` on a still-pending promise would block until the gate opens.
		const editSettled = settled(edit);
		const inFlightSettled = settled(inFlight);

		await session.newSession();
		gate.release.resolve();
		expect((await editSettled)?.toString()).toContain("The session changed before the todo edit was saved");
		const inFlightResult = await inFlightSettled;
		expect(inFlightResult === undefined ? "" : String(inFlightResult)).toContain(
			"The session changed before the todo edit was saved",
		);

		await flushTodoWrites(session);
		expect(session.getTodoPhases()).toEqual([]);
		expect(userTodoEdits(session)).toHaveLength(0);
		// Only the reset reaches the backend: the stale edit never does.
		expect(recorder.calls.filter(call => call.method === "replace").map(call => call.phases)).toEqual([[]]);
	});

	test("a commit whose replace settles while switchSession is swapping files never lands in the target session", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const replaceGate = hold(recorder, "replace");
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

		const editSettled = settled(
			session.commitTodoPhases([{ name: "Stale", tasks: [{ content: "stale", status: "pending" }] }]),
		);
		await replaceGate.started.promise;

		// Release the held replace while the session manager is mid-swap: the commit then runs
		// before any post-swap reload could have invalidated it.
		const originalSetSessionFile = session.sessionManager.setSessionFile.bind(session.sessionManager);
		vi.spyOn(session.sessionManager, "setSessionFile").mockImplementation(async (sessionFile: string) => {
			replaceGate.release.resolve();
			await originalSetSessionFile(sessionFile);
			await editSettled;
		});
		await session.switchSession(targetFile);

		expect((await editSettled)?.toString()).toContain("The session changed before the todo edit was saved");
		expect(session.sessionFile).toBe(targetFile);
		expect(userTodoEdits(session)).toHaveLength(0);
		expect(session.getTodoPhases()).toEqual([]);
	});

	test("switching a fresh session before any prompt does not create the backend", async () => {
		// ACP loads and forks a stored session this way, before it initializes the extension runner.
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const sessionDir = tempDir.join("sessions");
		const target = SessionManager.create(tempDir.path(), sessionDir);
		target.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await target.flush();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("target session has no file");
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });

		await session.switchSession(targetFile);

		expect(recorder.created).toBe(0);
		expect(recorder.calls).toEqual([]);
	});

	test("a maintenance reload while a commit's replace is pending does not reject the commit", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const replaceGate = hold(recorder, "replace");
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
		const editSettled = settled(edit);
		await replaceGate.started.promise;
		await session.compact();
		expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		replaceGate.release.resolve();

		expect(await editSettled).toBeUndefined();
		expect(taskContents(session)).toEqual(["kept"]);
		expect(userTodoEdits(session)).toHaveLength(1);
	});

	test("a commit that lands while a todo call's result is still unsaved is what a rebuild from the branch restores", async () => {
		const recorder = createTodoBackendRecorder("tracker", { label: "Tracker tracker" });
		const gate = hold(recorder, "apply");
		const session = await createSession({ backend: "tracker", extensions: [recorder.extension()] });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in the bundled catalog");
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "todo-call",
							name: "todo",
							arguments: { op: "init", items: ["from the tool"] },
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["done"] },
			],
		});
		session.agent.streamFn = mock.stream;
		session.agent.state.model = model;
		session.agent.getApiKey = () => "test-key";
		session.modelRegistry.authStorage.keys.setRuntime("anthropic", "test-key");

		const turn = session.prompt("make a todo list");
		await gate.started.promise;
		const edit = session.commitTodoPhases([
			{ name: "Edited", tasks: [{ content: "from the /todo edit", status: "pending" }] },
		]);
		gate.release.resolve();
		await Promise.all([turn, edit]);
		await session.waitForIdle();

		// Resume, rewind and compaction rebuild the list from the saved branch.
		const rebuilt = getLatestTodoPhasesFromEntries(session.sessionManager.getBranch());
		expect(rebuilt.flatMap(phase => phase.tasks.map(task => task.content))).toEqual(["from the /todo edit"]);
		expect(taskContents(session)).toEqual(["from the /todo edit"]);
	});
});
