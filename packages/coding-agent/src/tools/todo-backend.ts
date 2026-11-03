import type { TodoOperation, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ExtensionContext } from "../extensibility/extensions/types";
import type { TodoParams } from "./todo";

/** Id of omp's built-in todo list. Reserved: extensions cannot register it. */
export const NATIVE_TODO_BACKEND_ID = "native";

/**
 * The `todo` tool's validated params; only keys declared by the tool schema.
 * Public extension-facing name for the tool's `TodoParams`.
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
 */
export interface TodoBackend {
	/**
	 * Called after omp applied `op` natively and before it commits `next`. A throw fails the call
	 * and leaves the list unchanged.
	 */
	apply(op: TodoOp, params: TodoBackendParams, next: TodoPhase[]): Promise<void>;
	/** Called for edits made outside the `todo` tool. A throw leaves the list unchanged. */
	replace(phases: TodoPhase[]): Promise<void>;
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

/** A resolved backend for the main session. `undefined` in its place means native todos. */
export interface ActiveTodoBackend {
	readonly id: string;
	readonly label: string;
	readonly backend: TodoBackend;
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
}
