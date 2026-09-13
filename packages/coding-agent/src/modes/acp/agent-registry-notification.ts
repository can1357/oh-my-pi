/**
 * Mirrors the in-process AgentRegistry to the ACP client as an extension
 * notification, the same way CollabHost mirrors it to collab guests.
 *
 * ACP proper has no subagent layer: a `task` call reaches the client as one
 * `tool_call` whose result lands when the last child yields, and nothing in
 * the standard update set names a parent or a child. A client hosting omp
 * over ACP (an editor, a control plane) therefore sees a fan-out as one slow
 * tool. The registry already knows every agent, its parent, its status, and
 * its transcript, and `CollabHost.#snapshotAgents` already broadcasts that to
 * guests; this sends the same roster to the ACP client whenever it changes,
 * and on a coarse interval while any agent is running, because the mutations
 * that carry live intent and session identity emit no registry event.
 *
 * Method name and payload are the ones ompd already validates
 * (`packages/acp/src/client.ts` in jwaldrip/ompctl): `notifications/agent_registry`
 * with `{ agents: [...] }`. Advisors are included, unlike the collab
 * broadcast, because an ACP client is the operator's own process rather than
 * a guest; the `kind` field lets a client drop them.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";
import { type AgentRef, AgentRegistry } from "../../registry/agent-registry";
import { readSessionMetrics } from "../components/agent-hub-projection";

export const AGENT_REGISTRY_NOTIFICATION = "notifications/agent_registry";

/** Coalesces the burst of registry events a fan-out produces into one frame; same window as CollabHost. */
const REGISTRY_DEBOUNCE_MS = 100;

/**
 * Ceiling on how stale a running agent's intent, recency, or session id can be.
 * Registry mutations that carry those deliberately emit no event, so the mirror
 * re-reads on this cadence instead; same window as `CollabHost`'s streaming
 * state, and identical payloads are dropped rather than sent.
 */
const REGISTRY_REFRESH_MS = 2000;

export interface AgentRegistrySnapshot {
	id: string;
	displayName: string;
	kind: AgentRef["kind"];
	parentId?: string;
	/** The parent's session id, so a client keyed by session rather than registry id can attach the child. */
	parentSessionId?: string;
	/** The agent's own session id while it has a live session; absent once parked or aborted. */
	sessionId?: string;
	status: AgentRef["status"];
	createdAt: string;
	lastActiveAt: string;
	taskTitle?: string;
	/** `provider/id`, live from the attached session, else the last resolved model of a detached one. */
	model?: string;
	/**
	 * `durationMs` is present only for a detached ref, where the executor has
	 * written a final span. A live agent's elapsed time is `createdAt` to
	 * `lastActiveAt`, both above: a wall-clock field here would differ on every
	 * refresh tick and turn the change-only send into an unconditional one.
	 */
	metrics?: { usedTokens: number; costAmount?: number; durationMs?: number };
}

export function snapshotAgentRegistry(registry: AgentRegistry = AgentRegistry.global()): AgentRegistrySnapshot[] {
	const refs = registry.list();
	// `AgentRef.session` is documented null exactly when parked/aborted, but the
	// status update lands before the disposal that detaches it, so a ref carries
	// a stale session for that window. Trust the status over the field: a frame
	// must never advertise a session id its own status says is already gone.
	const liveSessionIds = new Map<string, string>();
	for (const ref of refs) {
		if (ref.session && ref.status !== "parked" && ref.status !== "aborted") {
			liveSessionIds.set(ref.id, ref.session.sessionId);
		}
	}
	return refs.map(ref => {
		const parentSessionId = ref.parentId === undefined ? undefined : liveSessionIds.get(ref.parentId);
		// A freshly spawned subagent carries no `history` until the executor
		// writes one, and a revived ref's history describes its previous
		// transcript, so the attached session wins whenever there is one.
		const live = liveSessionIds.has(ref.id) && ref.session?.isDisposed === false ? ref.session : null;
		// `readSessionMetrics` rather than `getSessionStats` directly: stats fold
		// in the usage carried by a completed `task` result, which would bill a
		// parent for children that report the same tokens on their own rows.
		const liveMetrics = live === null ? undefined : readSessionMetrics(live);
		const history = ref.history?.metrics;
		const snapshot: AgentRegistrySnapshot = {
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			status: ref.status,
			createdAt: new Date(ref.createdAt).toISOString(),
			lastActiveAt: new Date(ref.lastActivity).toISOString(),
		};
		if (ref.parentId !== undefined) snapshot.parentId = ref.parentId;
		if (parentSessionId !== undefined) snapshot.parentSessionId = parentSessionId;
		const sessionId = liveSessionIds.get(ref.id);
		if (sessionId !== undefined) snapshot.sessionId = sessionId;
		if (ref.activity !== undefined) snapshot.taskTitle = ref.activity;
		const liveModel = live?.model;
		// Same `provider/id` shape `history.resolvedModel` is built with.
		if (liveModel !== undefined) snapshot.model = `${liveModel.provider}/${liveModel.id}`;
		else if (ref.history?.resolvedModel !== undefined) snapshot.model = ref.history.resolvedModel;
		if (liveMetrics !== undefined) {
			snapshot.metrics = { usedTokens: liveMetrics.tokens, costAmount: liveMetrics.cost };
		} else if (history !== undefined) {
			snapshot.metrics = {
				usedTokens: history.tokens,
				costAmount: history.cost,
				durationMs: history.durationMs,
			};
		}
		return snapshot;
	});
}

