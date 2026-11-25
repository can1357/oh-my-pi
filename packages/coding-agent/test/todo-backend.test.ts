/**
 * An extension's todo backend mirrors the main session's todo list: omp commits a change as it
 * always did, then hands the selected backend the whole list.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
	testSetSessionShutdownHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory, TodoBackendDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTodoBackend } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createRoot } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import * as themeLoader from "@oh-my-pi/pi-tui/theme/loader";
import * as settingsWindowModule from "../src/ui/overlays/settings/settings";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

/** The settings window `/settings` opens for `session`: what it was given and how it reports changes. */
async function openSettings(session: AgentSession, settings: Settings) {
	spyOn(themeLoader, "listThemes").mockResolvedValue(["dark"]);
	const opened = Promise.withResolvers<{
		context: settingsWindowModule.SettingsContext;
		callbacks: settingsWindowModule.SettingsCallbacks;
	}>();
	spyOn(settingsWindowModule, "SettingsWindow").mockImplementation(props => {
		opened.resolve(props);
		return jsx("prefs", {});
	});
	const ctx = {
		session,
		settings,
		statusLine: createInteractiveModeContext().statusLine,
		shell: {
			focus: () => {},
			overlays: {
				show: (factory: () => unknown) => {
					createRoot(factory);
					return { node: jsx("col", {}), closed: false, close: () => {} };
				},
			},
		},
	} as unknown as InteractiveModeContext;
	new SelectorController(ctx).showSettingsSelector();
	const window = await opened.promise;
	/** Pick `value` for setting `path` as the window does: store it, then report the change. */
	return (path: string, value: string): void => {
		window.context.settings.set(path, value);
		window.callbacks.onChange(path, value);
	};
}

interface Tracker {
	calls: Array<{ phases: TodoPhase[]; sessionId: string }>;
	/** Awaited by `replace` after the call is recorded. */
	hold?: Promise<void>;
	/** Resolves once `replace` has recorded its next call. */
	entered(): Promise<void>;
	/** Thrown by `replace` after `hold`. */
	error?: Error;
	extension: ExtensionFactory;
}

