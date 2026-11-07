import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type TodoParams, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoBackendParams, TodoOp } from "@oh-my-pi/pi-coding-agent/tools/todo-backend";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./agent-session-setup";

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
	/** Awaited at the start of `apply` with the call's signal, before the error check and before the call is recorded. */
	beforeApply?: (signal: AbortSignal) => void | Promise<void>;
	/** `apply` throws this after `beforeApply` settled; a failed apply is not recorded. */
	applyError?: Error;
	/** Awaited in `replace` with the call's signal, after the call is recorded; lets a test hold a replace in flight. */
	beforeReplace?: (signal: AbortSignal) => void | Promise<void>;
	/** `replace` throws this after `beforeReplace` settled; the call is still recorded. */
	replaceError?: Error;
	/** Extension factory that registers this backend under `id` with `label`. */
	extension(): ExtensionFactory;
}

interface TodoBackendRecorderOptions {
	/** Defaults to `Tracker ${id}`. */
	label?: string;
	/** Append to this array instead of a private one, to see the order of calls across several backends. */
	calls?: RecordedTodoBackendCall[];
}

/**
 * Builds a todo backend that records every call (deep-cloned, so later mutation cannot rewrite
 * history) and registers itself through `recorder.extension()` under `id`.
 */
export function createTodoBackendRecorder(id: string, options: TodoBackendRecorderOptions = {}): TodoBackendRecorder {
	const label = options.label ?? `Tracker ${id}`;
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
							async apply(op, params, next, signal) {
								await recorder.beforeApply?.(signal);
								if (recorder.applyError) throw recorder.applyError;
								calls.push({
									backend: id,
									method: "apply",
									op,
									params: structuredClone(params),
									phases: structuredClone(next),
								});
							},
							async replace(phases, signal) {
								calls.push({ backend: id, method: "replace", phases: structuredClone(phases) });
								await recorder.beforeReplace?.(signal);
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

export interface TodoSessionOptions extends Partial<CreateAgentSessionOptions> {
	/** Value for `todo.backend`; native todos when omitted. */
	backend?: string;
}

/**
 * A real session from `createAgentSession` with isolated settings, an in-memory auth store and
 * only the `read` and `todo` tools. Uses an in-memory transcript unless `sessionManager` is passed.
 * Pair with {@link disposeTodoSession}.
 */
export async function createTodoSession(dir: string, options: TodoSessionOptions = {}): Promise<AgentSession> {
	const { backend, ...rest } = options;
	const authStorage = createInMemoryAuthStorage();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(dir, "models.yml")),
		settings: Settings.isolated(backend ? { "todo.backend": backend } : {}),
		sessionManager: SessionManager.inMemory(),
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
	return session;
}

export async function disposeTodoSession(session: AgentSession): Promise<void> {
	await session.dispose();
	session.modelRegistry.authStorage.close();
}

/** Run one `todo` call through the session's real tool. */
export function todo(session: AgentSession, params: TodoParams, signal?: AbortSignal): Promise<AgentToolResult> {
	const tool = session.getToolByName("todo");
	if (!tool) throw new Error("todo tool is not active");
	return tool.execute(`call-${Snowflake.next()}`, params, signal);
}

/** Holds the recorder's next and later `apply` or `replace` calls until `release` resolves. `started` carries the first held call's signal. */
export function hold(recorder: TodoBackendRecorder, method: "apply" | "replace") {
	const started = Promise.withResolvers<AbortSignal>();
	const release = Promise.withResolvers<void>();
	const gate = async (signal: AbortSignal) => {
		started.resolve(signal);
		await release.promise;
	};
	if (method === "apply") recorder.beforeApply = gate;
	else recorder.beforeReplace = gate;
	return { started, release };
}

/** The rejection value of `promise`, or `undefined` when it resolved. Lets a test observe a pending promise without `expect(...).rejects` blocking on it. */
export function settled(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

/** The `/todo` edits recorded on the session's current branch. */
export function userTodoEdits(session: AgentSession): unknown[] {
	return session.sessionManager
		.getBranch()
		.filter(entry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE);
}

export function taskContents(session: AgentSession): string[] {
	return contentsOf(session.getTodoPhases());
}

export function contentsOf(phases: TodoPhase[]): string[] {
	return phases.flatMap(phase => phase.tasks.map(task => task.content));
}

/** Messages of the todo backend notices `session` emits from now on. */
export function collectNotices(session: AgentSession): string[] {
	const notices: string[] = [];
	session.subscribe(event => {
		if (event.type === "notice" && event.source === "todo-backend") notices.push(event.message);
	});
	return notices;
}
