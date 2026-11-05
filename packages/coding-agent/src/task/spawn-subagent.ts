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
import type { SpawnSubagentOptions } from "../extensibility/extensions/types";
import { AgentRegistry, type AgentRef, type AgentRegistryApi } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import {
	type StructuredSubagentIdentity,
	type StructuredSubagentRequest,
	type StructuredSubagentResult,
	reserveStructuredSubagentId,
	runStructuredSubagent,
} from "./structured-subagent";

/** Upper bound on how long a spawn waits for the child's registry ref. */
const SPAWN_REF_TIMEOUT_MS = 15_000;

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
 * Spawn for a host session (extension hosts, the CLI). Throws when the session
 * has no tool view — a session that cannot run tools cannot spawn subagents.
 */
export async function spawnSubagentForSession(
	session: SpawnSubagentHost,
	options: SpawnSubagentOptions,
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
	options: SpawnSubagentOptions,
	executor: SpawnSubagentExecutor = defaultExecutor,
): Promise<AgentRef> {
	const prompt = options.prompt.trim();
	if (prompt.length === 0) throw new Error("spawnSubagent requires a non-empty prompt");
	const registry = AgentRegistry.global();
	const id = await executor.reserveId(session, { label: options.agent });
	const run = executor.run({
		session,
		invocationKind: "task",
		assignment: prompt,
		agent: options.agent,
		context: options.context,
		identity: { id },
		detached: true,
		retainArtifacts: true,
		keepAlive: true,
	});
	// The run outlives this call: log a later failure instead of leaving an
	// unhandled rejection, and let the ref's lifecycle carry the outcome.
	void run.catch(error => {
		logger.warn("spawnSubagent run failed", {
			agentId: id,
			error: error instanceof Error ? error.message : String(error),
		});
	});
	return awaitRegisteredRef(
		registry,
		id,
		run.then(() => undefined),
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
): Promise<AgentRef> {
	const existing = registry.get(id);
	if (existing) return existing;
	const { promise, resolve, reject } = Promise.withResolvers<AgentRef>();
	const timer = setTimeout(
		() => reject(new Error(`Subagent ${id} did not register within ${SPAWN_REF_TIMEOUT_MS}ms`)),
		SPAWN_REF_TIMEOUT_MS,
	);
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
