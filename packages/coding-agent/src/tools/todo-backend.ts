import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { logger } from "@oh-my-pi/pi-utils";
import type { TodoOperation, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ExtensionContext } from "../extensibility/extensions/types";
import { errorMessage } from "../slash-commands/helpers/parse";
import type { TodoParams } from "./todo";

export const NATIVE_TODO_BACKEND_ID = "native";

/** `notice` source of todo backend warnings: a fallback to native todos, or a sync that failed. */
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
 * keys the tool schema does not declare removed.
 */
export type TodoBackendParams = TodoParams;

/** Operation name of a `todo` tool call. */
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
	 * Called for edits the user or an RPC client makes outside the `todo` tool, where a throw refuses
	 * the edit and leaves the list unchanged. Also called, only when this backend does not have the
	 * committed list yet, after a change already in place (a Cursor mirror, a subagent auto-complete,
	 * a reset or reload: `/new`, a session switch, rewind, tree navigation, a fork from a message),
	 * where a throw only warns, and before an `apply` that follows a lost call (see above).
	 *
	 * A reset goes to the same instance (`/new` sends `replace([])` unless the backend already has an
	 * empty list; `create` does not run again) and carries no reason. While it runs,
	 * `ctx.sessionManager.getSessionId()` already returns the new session's id, and it can arrive
	 * before the extension's `session_switch` handler. A mirror takes the list as is; a backend whose
	 * store outlives a session keys it by session id, or `/new` empties it. When only the session id
	 * changes (a whole-session fork, a `/btw` branch, a switch to a session with the same list), omp
	 * sends nothing: the next call runs under the new id without the full list sent first.
	 */
	replace(phases: TodoPhase[], signal: AbortSignal): Promise<void>;
}

/** Registration payload for `pi.registerTodoBackend()`. */
export interface TodoBackendDefinition {
	/**
	 * Value users put in the `todo.backend` setting. Must not be `native`; an id already registered by
	 * another extension logs a warning and is used only while that extension is disabled.
	 */
	id: string;
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
 * the session's settings scope, and rejects as soon as `signal` aborts.
 */
export interface ActiveTodoBackend {
	readonly label: string;
	/** Sends the committed list first if this backend does not have it. */
	apply(op: TodoOp, params: TodoBackendParams, next: TodoPhase[], signal?: AbortSignal): Promise<void>;
	replace(phases: TodoPhase[], signal?: AbortSignal): Promise<void>;
	sync(signal?: AbortSignal): Promise<void>;
}

export type TodoPhasesUpdate = (current: TodoPhase[]) => TodoPhase[] | undefined;

/**
 * A todo write: gets the backend resolved when it starts (`undefined` = native todos) and
 * `assertCurrent`, which it must call after any backend call and before committing: it throws when
 * the list was reset or reloaded (`/new`, switch, rewind, tree navigation, fork) since the write was
 * enqueued, or, for a queued write, when its abort signal fired. A native write runs inline and, as
 * on `main`, ignores the signal.
 */
export type TodoWrite<T> = (active: ActiveTodoBackend | undefined, assertCurrent: () => void) => Promise<T>;

export interface TodoBackendRegistration {
	readonly definition: TodoBackendDefinition;
	readonly sourceId: string;
}

/**
 * An id already taken is kept with a warning, behind the first registration: it is used only while
 * every earlier registrant of the id is disabled, as a tool's surviving registrant is. The second
 * extension keeps its other registrations, as a conflicting command or shortcut does not fail its
 * extension either.
 */
export function registerTodoBackend(
	registrations: TodoBackendRegistration[],
	definition: TodoBackendDefinition,
	sourceId: string,
): void {
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
	const existing = registrations.find(registration => registration.definition.id === id);
	if (existing) {
		logger.warn("Todo backend id already registered; used only while the earlier extension is disabled", {
			id,
			extensionPath: sourceId,
			existingExtensionPath: existing.sourceId,
		});
	}
	registrations.push({ definition, sourceId });
}
