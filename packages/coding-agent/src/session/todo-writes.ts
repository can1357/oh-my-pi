import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { logger, Serial, untilAborted } from "@oh-my-pi/pi-utils";
import type { SettingsScope } from "../config/registry";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { cfgTodoBackend } from "../tools/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import {
	type ActiveTodoBackend,
	NATIVE_TODO_BACKEND_ID,
	TODO_BACKEND_NOTICE_SOURCE,
	type TodoCommitOptions,
	type TodoPhasesUpdate,
	type TodoWriteGuard,
	todoBackendText,
} from "../tools/todo-backend";
import type { SessionManager } from "./session-manager";
import type { TodoTracker } from "./todo-tracker";

const SESSION_CHANGED_MESSAGE = "The session changed before the todo edit was saved; nothing was changed.";

/** What {@link TodoWrites} needs from its session. The session is the scope `todo.backend` is watched in. */
export interface TodoWritesHost extends SettingsScope {
	readonly sessionManager: SessionManager;
	/** Holds the committed list. */
	readonly todo: TodoTracker;
	/** Read live: the runner is attached after the session is built. */
	extensionRunner(): ExtensionRunner | undefined;
	/** Only the main session uses a backend. */
	isMainAgent(): boolean;
	isDisposed(): boolean;
	emitNotice(level: "warning", message: string, source: string): void;
	/**
	 * Bind startup-deferred extensions if any are pending. Resolves `false` when called from inside
	 * that load, where waiting on the backend would wait on the load itself.
	 */
	bindDeferredExtensions(): Promise<boolean>;
}

/**
 * Every write to a session's todo list, and the todo backend those writes reach.
 *
 * Writes run one at a time. Each receives the backend resolved when it starts (`undefined` = native
 * todos) and a guard that fails once the list was reset or reloaded. The backend resolves lazily
 * from `todo.backend` once {@link arm}ed, and again whenever the setting changes.
 */
export class TodoWrites {
	readonly #host: TodoWritesHost;
	readonly #queue = new Serial();
	/** Backend mirroring the list; `undefined` = native todos. */
	#active: ActiveTodoBackend | undefined;
	/** Latest `todo.backend` value a resolution was queued for. */
	#requestedId: string | undefined;
	/** Set by {@link arm}; resolution stays dormant until then. */
	#armed = false;
	/** The queued first resolution; every write awaits it. Set once, by {@link resolveBackend}. */
	#initial: Promise<void> | undefined;
	/** Bumped whenever the list is reset or reloaded; queued writes from an older epoch must not land. */
	#epoch = 0;

	constructor(host: TodoWritesHost) {
		this.#host = host;
	}

