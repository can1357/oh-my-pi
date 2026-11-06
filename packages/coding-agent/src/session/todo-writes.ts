import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { logger, Serial, untilAborted } from "@oh-my-pi/pi-utils";
import type { SettingsScope } from "../config/registry";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { cfgTodoBackend } from "../tools/settings";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import {
	type ActiveTodoBackend,
	NATIVE_TODO_BACKEND_ID,
	TODO_BACKEND_NOTICE_SOURCE,
	type TodoCommitOptions,
	type TodoPhasesUpdate,
	type TodoWrite,
	todoBackendText,
} from "../tools/todo-backend";
import type { SessionManager } from "./session-manager";
import type { TodoTracker } from "./todo-tracker";

const SESSION_CHANGED_MESSAGE = "The session changed before the todo edit was saved; nothing was changed.";

/** Thrown by a write's guard when the todo list was reset or reloaded after the write was enqueued. */
export class TodoListChangedError extends Error {
	constructor() {
		super(SESSION_CHANGED_MESSAGE);
		this.name = "TodoListChangedError";
	}
}

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

/** Whether `id` names an extension backend rather than native todos. */
function isBackendId(id: string): boolean {
	return id.trim() !== "" && id !== NATIVE_TODO_BACKEND_ID;
}

/**
 * Every write to a session's todo list, and the todo backend those writes reach.
 *
 * With native todos a write runs inline, as a plain list update. Once a non-native backend is
 * selected in the main session, writes run one at a time: each receives the backend resolved when
 * it starts (`undefined` = native todos) and a guard that fails once the list was reset or
 * reloaded. The backend resolves from `todo.backend` once {@link arm}ed and {@link resolveBackend}
 * allowed it, and again whenever the setting changes or the backend's extension is suspended or
 * resumed.
 */
export class TodoWrites {
	readonly #host: TodoWritesHost;
	readonly #queue = new Serial();
	/** Backend mirroring the list; `undefined` = native todos. */
	#active: ActiveTodoBackend | undefined;
	/** Latest `todo.backend` value observed. */
	#requestedId: string | undefined;
	/** Whether an enabled extension registered {@link #requestedId} when it was observed. */
	#requestedAvailable = false;
	/** Set by {@link arm}; resolution stays dormant until then. */
	#armed = false;
	/** Set by {@link resolveBackend}: startup-deferred extensions are bound, so ids can be resolved. */
	#resolvable = false;
	/** Queued writes and resolutions not yet settled. Native writes run inline only at zero. */
	#pending = 0;
	/** Bumped whenever the list is reset or reloaded; queued writes from an older epoch must not land. */
	#epoch = 0;

	constructor(host: TodoWritesHost) {
		this.#host = host;
	}

