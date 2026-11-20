/**
 * An extension's todo backend mirrors the main session's todo list: omp commits a change as it
 * always did, then hands the selected backend the whole list. A backend with `apply` is asked
 * first about a change the `todo` tool makes, and can refuse it.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
	testSetSessionShutdownHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionFactory, TodoBackendChange } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTodoBackend } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TodoTool, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

interface Tracker {
	calls: Array<{ phases: TodoPhase[]; sessionId: string }>;
	/** Changes `apply` was asked about; stays empty for a tracker without `apply`. */
	asked: TodoBackendChange[];
	/** Awaited by `replace` after the call is recorded, and by `apply` when `applyHold` is unset. */
	hold?: Promise<void>;
	/** Awaited by `apply` in place of `hold`. */
	applyHold?: Promise<void>;
	/** Resolves once `replace` or `apply` has recorded its next call. */
	entered(): Promise<void>;
	/** Thrown by `replace` and `apply` after `hold`. */
	error?: Error;
	extension: ExtensionFactory;
}

function tracker(id = "tracker", withApply = false): Tracker {
	const waiting: Array<() => void> = [];
	const answer = async (hold: Promise<void> | undefined): Promise<void> => {
		for (const resolve of waiting.splice(0)) resolve();
		await hold;
		if (self.error) throw self.error;
	};
	const self: Tracker = {
		calls: [],
		asked: [],
		entered() {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting.push(resolve);
			return promise;
		},
		extension: pi => {
			pi.registerTodoBackend({
				id,
				async replace(phases, ctx) {
					self.calls.push({ phases, sessionId: ctx.sessionManager.getSessionId() });
					await answer(self.hold);
				},
				...(withApply && {
					async apply(change: TodoBackendChange) {
						self.asked.push(change);
						await answer(self.applyHold ?? self.hold);
					},
				}),
			});
		},
	};
	return self;
}

const list = (...tasks: string[]): TodoPhase[] => [
	{ name: "Work", tasks: tasks.map(content => ({ content, status: "pending" })) },
];
const tasksOf = (backend: Tracker): string[][] =>
	backend.calls.map(call => call.phases.flatMap(phase => phase.tasks.map(task => task.content)));

