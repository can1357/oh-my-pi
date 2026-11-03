import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TodoBackendParams, TodoOp } from "@oh-my-pi/pi-coding-agent/tools/todo-backend";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

/** One backend call as the recorder saw it. `phases` is `next` for `apply` and the replacement list for `replace`. */
export interface RecordedTodoBackendCall {
	/** Id the backend was registered under. */
	backend: string;
	method: "apply" | "replace";
	/** Operation name; only set for `apply`. */
	op?: TodoOp;
	/** Params as the backend received them; only set for `apply`. */
	params?: TodoBackendParams;
	phases: TodoPhase[];
}

/** A recording todo backend plus the switches a test flips to hold or fail its calls. */
export interface TodoBackendRecorder {
	/** Every recorded call, in arrival order. Shared between recorders when `options.calls` is passed. */
	readonly calls: RecordedTodoBackendCall[];
	/** Number of times `create` ran. */
	created: number;
	/** `create` throws this when set. */
	createError?: Error;
	/** Awaited at the start of `apply`, before the error check and before the call is recorded. */
	beforeApply?: () => void | Promise<void>;
	/** `apply` throws this after `beforeApply` settled; a failed apply is not recorded. */
	applyError?: Error;
	/** Awaited in `replace` after the call is recorded; lets a test hold a replace in flight. */
	beforeReplace?: () => void | Promise<void>;
	/** `replace` throws this after `beforeReplace` settled; the call is still recorded. */
	replaceError?: Error;
	/** Extension factory that registers this backend under `id` with `label`. */
	extension(): ExtensionFactory;
}

export interface TodoBackendRecorderOptions {
	/** Defaults to `Recorder ${id}`. */
	label?: string;
	/** Append to this array instead of a private one, to see the order of calls across several backends. */
	calls?: RecordedTodoBackendCall[];
}

/**
 * Builds a todo backend that records every call (deep-cloned, so later mutation cannot rewrite
 * history) and registers itself through `recorder.extension()` under `id`.
 */
export function createTodoBackendRecorder(id: string, options: TodoBackendRecorderOptions = {}): TodoBackendRecorder {
	const label = options.label ?? `Recorder ${id}`;
	const calls = options.calls ?? [];
	const recorder: TodoBackendRecorder = {
		calls,
		created: 0,
		extension() {
			return pi => {
				pi.registerTodoBackend({
					id,
					label,
					create() {
						recorder.created++;
						if (recorder.createError) throw recorder.createError;
						return {
							async apply(op, params, next) {
								await recorder.beforeApply?.();
								if (recorder.applyError) throw recorder.applyError;
								calls.push({
									backend: id,
									method: "apply",
									op,
									params: structuredClone(params),
									phases: structuredClone(next),
								});
							},
							async replace(phases) {
								calls.push({ backend: id, method: "replace", phases: structuredClone(phases) });
								await recorder.beforeReplace?.();
								if (recorder.replaceError) throw recorder.replaceError;
							},
						};
					},
				});
			};
		},
	};
	return recorder;
}

/**
 * Resolves once every todo write already queued on `session` has settled. Waits on the session's
 * own serial queue, so it needs no timers and no guess at how many microtask turns are enough.
 */
export async function flushTodoWrites(session: Pick<AgentSession, "runTodoWrite">): Promise<void> {
	await session.runTodoWrite(async () => {});
}