function tracker(id = "tracker"): Tracker {
	const waiting: Array<() => void> = [];
	const self: Tracker = {
		calls: [],
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
					for (const resolve of waiting.splice(0)) resolve();
					await self.hold;
					if (self.error) throw self.error;
				},
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
		resetSettingsForTest();
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

	async function todo(session: AgentSession, params: { op: string; items: string[] }): Promise<void> {
		const tool = session.getToolByName("todo");
		if (!tool) throw new Error("todo tool is not active");
		await tool.execute("call", params);
	}

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

	it("an id no extension registers, an empty one included, is reported once until a registered id is selected, and todos keep working", async () => {
		for (const id of ["missing", ""]) {
			const { session, errors } = await open([tracker().extension], id);

			await todo(session, { op: "init", items: ["a"] });
			session.commitTodoPhases(list("b"));
			await settled(session);

			expect(session.getTodoPhases()).toEqual(list("b"));
			expect(errors).toEqual([expect.stringContaining(`"${id}"`)]);

			cfgTodoBackend.override(session.settings, "tracker");
			session.commitTodoPhases(list("c"));
			await settled(session);
			cfgTodoBackend.override(session.settings, id);
			session.commitTodoPhases(list("d"));
			await settled(session);

			expect(errors).toEqual([expect.stringContaining(`"${id}"`), expect.stringContaining(`"${id}"`)]);
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

	it("a backend the user picks in Settings gets the current list at once", async () => {
		const backend = tracker();
		// The settings panel writes to the process's settings, so the session runs on them here.
		const settings = await Settings.init({ inMemory: true });
		const { session } = await open([backend.extension], undefined, { settings });
		session.commitTodoPhases(list("before"));
		const pick = await openSettings(session, settings);
		pick(cfgTodoBackend.id, "tracker");
		await settled(session);

		expect(backend.calls).toEqual([{ phases: list("before"), sessionId: session.sessionManager.getSessionId() }]);
	});

	it("a backend picked in Settings while a runtime layer keeps another one selected gets nothing", async () => {
		const picked = tracker();
		const kept = tracker("kept");
		// The panel writes the global layer; the runtime layer above it keeps "kept" in effect.
		const settings = await Settings.init({ inMemory: true, overrides: { "todo.backend": "kept" } });
		const { session } = await open([picked.extension, kept.extension], undefined, { settings });
		session.commitTodoPhases(list("before"));
		await settled(session);
		const pick = await openSettings(session, settings);
		pick(cfgTodoBackend.id, "tracker");
		await settled(session);

		expect(picked.calls).toEqual([]);
		expect(tasksOf(kept)).toEqual([["before"]]);
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
		const manager = SessionManager.create(dir.path(), dir.path());
		const { session } = await open([backend.extension], "tracker", { sessionManager: manager });
		session.commitTodoPhases(list("a"));
		manager.appendMessage(createAssistantMessage("ok"));
		await manager.flush();
		await settled(session);
		const original = manager.getSessionId();

		// The file no longer reads as this session: the next rewrite leaves it and moves to a sibling under a new id.
		const file = manager.getSessionFile();
		if (!file) throw new Error("the session has no file");
		fs.writeFileSync(file, "not a session\n");
		await manager.rewriteEntries();
		await settled(session);

		expect(manager.getSessionId()).not.toBe(original);
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

	it("a backend that never answers holds dispose no longer than the session_shutdown budget, after which omp stops waiting for its call", async () => {
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
		// A call omp still raced against the handler budget would keep a host's process alive for
		// the rest of those 30 s.
		const left = await Promise.race([
			session.extensionRunner?.todoBackendSettled().then(() => "no call"),
			// Not a wait: a task queued behind the microtasks of a call chain that has settled.
			Bun.sleep(0).then(() => "a running call"),
		]);

		expect(order).toEqual(["shutdown"]);
		expect(left).toBe("no call");
	});

	it("a label or description that is not text, or is blank once its control sequences are removed, is refused at registration", async () => {
		const refused: string[] = [];
		const attempt = (name: string, register: () => void) => {
			try {
				register();
			} catch {
				refused.push(name);
			}
		};
		const { session } = await open([
			pi => {
				attempt("blank label", () => pi.registerTodoBackend({ id: "a", label: "\x1b[0m ", replace() {} }));
				attempt("blank description", () => pi.registerTodoBackend({ id: "b", description: " ", replace() {} }));
				// @ts-expect-error a JavaScript extension can pass anything
				attempt("label not text", () => pi.registerTodoBackend({ id: "c", label: 42, replace() {} }));
			},
		]);

		expect(refused).toEqual(["blank label", "blank description", "label not text"]);
		expect(session.extensionRunner?.getTodoBackends().size).toBe(0);
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
		expect(errors).toEqual([
			expect.stringContaining('todo backend "tracker" is ignored'),
			expect.stringContaining('No enabled extension registers the todo backend "tracker"'),
		]);
	});

	it("a backend selected by a settings change that also enables its extension is not reported as unregistered, and gets the list with the next change", async () => {
		const backend = tracker();
		const { session, errors } = await open([backend.extension]);
		session.commitTodoPhases(list("a"));
		session.extensionRunner?.setSuspendedExtensions(() => true);

		// What a config reload or a move to another project does: the setting lands before the extension.
		// An approved `cfg://` write can too, and it also runs the settings panel's hook.
		cfgTodoBackend.set(session.settings, "tracker");
		const panel = new SelectorController({
			session,
			settings: session.settings,
		} as unknown as InteractiveModeContext);
		panel.handleSettingChange(cfgTodoBackend.id, "tracker");
		await settled(session);
		session.extensionRunner?.setSuspendedExtensions(() => false);
		await settled(session);
		const beforeNextChange = tasksOf(backend);
		session.commitTodoPhases(list("a", "b"));
		await settled(session);

		expect(errors).toEqual([]);
		expect(beforeNextChange).toEqual([]);
		expect(tasksOf(backend)).toEqual([["a", "b"]]);
	});

	it("two extensions that register one shared backend object are still two holders: on takeover the next one gets the list", async () => {
		const taken: TodoPhase[][] = [];
		const shared: TodoBackendDefinition = { id: "tracker", replace: phases => void taken.push(phases) };
		const register: ExtensionFactory = pi => pi.registerTodoBackend(shared);
		const { session } = await open([register, register], "tracker");

		session.commitTodoPhases(list("a"));
		await settled(session);
		const holder = session.extensionRunner?.getTodoBackends().get("tracker")?.extension;
		session.extensionRunner?.setSuspendedExtensions(extension => extension === holder);
		session.commitTodoPhases(list("a"));
		await settled(session);

		expect(taken).toEqual([list("a"), list("a")]);
	});

	it("a backend its extension registers again while the session runs gets the list at the next commit, changed or not", async () => {
		const called: string[] = [];
		let again = () => {};
		const { session } = await open(
			[
				pi => {
					pi.registerTodoBackend({ id: "tracker", replace: () => void called.push("first") });
					again = () => pi.registerTodoBackend({ id: "tracker", replace: () => void called.push("second") });
				},
			],
			"tracker",
		);

		session.commitTodoPhases(list("a"));
		await settled(session);
		again();
		session.commitTodoPhases(list("a"));
		await settled(session);

		expect(called).toEqual(["first", "second"]);
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
});
