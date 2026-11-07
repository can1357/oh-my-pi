/**
 * The `spawnSubagent` seam: a background subagent launched through the task
 * executor, resolved to its registry ref as soon as the child session
 * registers.
 *
 * The run is fully detached: this function never waits for the agent to settle,
 * so a caller can answer (e.g. an A2A SendMessage) with `agent://<id>` while the
 * turn runs. Errors before registration reject the spawn; later failures are
 * logged and stay visible on the ref's lifecycle.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { assertNotRemoteA2aAgent } from "../a2a/agent-bridge";
import type { SpawnSubagentOptions } from "../extensibility/extensions/types";
import { AgentRegistry, type AgentRef, type AgentRegistryApi } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { acquireSessionSpawnPermit, releaseSessionSpawnPermit } from "./spawn-limiter";
import {
	type StructuredSubagentIdentity,
	type StructuredSubagentRequest,
	type StructuredSubagentResult,
	reserveStructuredSubagentId,
	runStructuredSubagent,
} from "./structured-subagent";

/** Upper bound on how long a spawn waits for the child's registry ref. */
const SPAWN_REF_TIMEOUT_MS = 15_000;

/**
 * The run was reserved but its registry ref did not appear in time. The run is
 * still live: callers must report the reserved id as pending/submitted instead
 * of failing, or a client retry would spawn a duplicate agent.
 */
export class SpawnPendingError extends Error {
	readonly agentId: string;

	constructor(agentId: string) {
		super(`Subagent ${agentId} was reserved but did not register in time; the run is still starting`);
		this.name = "SpawnPendingError";
		this.agentId = agentId;
	}
}

/** Executor boundary; tests substitute a fake without a live model or session. */
export interface SpawnSubagentExecutor {
	reserveId: (session: ToolSession, identity: StructuredSubagentIdentity | undefined) => Promise<string>;
	run: (request: StructuredSubagentRequest) => Promise<StructuredSubagentResult>;
}

const defaultExecutor: SpawnSubagentExecutor = {
	reserveId: reserveStructuredSubagentId,
	run: runStructuredSubagent,
};

/** Host surface the seam needs: the session's tool-facing view. */
export interface SpawnSubagentHost {
	toolSession?: ToolSession;
}

/**
 * `/team start` opts a child into peer messaging: the executor grants the
 * `write` tool (needed for `agent://` sends) even when the agent definition
 * is read-only. Non-team spawns never set it.
 */
export interface TeamSpawnSubagentOptions extends SpawnSubagentOptions {
	teamIrc?: boolean;
	/** An ID reserved for this team before contexts were rendered. */
	teamReservedId?: string;
}

/**
 * Spawn for a host session (extension hosts, the CLI). Throws when the session
 * has no tool view — a session that cannot run tools cannot spawn subagents.
 */
export async function spawnSubagentForSession(
	session: SpawnSubagentHost,
	options: TeamSpawnSubagentOptions,
	executor?: SpawnSubagentExecutor,
): Promise<AgentRef> {
	const toolSession = session.toolSession;
	if (!toolSession) throw new Error("spawnSubagent is unavailable on a session without a tool session");
	return spawnSubagentViaExecutor(toolSession, options, executor);
}

/**
 * Spawn a subagent for an extension or bridge caller. `agent` resolves like a
 * `task` call's agent (the session's configured default when omitted); the
 * child keeps ordinary subagent rights and stays alive after its run.
 */
export async function spawnSubagentViaExecutor(
	session: ToolSession,
	options: TeamSpawnSubagentOptions,
	executor: SpawnSubagentExecutor = defaultExecutor,
	refTimeoutMs = SPAWN_REF_TIMEOUT_MS,
): Promise<AgentRef> {
	const prompt = options.prompt.trim();
	if (prompt.length === 0) throw new Error("spawnSubagent requires a non-empty prompt");
	// Only the task tool can route a remote A2A agent to its endpoint; here the
	// executor would run the placeholder definition locally.
	assertNotRemoteA2aAgent(session, options.agent);
	const registry = AgentRegistry.global();
	// The seam is one more spawn path in this session: it takes the same
	// semaphore as the task tool and workflow agent(), so task.maxConcurrency
	// and task.concurrencyPolicy apply. A refused spawn throws before reserving.
	await acquireSessionSpawnPermit(session);
	let id: string;
	let run: Promise<StructuredSubagentResult>;
	try {
		id = options.teamReservedId ?? (await executor.reserveId(session, { label: options.handle ?? options.agent }));
		run = executor.run({
			session,
			invocationKind: "task",
			assignment: prompt,
			agent: options.agent,
			identity: { id, label: options.handle ?? options.agent },
			context: options.context,
			...(options.teamWorkspace !== undefined ? { teamWorkspace: options.teamWorkspace } : {}),
			...(options.teamIrc === true ? { teamIrc: true } : {}),
			detached: true,
			retainArtifacts: true,
			keepAlive: true,
		});
	} catch (error) {
		releaseSessionSpawnPermit(session);
		throw error;
	}
	// The run outlives this call: log a later failure instead of leaving an
	// unhandled rejection, let the ref's lifecycle carry the outcome, and hold
	// the spawn slot until the run actually settles — not merely until it
	// registers.
	const settled = run.catch(error => {
		logger.warn("spawnSubagent run failed", {
			agentId: id,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	void settled.finally(() => releaseSessionSpawnPermit(session));
	return awaitRegisteredRef(
		registry,
		id,
		run.then(() => undefined),
		refTimeoutMs,
	);
}

/**
 * Resolve the ref once the executor registers it. The executor registers the
 * child before its first model request, so this normally resolves immediately
 * after session construction; a run that rejects first fails the spawn.
 */
async function awaitRegisteredRef(
	registry: AgentRegistryApi,
	id: string,
	failure: Promise<undefined>,
	timeoutMs: number,
): Promise<AgentRef> {
	const existing = registry.get(id);
	if (existing) return existing;
	const { promise, resolve, reject } = Promise.withResolvers<AgentRef>();
	const timer = setTimeout(() => reject(new SpawnPendingError(id)), timeoutMs);
	// A spawn must not pin the event loop for the whole timeout.
	timer.unref?.();
	const unsubscribe = registry.onChange(event => {
		if (event.ref.id === id) resolve(event.ref);
	});
	failure.catch(reject);
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
}
