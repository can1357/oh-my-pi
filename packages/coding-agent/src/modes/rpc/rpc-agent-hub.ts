/**
 * Agent Hub control over RPC.
 *
 * Mirrors the TUI Hub / collab guest remote: roster from AgentRegistry,
 * steer/revive/kill through AgentLifecycleManager. Nested subagents are
 * visible because they register with `parentId` on the same process-global
 * roster — this is not the task-tool event-bus snapshot (`get_subagents`).
 */
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import {
	type AgentHistorySummary,
	type AgentRef,
	AgentRegistry,
	type AgentStatus,
	MAIN_AGENT_ID,
} from "../../registry/agent-registry";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { RpcAgentSnapshot } from "./rpc-types";

export type AgentHubRpcCode =
	| "unknown_agent"
	| "advisor_readonly"
	| "main_forbidden"
	| "empty_message"
	| "invalid_agent_id"
	| "agent_control_failed";

export type AgentHubRpcFailure = { ok: false; error: string; code: AgentHubRpcCode };
export type AgentHubRpcOk<T> = { ok: true } & T;
export type AgentHubRpcResult<T> = AgentHubRpcOk<T> | AgentHubRpcFailure;

export interface AgentHubRpcDeps {
	registry: AgentRegistry;
	lifecycle: AgentLifecycleManager;
}

const AGENT_STATUS_ORDER: Record<AgentStatus, number> = {
	running: 0,
	idle: 1,
	parked: 2,
	aborted: 3,
};

function fail(error: string, code: AgentHubRpcCode): AgentHubRpcFailure {
	return { ok: false, error, code };
}

function defaultDeps(): AgentHubRpcDeps {
	return { registry: AgentRegistry.global(), lifecycle: AgentLifecycleManager.global() };
}

function asHistory(history: AgentHistorySummary | undefined): AgentHistorySummary | undefined {
	if (!history) return undefined;
	return { ...history, metrics: history.metrics ? { ...history.metrics } : undefined };
}

export function snapshotAgent(ref: AgentRef): RpcAgentSnapshot {
	return {
		id: ref.id,
		displayName: ref.displayName,
		kind: ref.kind,
		parentId: ref.parentId,
		status: ref.status,
		sessionFile: ref.sessionFile,
		createdAt: ref.createdAt,
		lastActivity: ref.lastActivity,
		activity: ref.activity,
		history: asHistory(ref.history),
		live: ref.session !== null,
	};
}

function sortHubRoster(a: AgentRef, b: AgentRef): number {
	return (
		AGENT_STATUS_ORDER[a.status] - AGENT_STATUS_ORDER[b.status] ||
		b.lastActivity - a.lastActivity ||
		a.id.localeCompare(b.id)
	);
}

export function listAgents(deps: AgentHubRpcDeps = defaultDeps()): RpcAgentSnapshot[] {
	return deps.registry
		.list()
		.filter(ref => ref.id !== MAIN_AGENT_ID)
		.sort(sortHubRoster)
		.map(snapshotAgent);
}

function requireControllableAgent(
	agentId: string | undefined,
	deps: AgentHubRpcDeps,
): AgentHubRpcResult<{ ref: AgentRef }> {
	const id = agentId?.trim();
	if (!id) return fail("agentId is required", "invalid_agent_id");
	if (id === MAIN_AGENT_ID) {
		return fail("The main RPC session is not controllable through Agent Hub commands", "main_forbidden");
	}
	const ref = deps.registry.get(id);
	if (!ref) {
		return fail(
			`Unknown agent "${id}" — it was never registered or has been released. If a transcript exists, read history://${id}.`,
			"unknown_agent",
		);
	}
	if (ref.kind === "advisor") {
		return fail(`Agent "${id}" is a read-only advisor transcript`, "advisor_readonly");
	}
	return { ok: true, ref };
}

export async function sendAgentMessage(
	agentId: string | undefined,
	message: string | undefined,
	deps: AgentHubRpcDeps = defaultDeps(),
): Promise<AgentHubRpcResult<{ agent: RpcAgentSnapshot }>> {
	const resolved = requireControllableAgent(agentId, deps);
	if (!resolved.ok) return resolved;
	const trimmed = message?.trim();
	if (!trimmed) return fail("message is required", "empty_message");
	try {
		const session = await deps.lifecycle.ensureLive(resolved.ref.id);
		await session.prompt(trimmed, { streamingBehavior: "steer" });
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), "agent_control_failed");
	}
	const live = deps.registry.get(resolved.ref.id) ?? resolved.ref;
	return { ok: true, agent: snapshotAgent(live) };
}

export async function reviveAgent(
	agentId: string | undefined,
	deps: AgentHubRpcDeps = defaultDeps(),
): Promise<AgentHubRpcResult<{ agent: RpcAgentSnapshot }>> {
	const resolved = requireControllableAgent(agentId, deps);
	if (!resolved.ok) return resolved;
	try {
		await deps.lifecycle.ensureLive(resolved.ref.id);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), "agent_control_failed");
	}
	const live = deps.registry.get(resolved.ref.id) ?? resolved.ref;
	return { ok: true, agent: snapshotAgent(live) };
}

export async function killAgent(
	agentId: string | undefined,
	deps: AgentHubRpcDeps = defaultDeps(),
): Promise<AgentHubRpcResult<{ agent: RpcAgentSnapshot }>> {
	const resolved = requireControllableAgent(agentId, deps);
	if (!resolved.ok) return resolved;
	const ref = resolved.ref;
	try {
		if (ref.status === "running" && ref.session) {
			await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		await deps.lifecycle.release(ref.id, ref, { tombstone: true });
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), "agent_control_failed");
	}
	const killed = deps.registry.get(ref.id);
	if (!killed) {
		return {
			ok: true,
			agent: snapshotAgent({
				...ref,
				status: "aborted",
				session: null,
				activity: undefined,
			}),
		};
	}
	return { ok: true, agent: snapshotAgent(killed) };
}