describe("todo backend", () => {
	let dir: TempDir;
	let sessions: AgentSession[];

	beforeEach(() => {
		dir = TempDir.createSync("@omp-todo-backend-");
		sessions = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		testSetSessionShutdownHandlerTimeoutMs(SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
		for (const session of sessions) {
			await session.dispose();
			session.modelRegistry.authStorage.close();
		}
		dir.removeSync();
	});

	/** A session with `todo.backend` set to `backend`; `start: false` leaves `session_start` to the test. */
	async function open(
		extensions: ExtensionFactory[],
		backend?: string,
		options: Partial<CreateAgentSessionOptions> & { start?: boolean } = {},
	): Promise<{ session: AgentSession; errors: string[] }> {
		const { start, ...rest } = options;
		const authStorage = createInMemoryAuthStorage();
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
			settings: Settings.isolated(backend === undefined ? {} : { "todo.backend": backend }),
			sessionManager: SessionManager.inMemory(),
			extensions,
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
		const errors: string[] = [];
		session.extensionRunner?.onError(error => {
			if (error.event === "todo_backend") errors.push(error.error);
		});
		if (start !== false) await session.extensionRunner?.emit({ type: "session_start" });
		return { session, errors };
	}

	function todo(
		session: AgentSession,
		params: { op: string; items?: string[]; task?: string; phase?: string },
		signal?: AbortSignal,
	): Promise<AgentToolResult> {
		const tool = session.getToolByName("todo");
		if (!tool) throw new Error("todo tool is not active");
		return tool.execute("call", params, signal);
	}

	const textOf = (result: AgentToolResult): string =>
		result.content.map(part => (part.type === "text" ? part.text : "")).join("");

	/** The `todo` tool wired to `session` as omp wires it, without the wrappers that defer its first step. */
	const directTodo = (session: AgentSession) =>
		new TodoTool({
			cwd: dir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: session.settings,
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			applyTodoBackend: (change, signal) => session.applyTodoBackend(change, signal),
		});

	const settled = (session: AgentSession) => session.extensionRunner?.todoBackendSettled();

	it("gets the whole list after a todo call, an edit outside the tool and /new", async () => {
		const backend = tracker();
		const { session } = await open([backend.extension], "tracker");
		const firstId = session.sessionManager.getSessionId();

		await todo(session, { op: "init", items: ["a", "b"] });
		const afterTool = session.getTodoPhases();
		await settled(session);
		session.commitTodoPhases(list("c"));
		await settled(session);
		await session.newSession();
		await settled(session);

		expect(backend.calls).toEqual([
			{ phases: afterTool, sessionId: firstId },
			{ phases: list("c"), sessionId: firstId },
			{ phases: [], sessionId: session.sessionManager.getSessionId() },
		]);
		expect(session.sessionManager.getSessionId()).not.toBe(firstId);
	});

	it("is not called while todo.backend is native, in a subagent session, or under another id", async () => {
		const backend = tracker();
		const other = tracker("other");
		const native = await open([backend.extension]);
		const sub = await open([backend.extension], "tracker", { parentTaskPrefix: "0-Task" });
		const selected = await open([backend.extension, other.extension], "other");

		for (const { session } of [native, sub, selected]) {
			session.commitTodoPhases(list("a"));
			await settled(session);
		}

		expect(backend.calls).toEqual([]);
		expect(tasksOf(other)).toEqual([["a"]]);
	});

	it("a failing backend leaves the list committed, reports the error, and gets the list again with the next change", async () => {
		const backend = tracker();
		const { session, errors } = await open([backend.extension], "tracker");

		backend.error = new Error("tracker down");
		await todo(session, { op: "init", items: ["a"] });
		await settled(session);
		expect(session.getTodoPhases().flatMap(phase => phase.tasks.map(task => task.content))).toEqual(["a"]);
		expect(errors).toEqual(["tracker down"]);

		// The same list again: the backend never took it, so it is sent; once taken, it is not repeated.
		backend.error = undefined;
		session.commitTodoPhases(session.getTodoPhases());
		await settled(session);
		session.commitTodoPhases(session.getTodoPhases());
		await settled(session);

		expect(tasksOf(backend)).toEqual([["a"], ["a"]]);
	});

	it("lists that change while a call runs collapse into the newest", async () => {
		const backend = tracker();
		const { session } = await open([backend.extension], "tracker");
		const gate = Promise.withResolvers<void>();
		backend.hold = gate.promise;

		const inFlight = backend.entered();
		session.commitTodoPhases(list("a"));
		await inFlight;
		session.commitTodoPhases(list("b"));
		session.commitTodoPhases(list("c"));
		gate.resolve();
		await settled(session);

		expect(tasksOf(backend)).toEqual([["a"], ["c"]]);
	});

	it("a list still waiting when the session changes is not sent under the new session", async () => {
		const backend = tracker();
		const { session } = await open([backend.extension], "tracker");
		const gate = Promise.withResolvers<void>();
		backend.hold = gate.promise;

		const inFlight = backend.entered();
		session.commitTodoPhases(list("a"));
		await inFlight;
		session.commitTodoPhases(list("b"));
		// The id changes with no list set yet, as in the middle of a session switch.
		await session.sessionManager.newSession();
		gate.resolve();
		await settled(session);

		expect(tasksOf(backend)).toEqual([["a"]]);
	});

	it("a backend that never answers is given up on, and later changes still arrive", async () => {
		const backend = tracker();
		const { session, errors } = await open([backend.extension], "tracker");
		// The handler budget is a real timer inside the runner.
		testSetExtensionHandlerTimeoutMs(30);
		backend.hold = Promise.withResolvers<void>().promise;

		session.commitTodoPhases(list("a"));
		await settled(session);
		backend.hold = undefined;
		session.commitTodoPhases(list("b"));
		await settled(session);

		expect(errors).toEqual([expect.stringContaining("timed out")]);
		expect(tasksOf(backend)).toEqual([["a"], ["b"]]);
	});

	it("an id no extension registers, an empty one included, is reported once and todos keep working", async () => {
		for (const id of ["missing", ""]) {
			const { session, errors } = await open([tracker().extension], id);

			await todo(session, { op: "init", items: ["a"] });
			session.commitTodoPhases(list("b"));
			await settled(session);

			expect(session.getTodoPhases()).toEqual(list("b"));
			expect(errors).toEqual([expect.stringContaining(`"${id}"`)]);
		}
	});

	it("a list set before session_start waits for it; an empty one is not sent", async () => {
		const backend = tracker();
		const early = await open([backend.extension], "tracker", { start: false });
		const fresh = await open([backend.extension], "tracker", { start: false });

		early.session.commitTodoPhases(list("a"));
		await settled(early.session);
		expect(backend.calls).toEqual([]);

		await early.session.extensionRunner?.emit({ type: "session_start" });
		await fresh.session.extensionRunner?.emit({ type: "session_start" });
		await settled(early.session);
		await settled(fresh.session);

		expect(tasksOf(backend)).toEqual([["a"]]);
	});

	it("a session opened on a saved list sends it once started; a backend selected later gets the list with the next change", async () => {
		const backend = tracker();
		const saved = SessionManager.inMemory();
		saved.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: list("saved") });
		const resumed = await open([backend.extension], "tracker", { sessionManager: saved });
		const selectedLater = await open([backend.extension]);
		selectedLater.session.commitTodoPhases(list("before"));

		cfgTodoBackend.override(selectedLater.session.settings, "tracker");
		await settled(resumed.session);
		await settled(selectedLater.session);
		const beforeNextChange = tasksOf(backend);
		selectedLater.session.commitTodoPhases(list("before", "after"));
		await settled(selectedLater.session);

		expect(beforeNextChange).toEqual([["saved"]]);
		expect(tasksOf(backend)).toEqual([["saved"], ["before", "after"]]);
	});

	it("a whole-session fork sends the list again under the fork's id", async () => {
		const backend = tracker();
		const { session } = await open([backend.extension], "tracker", {
			sessionManager: SessionManager.create(dir.path(), path.join(dir.path(), "sessions")),
		});
		session.commitTodoPhases(list("a"));
		await settled(session);
		const original = session.sessionManager.getSessionId();

		expect(await session.fork()).toBe(true);
		await settled(session);

		expect(backend.calls).toEqual([
			{ phases: list("a"), sessionId: original },
			{ phases: list("a"), sessionId: session.sessionManager.getSessionId() },
		]);
		expect(session.sessionManager.getSessionId()).not.toBe(original);
	});

	it("a session moved to another file sends the list again under its new id", async () => {
		const backend = tracker();
		const manager = SessionManager.inMemory();
		const subscribed = spyOn(manager, "onPersistenceNotice");
		const { session } = await open([backend.extension], "tracker", { sessionManager: manager });
		session.commitTodoPhases(list("a"));
		await settled(session);

		// What a manager does when its file is open elsewhere: a new id for the same session, then the notice.
		await manager.newSession();
		for (const [notify] of subscribed.mock.calls) notify({ reason: "open-elsewhere", from: "old", to: "new" });
		await settled(session);

		expect(backend.calls.at(-1)).toEqual({ phases: list("a"), sessionId: manager.getSessionId() });
		expect(backend.calls).toHaveLength(2);
	});

	/** Lets a held backend call finish once dispose has begun closing the backend, which nothing else signals to a test. */
	function releaseOnClose(session: AgentSession, release: () => void): void {
		const runner = session.extensionRunner;
		if (!runner) throw new Error("the session has no extension runner");
		const close = runner.closeTodoBackend.bind(runner);
		spyOn(runner, "closeTodoBackend").mockImplementation(() => {
			const closed = close();
			release();
			return closed;
		});
	}

	it("dispose waits for the calls already queued; a list committed during shutdown is not sent", async () => {
		const backend = tracker();
		const order: string[] = [];
		const during: { shutdown?: () => void } = {};
		const { session } = await open(
			[
				backend.extension,
				pi =>
					pi.on("session_shutdown", () => {
						order.push("shutdown");
						during.shutdown?.();
					}),
			],
			"tracker",
		);
		during.shutdown = () => session.commitTodoPhases(list("a", "late"));
		const gate = Promise.withResolvers<void>();
		backend.hold = gate.promise.then(() => void order.push("replace"));
		releaseOnClose(session, gate.resolve);

		const inFlight = backend.entered();
		session.commitTodoPhases(list("a"));
		await inFlight;
		await session.dispose();
		await settled(session);

		expect(order).toEqual(["replace", "shutdown"]);
		expect(tasksOf(backend)).toEqual([["a"]]);
	});

	it("dispose still waits for a call made before the user switched back to native", async () => {
		const backend = tracker();
		const order: string[] = [];
		const { session } = await open(
			[backend.extension, pi => pi.on("session_shutdown", () => void order.push("shutdown"))],
			"tracker",
		);
		const gate = Promise.withResolvers<void>();
		backend.hold = gate.promise.then(() => void order.push("replace"));
		releaseOnClose(session, gate.resolve);

		const inFlight = backend.entered();
		session.commitTodoPhases(list("a"));
		await inFlight;
		cfgTodoBackend.override(session.settings, "native");
		await session.dispose();

		expect(order).toEqual(["replace", "shutdown"]);
	});

	it("a backend that never answers holds dispose no longer than the session_shutdown budget", async () => {
		const backend = tracker();
		const order: string[] = [];
		const { session } = await open(
			[backend.extension, pi => pi.on("session_shutdown", () => void order.push("shutdown"))],
			"tracker",
		);
		// Both budgets are real timers inside the runner; the handler budget stays at its 30 s default.
		testSetSessionShutdownHandlerTimeoutMs(30);
		backend.hold = Promise.withResolvers<void>().promise.then(() => void order.push("replace"));

		const inFlight = backend.entered();
		session.commitTodoPhases(list("a"));
		await inFlight;
		await session.dispose();

		expect(order).toEqual(["shutdown"]);
	});

	it("an id two extensions registered goes to the first; with that one disabled the next takes it over and gets the list, and with neither it is reported as unregistered", async () => {
		const first = tracker();
		const second = tracker();
		const { session, errors } = await open([first.extension, second.extension], "tracker");

		session.commitTodoPhases(list("a"));
		await settled(session);
		const holder = session.extensionRunner?.getTodoBackends().get("tracker")?.extension;
		session.extensionRunner?.setSuspendedExtensions(extension => extension === holder);
		session.commitTodoPhases(list("a"));
		await settled(session);
		session.extensionRunner?.setSuspendedExtensions(() => true);
		session.commitTodoPhases(list("a", "b"));
		await settled(session);

		expect(tasksOf(first)).toEqual([["a"]]);
		expect(tasksOf(second)).toEqual([["a"]]);
		expect(errors).toEqual([expect.stringContaining('"tracker"')]);
	});

	it("native, a malformed id and a missing replace are refused; a second registration replaces the extension's first", async () => {
		const refused: string[] = [];
		const called: string[] = [];
		const attempt = (name: string, register: () => void) => {
			try {
				register();
			} catch {
				refused.push(name);
			}
		};
		const { session } = await open(
			[
				pi => {
					attempt("native", () => pi.registerTodoBackend({ id: "native", replace() {} }));
					attempt("two words", () => pi.registerTodoBackend({ id: "two words", replace() {} }));
					// @ts-expect-error a JavaScript extension can pass anything
					attempt("no replace", () => pi.registerTodoBackend({ id: "no-replace" }));
					pi.registerTodoBackend({ id: "twice", replace: () => void called.push("first") });
					pi.registerTodoBackend({ id: "twice", replace: () => void called.push("second") });
				},
			],
			"twice",
		);

		session.commitTodoPhases(list("a"));
		await settled(session);

		expect(refused).toEqual(["native", "two words", "no replace"]);
		expect(called).toEqual(["second"]);
	});

	describe("apply", () => {
		const committed = (session: AgentSession): string[] =>
			session.getTodoPhases().flatMap(phase => phase.tasks.map(task => task.content));

		it("an accepted todo call commits, and the backend is not told a second time", async () => {
			const backend = tracker("tracker", true);
			const { session } = await open([backend.extension], "tracker");

			const result = await todo(session, { op: "init", items: ["a", "b"] });
			await settled(session);

			expect(result.isError).not.toBe(true);
			expect(backend.asked).toEqual([{ op: "init", previous: [], next: session.getTodoPhases() }]);
			expect(committed(session)).toEqual(["a", "b"]);
			expect(backend.calls).toEqual([]);
		});

		it("a refusal fails the call with the backend's reason on one clean line and leaves the list unchanged; an edit outside the tool is not asked about", async () => {
			const backend = tracker("tracker", true);
			const { session, errors } = await open([backend.extension], "tracker");
			session.commitTodoPhases(list("a"));
			await settled(session);

			backend.error = new Error("a needs\nevidence\x1b[2J");
			const result = await todo(session, { op: "done", task: "a" });
			// The backend still holds this list: setting it again tells it nothing.
			session.commitTodoPhases(list("a"));
			await settled(session);

			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('Todo backend "tracker" did not accept this change: a needs evidence');
			expect(textOf(result)).not.toContain("\x1b");
			expect(result.details).toMatchObject({ phases: list("a") });
			expect(session.getTodoPhases()).toEqual(list("a"));
			expect(backend.asked.map(change => change.op)).toEqual(["done"]);
			expect(tasksOf(backend)).toEqual([["a"]]);
			// A refusal is the backend's answer, not an extension error.
			expect(errors).toEqual([]);
		});

		it("after a failed replace, an accepted call is still followed by the whole list", async () => {
			const backend = tracker("tracker", true);
			const { session } = await open([backend.extension], "tracker");
			backend.error = new Error("store is down");
			session.commitTodoPhases(list("a"));
			await settled(session);
			backend.error = undefined;

			await todo(session, { op: "append", phase: "Work", items: ["b"] });
			await settled(session);

			// The backend never took ["a"], so accepting the change does not stand in for the list.
			expect(tasksOf(backend)).toEqual([["a"], ["a", "b"]]);
		});

		it("a call the backend refused, or the user aborted while it decided, leaves no reminder to retry it", async () => {
			const backend = tracker("tracker", true);
			const { session } = await open([backend.extension], "tracker", {
				model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			});
			const call = (id: string): MockResponse => ({
				content: [{ type: "toolCall", id, name: "todo", arguments: { op: "init", items: [id] } }],
			});
			const mock = createMockModel({
				responses: [call("refused"), { content: ["ok"] }, call("aborted"), { content: ["ok"] }],
			});
			session.agent.streamFn = mock.stream;
			session.modelRegistry.authStorage.keys.setRuntime("anthropic", "test-key");

			backend.error = new Error("not this week");
			await session.prompt("plan");
			backend.error = undefined;
			backend.applyHold = Promise.withResolvers<void>().promise;
			const deciding = backend.entered();
			const aborted = session.prompt("plan again");
			await deciding;
			await session.abort();
			await aborted.catch(() => {});
			await session.waitForIdle();
			await session.prompt("next");

			expect(backend.asked.map(change => change.op)).toEqual(["init", "init"]);
			// A reminder would reach the model as a developer message with the next prompt.
			expect(mock.calls.at(-1)?.context.messages.filter(message => message.role === "developer")).toEqual([]);
		});

		it("an edit that lands while the backend decides fails the call, keeps the edit and reaches the backend", async () => {
			const backend = tracker("tracker", true);
			const { session } = await open([backend.extension], "tracker");
			const gate = Promise.withResolvers<void>();
			backend.hold = gate.promise;

			const deciding = backend.entered();
			const call = todo(session, { op: "init", items: ["from the model"] });
			await deciding;
			session.commitTodoPhases(list("from the user"));
			gate.resolve();
			const result = await call;
			await settled(session);

			expect(result.isError).toBe(true);
			expect(session.getTodoPhases()).toEqual(list("from the user"));
			expect(tasksOf(backend)).toEqual([["from the user"]]);
		});

		it("a call computed before a newer list reached the backend fails without asking it", async () => {
			const backend = tracker("tracker", true);
			const { session } = await open([backend.extension], "tracker");
			const gate = Promise.withResolvers<void>();
			backend.hold = gate.promise;

			const inFlight = backend.entered();
			session.commitTodoPhases(list("a"));
			await inFlight;
			session.commitTodoPhases(list("x"));
			const call = directTodo(session).execute("call", { op: "append", phase: "Work", items: ["from the model"] });
			session.commitTodoPhases(list("y"));
			gate.resolve();
			const result = await call;
			await settled(session);

			expect(result.isError).toBe(true);
			expect(session.getTodoPhases()).toEqual(list("y"));
			expect(backend.asked).toEqual([]);
			expect(tasksOf(backend)).toEqual([["a"], ["y"]]);
		});

		it("a session change while a call waits fails it, also when the new session's list equals the one the call was built on", async () => {
			// Asked already: /new leaves an empty list, as the call's `previous` was.
			const asked = tracker("tracker", true);
			const fresh = await open([asked.extension], "tracker");
			const answer = Promise.withResolvers<void>();
			asked.applyHold = answer.promise;
			const deciding = asked.entered();
			const init = todo(fresh.session, { op: "init", items: ["a"] });
			await deciding;
			await fresh.session.newSession();
			answer.resolve();

			// Not asked yet: a fork keeps the list under a new session id.
			const waiting = tracker("tracker", true);
			const forked = await open([waiting.extension], "tracker", {
				sessionManager: SessionManager.create(dir.path(), path.join(dir.path(), "sessions")),
			});
			const gate = Promise.withResolvers<void>();
			waiting.hold = gate.promise;
			const inFlight = waiting.entered();
			forked.session.commitTodoPhases(list("a"));
			await inFlight;
			const append = directTodo(forked.session).execute("call", { op: "append", phase: "Work", items: ["b"] });
			expect(await forked.session.fork()).toBe(true);
			gate.resolve();

			expect((await init).isError).toBe(true);
			expect(fresh.session.getTodoPhases()).toEqual([]);
			expect((await append).isError).toBe(true);
			expect(waiting.asked).toEqual([]);
			expect(committed(forked.session)).toEqual(["a"]);
		});

		it("a call waiting its turn is not put to a backend that was disabled or deselected meanwhile", async () => {
			const meanwhile: Array<(session: AgentSession) => void> = [
				session => void session.extensionRunner?.setSuspendedExtensions(() => true),
				session => cfgTodoBackend.override(session.settings, "native"),
			];
			for (const leave of meanwhile) {
				const backend = tracker("tracker", true);
				const { session } = await open([backend.extension], "tracker");
				const gate = Promise.withResolvers<void>();
				backend.hold = gate.promise;
				const inFlight = backend.entered();
				session.commitTodoPhases(list("a"));
				await inFlight;

				// The direct tool reaches the backend queue before it first yields; the wrapped one would not.
				const call = directTodo(session).execute("call", { op: "append", phase: "Work", items: ["b"] });
				leave(session);
				gate.resolve();
				const result = await call;

				expect(result.isError).not.toBe(true);
				expect(backend.asked).toEqual([]);
				expect(committed(session)).toEqual(["a", "b"]);
			}
		});

		it("no answer within the handler budget fails the call and sends nothing more; a late acceptance is followed by the list as it is then", async () => {
			const backend = tracker("tracker", true);
			const { session, errors } = await open([backend.extension], "tracker");
			session.commitTodoPhases(list("a"));
			await settled(session);
			// The handler budget is a real timer inside the runner.
			testSetExtensionHandlerTimeoutMs(30);
			const late = Promise.withResolvers<void>();
			backend.applyHold = late.promise;

			const timedOut = await todo(session, { op: "append", phase: "Work", items: ["b"] });
			await settled(session);
			const beforeLateAnswer = tasksOf(backend);
			session.commitTodoPhases(list("a", "c"));
			await settled(session);
			late.resolve();
			// The backend's late answer is handled in a continuation of its own promise.
			await Bun.sleep(0);
			await settled(session);

			expect(timedOut.isError).toBe(true);
			expect(textOf(timedOut)).toContain('Todo backend "tracker" did not accept this change');
			expect(errors).toEqual([expect.stringContaining("timed out")]);
			expect(beforeLateAnswer).toEqual([["a"]]);
			// The backend took ["a", "c"] and then accepted the change omp had given up on: it gets omp's list again.
			expect(tasksOf(backend)).toEqual([["a"], ["a", "c"], ["a", "c"]]);
		});

		it("a late acceptance while another call is with the backend is followed by the committed list only", async () => {
			const backend = tracker("tracker", true);
			const { session } = await open([backend.extension], "tracker");
			session.commitTodoPhases(list("a"));
			await settled(session);
			// The handler budget is a real timer inside the runner.
			testSetExtensionHandlerTimeoutMs(30);
			const late = Promise.withResolvers<void>();
			backend.applyHold = late.promise;
			const timedOut = await todo(session, { op: "append", phase: "Work", items: ["b"] });
			testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
			const gate = Promise.withResolvers<void>();
			backend.applyHold = gate.promise;

			const deciding = backend.entered();
			// With a signal, as the agent loop calls the tool, the commit comes a step after the backend's answer.
			const retry = todo(session, { op: "append", phase: "Work", items: ["c"] }, new AbortController().signal);
			await deciding;
			late.resolve();
			// The backend's late answer is handled in a continuation of its own promise.
			await Bun.sleep(0);
			gate.resolve();
			const accepted = await retry;
			await settled(session);

			expect(timedOut.isError).toBe(true);
			expect(accepted.isError).not.toBe(true);
			// The backend took both changes; omp committed only the second and says so once: it is never
			// sent the list without the task it just accepted.
			expect(tasksOf(backend)).toEqual([["a"], ["a", "c"]]);
		});

		it("a backend that accepts after the session changed, or after it was deselected, is sent nothing for it", async () => {
			const left: Array<[(session: AgentSession) => unknown, string[][]]> = [
				[session => session.newSession(), [["a"], []]],
				[session => cfgTodoBackend.override(session.settings, "native"), [["a"]]],
			];
			for (const [leave, sentBefore] of left) {
				const backend = tracker("tracker", true);
				const { session } = await open([backend.extension], "tracker");
				session.commitTodoPhases(list("a"));
				await settled(session);
				const late = Promise.withResolvers<void>();
				backend.applyHold = late.promise;

				const deciding = backend.entered();
				const abort = new AbortController();
				const call = todo(session, { op: "append", phase: "Work", items: ["b"] }, abort.signal);
				await deciding;
				abort.abort();
				await expect(call).rejects.toThrow();
				await leave(session);
				await settled(session);
				const beforeLateAnswer = tasksOf(backend);
				late.resolve();
				// The backend's late answer is handled in a continuation of its own promise.
				await Bun.sleep(0);
				await settled(session);
				// After a session change the backend holds the new session's list: setting it again
				// tells it nothing. (Once deselected it is not told anyway.)
				session.commitTodoPhases(session.getTodoPhases());
				await settled(session);

				expect(beforeLateAnswer).toEqual(sentBefore);
				expect(tasksOf(backend)).toEqual(sentBefore);
			}
		});

		it("as the session closes, a todo call fails without asking and a late acceptance is sent nothing", async () => {
			const backend = tracker("tracker", true);
			const during: { shutdown?: () => void } = {};
			const { session } = await open(
				[backend.extension, pi => pi.on("session_shutdown", () => during.shutdown?.())],
				"tracker",
			);
			session.commitTodoPhases(list("a"));
			await settled(session);
			const late = Promise.withResolvers<void>();
			backend.applyHold = late.promise;
			const deciding = backend.entered();
			const abort = new AbortController();
			const interrupted = todo(session, { op: "append", phase: "Work", items: ["b"] }, abort.signal);
			await deciding;
			abort.abort();
			await expect(interrupted).rejects.toThrow();
			let closing: Promise<AgentToolResult> | undefined;
			during.shutdown = () => {
				closing = todo(session, { op: "append", phase: "Work", items: ["c"] });
			};

			await session.dispose();
			late.resolve();
			const result = await closing;
			await settled(session);

			expect(result?.isError).toBe(true);
			// Only the interrupted call was put to the backend.
			expect(backend.asked).toHaveLength(1);
			expect(tasksOf(backend)).toEqual([["a"]]);
		});

		it("an abort ends the call at once, also behind a held call; the backend is not asked and is sent nothing more", async () => {
			const backend = tracker("tracker", true);
			const { session } = await open([backend.extension], "tracker");
			const gate = Promise.withResolvers<void>();
			backend.hold = gate.promise;
			const held = backend.entered();
			session.commitTodoPhases(list("held"));
			await held;

			const abort = new AbortController();
			const waiting = todo(session, { op: "append", phase: "Work", items: ["b"] }, abort.signal);
			abort.abort();
			await expect(waiting).rejects.toThrow();
			gate.resolve();
			await settled(session);
			// The backend still holds this list: setting it again tells it nothing.
			session.commitTodoPhases(list("held"));
			await settled(session);

			expect(session.getTodoPhases()).toEqual(list("held"));
			expect(backend.asked).toEqual([]);
			expect(tasksOf(backend)).toEqual([["held"]]);
		});

		it("with no backend to ask, a todo call commits before it first yields", async () => {
			const native = await open([tracker("tracker", true).extension]);
			const mirrorOnly = await open([tracker().extension], "tracker");

			const committedAtOnce: string[][] = [];
			for (const { session } of [native, mirrorOnly]) {
				const call = directTodo(session).execute("call", { op: "init", items: ["a"] });
				committedAtOnce.push(committed(session));
				await call;
			}

			expect(committedAtOnce).toEqual([["a"], ["a"]]);
		});

		it("a subagent's todo call asks no backend", async () => {
			const backend = tracker("tracker", true);
			const { session } = await open([backend.extension], "tracker", { parentTaskPrefix: "0-Task" });

			await todo(session, { op: "init", items: ["a"] });

			expect(committed(session)).toEqual(["a"]);
			expect(backend.asked).toEqual([]);
		});

		it("an apply that is not a function is refused at registration", async () => {
			let refused = false;
			await open([
				pi => {
					try {
						// @ts-expect-error a JavaScript extension can pass anything
						pi.registerTodoBackend({ id: "broken", replace() {}, apply: "yes" });
					} catch {
						refused = true;
					}
				},
			]);

			expect(refused).toBe(true);
		});
	});
});
