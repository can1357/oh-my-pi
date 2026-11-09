import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { logger, Serial, untilAborted } from "@oh-my-pi/pi-utils";
import type { SettingsScope } from "../config/registry";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { cfgTodoBackend } from "../tools/settings";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import {
	type ActiveTodoBackend,
	NATIVE_TODO_BACKEND_ID,
	sanitizeTodoBackendText,
	type TodoPhasesUpdate,
	type TodoWrite,
} from "../tools/todo-backend";
import type { SessionManager } from "./session-manager";
import type { TodoTracker } from "./todo-tracker";

const SESSION_CHANGED_MESSAGE = "The session changed before the todo edit was saved; nothing was changed.";

class TodoListChangedError extends Error {
	constructor() {
		super(SESSION_CHANGED_MESSAGE);
		this.name = "TodoListChangedError";
	}
}

export interface TodoWritesHost extends SettingsScope {
	readonly sessionManager: SessionManager;
	readonly todo: TodoTracker;
	/** Read live: the runner is attached after the session is built. */
	extensionRunner(): ExtensionRunner | undefined;
	isMainAgent(): boolean;
	isDisposed(): boolean;
	warn(message: string): void;
	/**
	 * Bind startup-deferred extensions if any are pending. Resolves `false` when called from inside
	 * that load, where waiting on the backend would wait on the load itself.
	 */
	bindDeferredExtensions(): Promise<boolean>;
}

function isBackendId(id: string): boolean {
	return id.trim() !== "" && id !== NATIVE_TODO_BACKEND_ID;
}

export class TodoWrites {
	readonly #host: TodoWritesHost;
	readonly #queue = new Serial();
	#active: ActiveTodoBackend | undefined;
	#requestedId: string | undefined;
	#requestedAvailable = false;
	#armed = false;
	#resolvable = false;
	#pending = 0;
	#queuedWriteSinceSave = false;
	#epoch = 0;

	constructor(host: TodoWritesHost) {
		this.#host = host;
	}

