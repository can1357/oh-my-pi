/**
 * Top-level RPC methods between the main thread and a subagent host worker.
 *
 * Only bootstrap and run entry points live here; every shared service
 * (registry, lifecycle, IRC, jobs, auth, …) crosses as a remote object
 * registered through `./services`.
 */
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { AgentRef } from "../registry/agent-registry";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import type { FollowUpTurnOptions, SubagentRunRequest } from "../task/executor";
import type { PersistedReviveSpec } from "../task/persisted-revive";
import type { ThreadId } from "./identity";
import type { RpcLink, RpcMethod } from "./rpc";

/** Raw first message main posts to a new worker, before any RPC frame. */
export interface SubagentWorkerInit {
	readonly type: "subagent-worker-init";
	readonly threadId: ThreadId;
	/** Port the worker drains synchronously for `callSync` replies. */
	readonly replyPort: MessagePort;
	/** Backing store of the sync reply counter. */
	readonly counter: SharedArrayBuffer;
}

/** Raw message a worker posts once its link is listening. */
export interface SubagentWorkerReady {
	readonly type: "subagent-worker-ready";
}

/** What a worker warms up for: the session context its subagents will inherit. */
export interface SubagentWorkerWarmUp {
	/** Working directory of the sessions spawning subagents. */
	readonly cwd: string;
	/** Settings subagents derive theirs from; without them (or the registry) no warm-up session runs. */
	readonly settings?: Settings;
	/** Registry subagents inherit (crosses as the worker's mirror). */
	readonly modelRegistry?: ModelRegistry;
}

/** Methods the main thread serves to workers. */
export type SubagentMainApi = {
	/** Liveness probe used by the smoke test and the pool's health check. */
	ping: RpcMethod<[nonce: number], number>;
	/** Route a follow-up turn of a session not homed on the calling worker to its home thread. */
	runFollowUpTurn: RpcMethod<[options: FollowUpTurnOptions], SingleResult>;
};

/** Methods a subagent host worker serves to the main thread. */
export type SubagentWorkerApi = {
	/** Hand the worker every main-thread service hook's globals; resolves once worker hooks booted. */
	boot: RpcMethod<[globals: Record<string, unknown>], void>;
	/** Echo after a synchronous round trip to main; proves both directions work. */
	ping: RpcMethod<[nonce: number], number>;
	/** Pay this thread's one-time costs of a first subagent session ahead of it (see `./worker-warm-up`). */
	warmUp: RpcMethod<[options: SubagentWorkerWarmUp], void>;
	/** Run a subagent homed here (main's `runSubprocess` routed into this worker); resolves with its result. */
	runSubprocess: RpcMethod<[request: SubagentRunRequest], SingleResult>;
	/** Run one more monitored turn of a subagent whose session is homed here. */
	runFollowUpTurn: RpcMethod<[options: FollowUpTurnOptions], SingleResult>;
	/** Cold-revive a parked subagent here from its transcript; main receives the session's mirror. */
	revivePersisted: RpcMethod<[spec: PersistedReviveSpec, expected: AgentRef], AgentSessionHandle>;
};

/** Link held by the main thread for one worker. */
export type MainThreadLink = RpcLink<SubagentMainApi, SubagentWorkerApi>;

/** Link held by a worker for the main thread. */
export type WorkerThreadLink = RpcLink<SubagentWorkerApi, SubagentMainApi>;
