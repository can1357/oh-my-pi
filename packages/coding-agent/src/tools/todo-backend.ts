import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { logger } from "@oh-my-pi/pi-utils";
import type { TodoOperation, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ExtensionContext } from "../extensibility/extensions/types";
import { errorMessage } from "../slash-commands/helpers/parse";
import type { TodoParams } from "./todo";

/** Id of omp's built-in todo list. Reserved: extensions cannot register it. */
export const NATIVE_TODO_BACKEND_ID = "native";

/**
 * `source` of session notices about todo backends: fallbacks to native todos and Cursor-mirrored
 * lists a backend refused. The interactive HUD reloads the committed list when it sees one.
 */
export const TODO_BACKEND_NOTICE_SOURCE = "todo-backend";

/**
 * Text an extension or the user supplied (a backend id or label, a thrown error) as one
 * display-safe line. It reaches notices, `/todo` errors and tool results, which render it as is.
 */
export function sanitizeTodoBackendText(value: unknown): string {
	return sanitizeDisplayLine(errorMessage(value));
}

/**
 * The `todo` tool's params, as validated by the tool: the same value the native op applied, with
 * keys the tool schema does not declare removed. Public extension-facing name for `TodoParams`.
 */
export type TodoBackendParams = TodoParams;

/**
 * Operation name of a `todo` tool call.
 * Public extension-facing name for the tool's `TodoOperation`.
 */
export type TodoOp = TodoOperation;

/**
 * An external store that mirrors the session todo list.
 *
 * The session transcript stays the source of truth: omp applies each op natively and records the
 * resulting phases, and the backend mirrors them. Calls run one at a time per session.
 *
 * `apply` and `replace` get the extension handler budget (30 s). When it runs out, or the user
 * aborts the `todo` call, omp aborts `signal`, fails the call with the list unchanged and stops
 * waiting: the next call can then start while one that ignores `signal` is still running. After a
 * call that failed, timed out or whose write did not commit, omp calls `replace` with the
 * committed list before the next `apply`. A `create` that runs out of the same budget falls back
 * to native todos.
 */
export interface TodoBackend {
	/**
	 * Called after omp applied `op` natively and before it commits `next`. A throw fails the call
	 * and leaves the list unchanged.
	 */
	apply(op: TodoOp, params: TodoBackendParams, next: TodoPhase[], signal: AbortSignal): Promise<void>;
	/**
	 * Called for edits made outside the `todo` tool, where a throw refuses the edit and leaves the list
	 * unchanged; after the list was reset or reloaded (`/new`, a session switch, rewind, tree
	 * navigation, a fork from a message), where the list is already in place and a throw only warns;
	 * and before an `apply` that follows a lost call (see above).
	 */
	replace(phases: TodoPhase[], signal: AbortSignal): Promise<void>;
}

/** Registration payload for `pi.registerTodoBackend()`. */
export interface TodoBackendDefinition {
	/**
	 * Value users put in the `todo.backend` setting. Must not be `native`; an id already registered by
	 * another extension is skipped with a warning.
	 */
	id: string;
	/** Human-readable name. */
	label: string;
	description?: string;
	/**
	 * Builds the backend for the main session. A throw makes omp fall back to native todos. Can run
	 * several times per session (each switch to this backend, and after its extension is disabled
	 * and re-enabled); omp drops the previous instance without notice.
	 */
	create(ctx: ExtensionContext): TodoBackend | Promise<TodoBackend>;
}

/**
 * A resolved backend for the main session. Each call runs within the extension handler budget and
 * the session's settings scope, and rejects as soon as `signal` aborts. `undefined` in its place
 * means native todos.
 */
export interface ActiveTodoBackend {
	readonly label: string;
	apply(op: TodoOp, params: TodoBackendParams, next: TodoPhase[], signal?: AbortSignal): Promise<void>;
	replace(phases: TodoPhase[], signal?: AbortSignal): Promise<void>;
}

/** What a commit sets the list to: a list, or an updater run on the committed list (`undefined` declines). */
export type TodoPhasesUpdate = TodoPhase[] | ((current: TodoPhase[]) => TodoPhase[] | undefined);

/** The list `update` sets when the committed list is `current`; `undefined` when it declines. */
export function resolveTodoUpdate(update: TodoPhasesUpdate, current: TodoPhase[]): TodoPhase[] | undefined {
	return typeof update === "function" ? update(current) : update;
}

export interface TodoCommitOptions {
	/** Record the entry only: the bridged `todo` call already updated the list and reached `apply` (eval bridge). */
	mirrored?: boolean;
}

/**
 * Handed to a queued todo write. Call {@link assertCurrent} after any backend call and before
 * committing: it throws when the write's abort signal fired or the session's todo list was reset
 * or reloaded (`/new`, switch, rewind, tree navigation, fork) since the write was enqueued.
 */
export interface TodoWriteGuard {
	assertCurrent(): void;
}

/** A queued todo write: gets the backend resolved when it starts (`undefined` = native todos) and its guard. */
export type TodoWrite<T> = (active: ActiveTodoBackend | undefined, guard: TodoWriteGuard) => Promise<T>;

/** One registration: the backend and the resolved path of the extension that registered it. */
export interface TodoBackendRegistration {
	readonly definition: TodoBackendDefinition;
	readonly sourceId: string;
}

/** Todo backends registered by extensions, in registration order. */
export class TodoBackendRegistry {
	readonly #byId = new Map<string, TodoBackendRegistration>();

	/**
	 * Add a backend. A malformed definition or the reserved `native` id throws; an id already taken
	 * is skipped with a warning, so the second extension keeps its other registrations (as with
	 * conflicting commands and shortcuts).
	 */
	register(definition: TodoBackendDefinition, sourceId: string): void {
		const id: unknown = definition.id;
		if (typeof id !== "string" || id.trim() === "") {
			throw new Error(`Todo backend from ${sourceId} needs a non-empty string id`);
		}
		if (id === NATIVE_TODO_BACKEND_ID) {
			throw new Error(`Todo backend id "${id}" from ${sourceId} is reserved for the built-in todo list`);
		}
		if (typeof definition.label !== "string" || definition.label.trim() === "") {
			throw new Error(`Todo backend "${id}" from ${sourceId} needs a non-empty label`);
		}
		if (typeof definition.create !== "function") {
			throw new Error(`Todo backend "${id}" from ${sourceId} needs a create(ctx) function`);
		}
		const existing = this.#byId.get(id);
		if (existing) {
			logger.warn("Todo backend id already registered; skipping", {
				id,
				extensionPath: sourceId,
				existingExtensionPath: existing.sourceId,
			});
			return;
		}
		this.#byId.set(id, { definition, sourceId });
	}

	/** Every registration, in registration order. */
	list(): readonly TodoBackendRegistration[] {
		return Array.from(this.#byId.values());
	}

	/** Number of registrations; pass it to {@link rollback} to undo the ones made after it. */
	get size(): number {
		return this.#byId.size;
	}

	/** Drop every registration after the first `size`, e.g. those of an extension whose factory threw. */
	rollback(size: number): void {
		let index = 0;
		for (const id of this.#byId.keys()) {
			if (index++ >= size) this.#byId.delete(id);
		}
	}
}