	/**
	 * Watch `todo.backend`. Call once, after the deferred extension loader is set. Sessions without an
	 * extension runner never use a backend.
	 */
	arm(): void {
		const runner = this.#host.extensionRunner();
		if (this.#armed || !runner) return;
		this.#armed = true;
		cfgTodoBackend.listen(this.#host, () => this.#observeSetting());
		runner.onSuspensionChange(() => this.#observeSetting());
	}

	/**
	 * Allow backend resolution once startup-deferred extensions are bound: at the first prompt
	 * admission, after the deferred load, or at the first queued write. These all run after the mode
	 * subscribed its event listeners, so a fallback notice reaches the client. Resolves `todo.backend`
	 * now unless it is native.
	 */
	resolveBackend(): void {
		if (!this.#armed || this.#resolvable) return;
		this.#resolvable = true;
		this.#observeSetting();
	}

	/**
	 * Whether writes go through the queue: a non-native backend is selected in the main session or
	 * still active, or queued work has not settled. Otherwise they run inline.
	 */
	get queued(): boolean {
		if (this.#pending > 0 || this.#active) return true;
		return this.#armed && this.#host.isMainAgent() && isBackendId(cfgTodoBackend.get(this.#host.settings));
	}

	/**
	 * Run a write. While {@link queued} is false it runs now, with no backend.
	 *
	 * Otherwise it is queued: it starts after every earlier write and backend switch settled (a
	 * rejected one does not block the next) and after startup-deferred extensions bound, and receives
	 * the backend resolved at that moment plus a guard whose `assertCurrent()` must run before
	 * committing. A write whose list was reset or reloaded (`/new`, switch, rewind, tree navigation,
	 * fork) since this call rejects without starting. `options.signal` races the caller against the
	 * queue: the returned promise rejects at once on abort, a not-yet-started write is skipped, and a
	 * started one keeps the queue slot until it settles but fails `assertCurrent()` so it never commits.
	 */
	run<T>(write: TodoWrite<T>, options?: { signal?: AbortSignal }): Promise<T> {
		const signal = options?.signal;
		const epoch = this.#epoch;
		const assertCurrent = (): void => {
			signal?.throwIfAborted();
			if (this.#epoch !== epoch) throw new TodoListChangedError();
		};
		if (!this.queued) {
			return (async () => {
				assertCurrent();
				return write(undefined, { assertCurrent });
			})();
		}
		const queued = this.#track(
			(async () => {
				await this.#ready();
				this.#observeSetting();
				return this.#queue.run(() => {
					assertCurrent();
					return write(this.#active, { assertCurrent });
				});
			})(),
		);
		return untilAborted(signal, queued);
	}

	/**
	 * Replace the list from outside the `todo` tool, as a write. A function `update` receives the
	 * committed list at that moment (returning `undefined` declines: nothing is sent or committed);
	 * the backend's `replace` then receives a copy of the full list, the list updates and a
	 * `user_todo_edit` entry is recorded so reloads keep it. A throwing `replace` rejects (naming the
	 * backend) and commits nothing; so does a reset while queued. `mirrored` (eval bridge) only
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
	 * Call after saving a `todo` tool result. A queued tool write left the queue before the agent loop
	 * saved its result, so a commit that ran in between (a `/todo` edit) saved its entry first, and a
	 * rebuild from the branch would restore the tool's older list. Record the live list again then.
	 */
	keepLiveListAfterToolResult(): void {
		if (!this.queued) return;
		const live = this.#host.todo.phases;
		if (Bun.deepEquals(getLatestTodoPhasesFromEntries(this.#host.sessionManager.getBranchView()), live)) return;
		this.#host.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: live });
	}

	/**
	 * Make every queued write fail its guard. Call synchronously before switching to a different list
	 * (new session, session switch, branch), so a write settling mid-swap cannot land in it. A
	 * whole-session fork keeps the same list, so queued writes stay valid there.
	 */
	invalidate(): void {
		this.#epoch++;
	}

	/** Empty the list for a new session, invalidating queued writes; a backend receives the empty list. */
	clear(): void {
		this.invalidate();
		this.#host.todo.setPhases([]);
		this.#replaceAfterReset();
	}

	/**
	 * Reload the list for a different list identity (switch, rewind, navigation, fork from a message),
	 * invalidating queued writes; a backend receives the reloaded list.
	 */
	reload(): void {
		this.invalidate();
		this.#host.todo.syncFromBranch();
		this.#replaceAfterReset();
	}

	/**
	 * Queue a `replace` with the list as of its queue slot, so the backend follows a reset or reload.
	 * The list cannot be refused at that point, so a failure only warns.
	 */
	#replaceAfterReset(): void {
		if (!this.queued) return;
		const todo = this.#host.todo;
		this.run(async active => {
			if (!active) return;
			try {
				await active.replace(todo.clonePhases(todo.phases));
			} catch (error) {
				this.#host.emitNotice(
					"warning",
					`Todo backend "${active.label}" did not take the todo list after the session changed: ${todoBackendText(error)}`,
					TODO_BACKEND_NOTICE_SOURCE,
				);
			}
		}).catch((error: unknown) => {
			// A later reset invalidated this one and queued its own replace.
			if (!(error instanceof TodoListChangedError))
				logger.warn("Todo backend sync after a reset failed", { error: String(error) });
		});
	}

	async #ready(): Promise<void> {
		if (!this.#armed) return;
		if (!(await this.#host.bindDeferredExtensions())) return;
		this.resolveBackend();
	}

	/** Count `work` in {@link #pending} until it settles. */
	#track<T>(work: Promise<T>): Promise<T> {
		this.#pending++;
		const settle = (): void => {
			this.#pending--;
		};
		work.then(settle, settle);
		return work;
	}

	/**
	 * Queue a resolution when `todo.backend` no longer matches the id last observed, or its backend
	 * appeared or disappeared since (its extension was suspended or resumed). Going from native to
	 * native resolves nothing.
	 */
	#observeSetting(): void {
		if (!this.#resolvable || !this.#host.isMainAgent() || this.#host.isDisposed()) return;
		const id = cfgTodoBackend.get(this.#host.settings);
		const available = this.#isAvailable(id);
		if (id === this.#requestedId && available === this.#requestedAvailable) return;
		const wasBackend = this.#requestedId !== undefined && isBackendId(this.#requestedId);
		this.#requestedId = id;
		this.#requestedAvailable = available;
		if (!isBackendId(id) && !wasBackend && !this.#active) return;
		this.#track(this.#queue.run(() => this.#resolve(id))).catch((error: unknown) => {
			logger.warn("Todo backend resolution failed", { id, error: String(error) });
		});
	}

	#isAvailable(id: string): boolean {
		return this.#host.extensionRunner()?.getTodoBackend(id) !== undefined;
	}

	/**
	 * Resolve `todo.backend` into the active backend. Never throws: an unregistered id or a failing
	 * `create` leaves native todos in place and emits one notice. Does not touch the list.
	 */
	async #resolve(id: string): Promise<void> {
		this.#active = undefined;
		const runner = this.#host.extensionRunner();
		if (!runner || this.#host.isDisposed() || !isBackendId(id)) return;
		const definition = runner.getTodoBackend(id);
		if (!definition) {
			this.#host.emitNotice(
				"warning",
				`Todo backend "${todoBackendText(id)}" is not registered by any enabled extension; using native todos.`,
				TODO_BACKEND_NOTICE_SOURCE,
			);
			return;
		}
		try {
			const backend = await runner.createTodoBackend(definition);
			if (!backend || typeof backend.apply !== "function" || typeof backend.replace !== "function") {
				throw new Error("create() did not return an object with apply() and replace()");
			}
			this.#active = {
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

/**
 * Plan an edit inside a queued commit, so `plan` sees the list as committed at that moment and a
 * `todo` tool write queued earlier is never overwritten. Resolves with the plan and the committed
 * list, or `{ error }` for the plan's own error, a rejected commit, or a commit that did not apply.
 */
export async function commitTodoEdit<T extends { phases: TodoPhase[] }>(
	session: { commitTodoPhases(update: TodoPhasesUpdate): Promise<TodoPhase[] | undefined> },
	plan: (current: TodoPhase[]) => T | { error: string },
): Promise<{ plan: T; committed: TodoPhase[] } | { error: string }> {
	const planned: { result?: T | { error: string } } = {};
	let committed: TodoPhase[] | undefined;
	try {
		committed = await session.commitTodoPhases(current => {
			const result = plan(current);
			planned.result = result;
			return "phases" in result ? result.phases : undefined;
		});
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	const result = planned.result;
	if (result && "error" in result) return { error: result.error };
	if (!result || !committed) return { error: "The todo edit was not applied." };
	return { plan: result, committed };
}
