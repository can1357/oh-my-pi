import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type { TodoOperation, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ExtensionContext } from "../extensibility/extensions/types";
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
export function todoBackendText(value: unknown): string {
	return sanitizeDisplayLine(value instanceof Error ? value.message : String(value));
}

/**
 * The `todo` tool's params; only keys declared by the tool schema.
 * Public extension-facing name for the tool's `TodoParams`.
 *
 * The tool validates leniently: when the model's arguments do not match the schema, they still
 * reach the tool, and `apply` sees them once omp applied them without errors. Values are not
 * re-checked against these types.
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
 * waiting: the next call can then start while one that ignores `signal` is still running. A
 * `create` that runs out of the same budget falls back to native todos.
 */
export interface TodoBackend {
	/**
	 * Called after omp applied `op` natively and before it commits `next`. A throw fails the call
	 * and leaves the list unchanged.
	 */
	apply(op: TodoOp, params: TodoBackendParams, next: TodoPhase[], signal: AbortSignal): Promise<void>;
	/** Called for edits made outside the `todo` tool. A throw leaves the list unchanged. */
	replace(phases: TodoPhase[], signal: AbortSignal): Promise<void>;
}

/** Registration payload for `pi.registerTodoBackend()`. */
export interface TodoBackendDefinition {
	/**
	 * Value users put in the `todo.backend` setting. Must not be `native`; `register` rejects a duplicate.
	 */
	id: string;
	/** Human-readable name. */
	label: string;
	description?: string;
	/** Builds the backend for the main session. A throw makes omp fall back to native todos. */
	create(ctx: ExtensionContext): TodoBackend | Promise<TodoBackend>;
}

/**
 * A resolved backend for the main session. Each call runs within the extension handler budget and
 * the session's settings scope, and rejects as soon as `signal` aborts. `undefined` in its place
 * means native todos.
 */
export interface ActiveTodoBackend {
	readonly id: string;
	readonly label: string;
	apply(op: TodoOp, params: TodoBackendParams, next: TodoPhase[], signal?: AbortSignal): Promise<void>;
	replace(phases: TodoPhase[], signal?: AbortSignal): Promise<void>;
}

/**
 * Handed to a queued todo write. Call {@link assertCurrent} after any backend call and before
 * committing: it throws when the write's abort signal fired or the session's todo list was reset
 * or reloaded (`/new`, switch, rewind, tree navigation, fork) since the write was enqueued.
 */
export interface TodoWriteGuard {
	assertCurrent(): void;
}

/** Todo backends registered by extensions, in registration order. */
export class TodoBackendRegistry {
	readonly #byId = new Map<string, { definition: TodoBackendDefinition; sourceId: string }>();

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
			throw new Error(`Todo backend "${id}" from ${sourceId} is already registered by ${existing.sourceId}`);
		}
		this.#byId.set(id, { definition, sourceId });
	}

	get(id: string): TodoBackendDefinition | undefined {
		return this.#byId.get(id)?.definition;
	}

	list(): readonly TodoBackendDefinition[] {
		return Array.from(this.#byId.values(), entry => entry.definition);
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