/**
 * Subscribe the connection to registry changes. Returns the unsubscribe;
 * the caller owns it and runs it on dispose so a disposed agent never sends
 * on a closed connection.
 *
 * Registry events alone do not describe a running fan-out. `setActivity` and
 * `attachSession` mutate a ref without emitting, deliberately, to keep the
 * per-tool-call rate off the listener path; so intent text, `lastActiveAt`,
 * and a session that lands after the registration frame would otherwise never
 * reach the client. While any agent is `running` this re-snapshots on a coarse
 * interval and sends only when the payload actually changed, which is the
 * shape `CollabHost` uses for streaming state. It adds no registry events, so
 * the registry's bounded listener contract is untouched, and it holds no timer
 * once the last agent stops.
 */
export function mirrorAgentRegistry(
	connection: Pick<AgentSideConnection, "extNotification">,
	registry: AgentRegistry = AgentRegistry.global(),
): () => void {
	let debounce: Timer | null = null;
	let refresh: Timer | null = null;
	let lastJson = "";
	let stopped = false;

	function schedule(): void {
		if (stopped || debounce !== null) return;
		debounce = setTimeout(send, REGISTRY_DEBOUNCE_MS);
	}

	// Armed only while work is live, so an idle connection holds no timer.
	function syncRefresh(): void {
		const live = !stopped && registry.list().some(ref => ref.status === "running");
		if (live && refresh === null) {
			refresh = setInterval(schedule, REGISTRY_REFRESH_MS);
		} else if (!live && refresh !== null) {
			clearInterval(refresh);
			refresh = null;
		}
	}

	function send(): void {
		debounce = null;
		if (stopped) return;
		// Before the dedupe: a tick that says nothing new still has to decide
		// whether the interval is still earning its keep.
		syncRefresh();
		const params = { agents: snapshotAgentRegistry(registry) };
		const json = JSON.stringify(params);
		if (json === lastJson) return;
		lastJson = json;
		// This runs from a timer, so a synchronous throw here has no caller to
		// catch it: it would surface as an unhandled exception rather than a
		// dropped roster frame. Observability must never be able to do that.
		try {
			void connection.extNotification(AGENT_REGISTRY_NOTIFICATION, params).catch(error => {
				logger.debug("agent registry notification failed", { error });
			});
		} catch (error) {
			logger.debug("agent registry notification failed", { error });
		}
	}

	const unsubscribe = registry.onChange(schedule);
	// `onChange` cannot report refs that predate the subscription, and a roster
	// of only idle or parked agents arms no refresh, so an embedder that hands
	// us a session it created would otherwise see nothing until some unrelated
	// mutation. One frame instead, which `send` follows with the usual decision
	// about whether an interval is warranted; an empty registry has nothing to
	// state, so it stays silent.
	if (registry.list().length > 0) schedule();
	return () => {
		stopped = true;
		unsubscribe();
		if (debounce !== null) {
			clearTimeout(debounce);
			debounce = null;
		}
		if (refresh !== null) {
			clearInterval(refresh);
			refresh = null;
		}
	};
}