	arm(): void {
		const runner = this.#host.extensionRunner();
		if (this.#armed || !runner) return;
		this.#armed = true;
		cfgTodoBackend.listen(this.#host, () => this.#observeSetting());
		this.#host.addDisposer?.(runner.onSuspensionChange(() => this.#observeSetting()));
	}

	/**
	 * Call at the first prompt admission, after the deferred load, or at the first queued write: these
	 * all run after the mode subscribed its event listeners, so a fallback notice reaches the client.
	 */
	allowBackendResolution(): void {
		if (!this.#armed || this.#resolvable) return;
		this.#resolvable = true;
		this.#observeSetting();
	}

	get queued(): boolean {
		if (this.#pending > 0 || this.#active) return true;
		if (!this.#armed || !this.#host.isMainAgent()) return false;
		const id = cfgTodoBackend.get(this.#host.settings);
		return isBackendId(id) && id !== this.#requestedId;
	}

	run<T>(write: TodoWrite<T>, signal?: AbortSignal): Promise<T> {
		const epoch = this.#epoch;
		const assertCurrent = (): void => {
			signal?.throwIfAborted();
			if (this.#epoch !== epoch) throw new TodoListChangedError();
		};
		if (!this.queued) {
			return (async () => {
				assertCurrent();
				return write(undefined, assertCurrent);
			})();
		}
		const queued = this.#track(
			(async () => {
				if (await this.#host.bindDeferredExtensions()) this.allowBackendResolution();
				this.#observeSetting();
				return this.#queue.run(() => {
					assertCurrent();
					this.#queuedWriteSinceSave = true;
					return write(this.#active, assertCurrent);
				});
			})(),
		);
		return untilAborted(signal, queued);
	}

	edit(update: TodoPhasesUpdate): Promise<TodoPhase[] | undefined> {
		const todo = this.#host.todo;
		return this.run(async (active, assertCurrent) => {
			const phases = update(todo.phases);
			if (phases === undefined) return undefined;
			if (active) {
				try {
					await active.replace(todo.clonePhases(phases));
				} catch (error) {
					throw new Error(`Todo backend "${active.label}" refused the edit: ${sanitizeTodoBackendText(error)}`, {
						cause: error,
					});
				}
			}
			assertCurrent();
			return this.#save(phases);
		});
	}

	commit(update: TodoPhasesUpdate): Promise<TodoPhase[] | undefined> {
		return this.run(async active => {
			const phases = update(this.#host.todo.phases);
			if (phases === undefined) return undefined;
			const committed = this.#save(phases);
			await this.#sync(active);
			return committed;
		}).catch((error: unknown) => {
			if (error instanceof TodoListChangedError) return undefined;
			throw error;
		});
	}

	/** `setPhases` keeps only a todo list's fields, so return the stored copy. */
	#save(phases: TodoPhase[]): TodoPhase[] {
		this.#host.todo.setPhases(phases);
		this.#host.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		return this.#host.todo.phases;
	}

	async #sync(active: ActiveTodoBackend | undefined): Promise<void> {
		if (!active) return;
		try {
			await active.sync();
		} catch (error) {
			this.#host.warn(
				`Todo backend "${active.label}" did not take the todo list: ${sanitizeTodoBackendText(error)}`,
			);
		}
	}

	/**
	 * A queued tool write left the queue before the agent loop saved its result, so a commit that ran
	 * in between (a `/todo` edit) saved its entry first, and a rebuild from the branch would restore the
	 * tool's older list.
	 */
	keepLiveListAfterToolResult(): void {
		if (!this.#queuedWriteSinceSave) return;
		this.#queuedWriteSinceSave = false;
		const live = this.#host.todo.phases;
		if (Bun.deepEquals(getLatestTodoPhasesFromEntries(this.#host.sessionManager.getBranchView()), live)) return;
		this.#host.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: live });
	}

	/** A whole-session fork keeps the same list, so queued writes stay valid there. */
	invalidate(): void {
		this.#epoch++;
	}

	clear(): void {
		this.invalidate();
		this.#host.todo.setPhases([]);
		this.#syncAfterReset();
	}

	reload(): void {
		this.invalidate();
		this.#host.todo.syncFromBranch();
		this.#syncAfterReset();
	}

	/**
	 * Before the first resolution there is no backend to follow the list, and a host may still be
	 * setting up its extensions (ACP loads a session before initializing them), so nothing is queued then.
	 */
	#syncAfterReset(): void {
		if (!this.#resolvable || !this.queued) return;
		this.run(active => this.#sync(active)).catch((error: unknown) => {
			// A later reset invalidated this one and queued its own sync.
			if (!(error instanceof TodoListChangedError))
				logger.warn("Todo backend sync after a reset failed", { error: String(error) });
		});
	}

	#track<T>(work: Promise<T>): Promise<T> {
		this.#pending++;
		const settle = (): void => {
			this.#pending--;
		};
		work.then(settle, settle);
		return work;
	}

	#observeSetting(): void {
		if (!this.#resolvable || !this.#host.isMainAgent() || this.#host.isDisposed()) return;
		const id = cfgTodoBackend.get(this.#host.settings);
		const available = this.#host.extensionRunner()?.getTodoBackend(id) !== undefined;
		if (id === this.#requestedId && available === this.#requestedAvailable) return;
		const wasBackend = this.#requestedId !== undefined && isBackendId(this.#requestedId);
		this.#requestedId = id;
		this.#requestedAvailable = available;
		if (!isBackendId(id) && !wasBackend && !this.#active) return;
		this.#track(this.#queue.run(() => this.#resolve(id))).catch((error: unknown) => {
			logger.warn("Todo backend resolution failed", { id, error: String(error) });
		});
	}

	async #resolve(id: string): Promise<void> {
		this.#active = undefined;
		const runner = this.#host.extensionRunner();
		if (!runner || this.#host.isDisposed() || !isBackendId(id)) return;
		const definition = runner.getTodoBackend(id);
		if (!definition) {
			this.#host.warn(
				`Todo backend "${sanitizeTodoBackendText(id)}" is not registered by any enabled extension; using native todos.`,
			);
			return;
		}
		try {
			const backend = await runner.createTodoBackend(definition);
			if (!backend || typeof backend.apply !== "function" || typeof backend.replace !== "function") {
				throw new Error("create() did not return an object with apply() and replace()");
			}
			const todo = this.#host.todo;
			// The list the backend last confirmed, or `undefined` while a call is pending or after one
			// failed, timed out or was abandoned. `sync` sends the committed list when it differs (that
			// call was lost, or its write did not commit).
			let sent: TodoPhase[] | undefined = todo.phases;
			const call = async (
				phases: TodoPhase[],
				work: (backendSignal: AbortSignal) => Promise<void>,
				signal: AbortSignal | undefined,
			) => {
				const snapshot = todo.clonePhases(phases);
				sent = undefined;
				await runner.runTodoBackendCall(work, signal);
				sent = snapshot;
			};
			const replace = (phases: TodoPhase[], signal?: AbortSignal) =>
				call(phases, backendSignal => backend.replace(phases, backendSignal), signal);
			const sync = async (signal?: AbortSignal) => {
				const committed = todo.phases;
				if (sent && Bun.deepEquals(sent, committed)) return;
				await replace(committed, signal);
			};
			this.#active = {
				label: sanitizeTodoBackendText(definition.label),
				apply: async (op, params, next, signal) => {
					try {
						await sync(signal);
					} catch (error) {
						throw new Error(`it did not take the committed list sent first (${sanitizeTodoBackendText(error)})`, {
							cause: error,
						});
					}
					await call(next, backendSignal => backend.apply(op, params, next, backendSignal), signal);
				},
				replace,
				sync,
			};
		} catch (error) {
			const message = sanitizeTodoBackendText(error);
			logger.warn("Todo backend create failed", { id, error: message });
			this.#host.warn(
				`Todo backend "${sanitizeTodoBackendText(id)}" failed to start: ${message}; using native todos.`,
			);
		}
	}
}