	/**
	 * Enable backend resolution and watch `todo.backend`. Call once, after the deferred extension
	 * loader is set. Resolution itself is lazy: it runs at the first prompt admission, after the
	 * deferred-extension load, or at the first write, whichever comes first. All of them happen after
	 * the mode subscribed its event listeners, so the fallback notice reaches the client. Sessions
	 * without an extension runner never use a backend.
	 */
	arm(): void {
		if (this.#armed || !this.#host.extensionRunner()) return;
		this.#armed = true;
		cfgTodoBackend.listen(this.#host, () => this.#observeSetting());
	}

	/** Queue the first backend resolution, once armed. Later calls do nothing. */
	resolveBackend(): void {
		if (!this.#armed || this.#initial) return;
		const id = cfgTodoBackend.get(this.#host.settings);
		this.#requestedId = id;
		this.#initial = this.#queue
			.run(() => this.#resolve(id))
			.catch((error: unknown) => {
				logger.warn("Todo backend resolution failed", { id, error: String(error) });
			});
	}

	/**
	 * Queue a write. It starts after every earlier write and backend switch settled (a rejected one
	 * does not block the next), waits for the first backend resolution, and receives the backend
	 * resolved at that moment plus a guard whose `assertCurrent()` must run before committing.
	 *
	 * A write whose list was reset or reloaded (`/new`, switch, rewind, tree navigation, fork) since
	 * this call rejects without starting. `options.signal` races the caller against the queue: the
	 * returned promise rejects at once on abort, a not-yet-started write is skipped, and a started one
	 * keeps the queue slot until it settles but fails `assertCurrent()` so it never commits.
	 */
	run<T>(
		write: (active: ActiveTodoBackend | undefined, guard: TodoWriteGuard) => Promise<T>,
		options?: { signal?: AbortSignal },
	): Promise<T> {
		const signal = options?.signal;
		const epoch = this.#epoch;
		const assertCurrent = (): void => {
			signal?.throwIfAborted();
			if (this.#epoch !== epoch) throw new Error(SESSION_CHANGED_MESSAGE);
		};
		const queued = (async () => {
			await this.#ready();
			this.#observeSetting();
			return this.#queue.run(() => {
				assertCurrent();
				return write(this.#active, { assertCurrent });
			});
		})();
		return untilAborted(signal, queued);
	}

	/**
	 * Replace the list from outside the `todo` tool, as a queued write. A function `update` receives
	 * the committed list at that moment (returning `undefined` declines: nothing is sent or
	 * committed); the backend's `replace` then receives a copy of the full list, the list updates and
	 * a `user_todo_edit` entry is recorded so reloads keep it. A throwing `replace` rejects (naming
	 * the backend) and commits nothing; so does a reset while queued. `mirrored` (eval bridge) only
	 * records the entry: the bridged `todo` call already updated the list and reached `apply`.
	 * Resolves with the committed list.
	 */
	commit(update: TodoPhasesUpdate, options?: TodoCommitOptions): Promise<TodoPhase[] | undefined> {
		const todo = this.#host.todo;
		return this.run(async (active, guard) => {
			const phases = typeof update === "function" ? update(todo.phases) : update;
			if (phases === undefined) return undefined;
			if (active && !options?.mirrored) {
				try {
					await active.replace(todo.clonePhases(phases));
				} catch (error) {
					throw new Error(`Todo backend "${active.label}" refused the edit: ${todoBackendText(error)}`, {
						cause: error,
					});
				}
			}
			guard.assertCurrent();
			if (!options?.mirrored) todo.setPhases(phases);
			this.#host.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			return phases;
		});
	}

	/**
	 * Make every queued write fail its guard. Call synchronously before a session file swap, so a
	 * write settling mid-swap cannot land in the new file.
	 */
	invalidate(): void {
		this.#epoch++;
	}

	/** Reload the list for a different list identity (reset, switch, rewind, navigation, fork), invalidating queued writes. */
	reload(): void {
		this.invalidate();
		this.#host.todo.syncFromBranch();
	}

	async #ready(): Promise<void> {
		if (!this.#armed) return;
		if (!(await this.#host.bindDeferredExtensions())) return;
		this.resolveBackend();
		await this.#initial;
	}

	/** Queue a re-resolution when `todo.backend` no longer matches the id last resolved. */
	#observeSetting(): void {
		// Before the first resolution runs, it reads the setting itself.
		if (!this.#initial || this.#host.isDisposed()) return;
		const id = cfgTodoBackend.get(this.#host.settings);
		if (id === this.#requestedId) return;
		this.#requestedId = id;
		this.#queue
			.run(() => this.#resolve(id))
			.catch((error: unknown) => {
				logger.warn("Todo backend switch failed", { id, error: String(error) });
			});
	}

	/**
	 * Resolve `todo.backend` into the active backend. Never throws: an unregistered id or a failing
	 * `create` leaves native todos in place and emits one notice. Does not touch the list.
	 */
	async #resolve(id: string): Promise<void> {
		this.#active = undefined;
		const runner = this.#host.extensionRunner();
		if (!runner || !this.#host.isMainAgent() || this.#host.isDisposed()) return;
		if (id.trim() === "" || id === NATIVE_TODO_BACKEND_ID) return;
		const context = runner.createContext();
		const definition = runner.todoBackends.get(id);
		if (!definition) {
			this.#host.emitNotice(
				"warning",
				`Todo backend "${todoBackendText(id)}" is not registered by any loaded extension; using native todos.`,
				TODO_BACKEND_NOTICE_SOURCE,
			);
			return;
		}
		try {
			const backend = await runner.runTodoBackendCall(() => definition.create(context));
			if (!backend || typeof backend.apply !== "function" || typeof backend.replace !== "function") {
				throw new Error("create() did not return an object with apply() and replace()");
			}
			this.#active = {
				id,
				label: todoBackendText(definition.label),
				apply: (op, params, next, signal) =>
					runner.runTodoBackendCall(backendSignal => backend.apply(op, params, next, backendSignal), signal),
				replace: (phases, signal) =>
					runner.runTodoBackendCall(backendSignal => backend.replace(phases, backendSignal), signal),
			};
		} catch (error) {
			const message = todoBackendText(error);
			logger.warn("Todo backend create failed", { id, error: message });
			this.#host.emitNotice(
				"warning",
				`Todo backend "${todoBackendText(id)}" failed to start: ${message}; using native todos.`,
				TODO_BACKEND_NOTICE_SOURCE,
			);
		}
	}
}
