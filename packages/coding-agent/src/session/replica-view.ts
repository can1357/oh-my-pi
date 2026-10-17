/**
 * Shared mechanics for a TUI that mirrors a remote (host-owned) session: the
 * collab guest and the hosted-session client both load a replica transcript,
 * ingest live host entries, replay host events through the local
 * EventController, and mirror host model/thinking state — all without
 * persisting anything the host did not author.
 */
import * as fs from "node:fs/promises";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { shouldDisableReasoning, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession, AgentSessionEvent } from "./agent-session";
import type { SessionEntry, SessionHeader } from "./session-entries";

export interface ReplicaHostState {
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	/** Overrides the value derived from `thinkingLevel` (`off` ⇒ true). */
	disableReasoning?: boolean;
}

export interface LoadReplicaOptions {
	/** Polled after the file is written; return false to skip activation (caller left/disposed meanwhile). */
	isLive?: () => boolean;
	/**
	 * Create the replica exclusively, with this POSIX mode (e.g. `0o600` for a transcript only its owner may read).
	 * The path must not exist, so a replica a live session manager is still flushing to is never overwritten.
	 * Omitted: overwrite at the default mode, atomically (a reader never sees a truncated or headerless replica).
	 */
	fileMode?: number;
	/**
	 * The host's current leaf (`null`: the empty session). The loader selects the last journal entry as the active
	 * branch, which is not the host's branch whenever it navigated back; with this set the replica follows the host
	 * (`AgentSession.setReplicaLeaf`: in memory only, nothing is written, and the messages and branch-derived caches
	 * are resynchronized). Requires a passive replica session. Omitted: keep the loader's choice.
	 */
	leafId?: string | null;
}

/** `session.switchSession` declined the replica (e.g. a `session_before_switch` hook cancelled it). */
export class ReplicaActivationCancelledError extends Error {
	constructor() {
		super("Replica activation was cancelled");
		this.name = "ReplicaActivationCancelledError";
	}
}

/**
 * Replace `replicaPath` in one rename: `omp gc` reads a replica's header to find its ownership lease, so an
 * overwrite (a resync into the same file) must never expose a truncated, headerless file.
 */
async function writeReplicaAtomically(replicaPath: string, body: string): Promise<void> {
	const tempPath = `${replicaPath}.${Bun.randomUUIDv7()}.tmp`;
	try {
		await Bun.write(tempPath, body);
		await fs.rename(tempPath, replicaPath);
	} catch (err) {
		await fs.unlink(tempPath).catch(() => {});
		throw err;
	}
}

/**
 * Write `[header, ...entries]` to `replicaPath` and switch the local session onto it, keeping the local cwd.
 * Resolves `true` once activated, `false` when `isLive` reported the caller gone before activation.
 * Throws {@link ReplicaActivationCancelledError} when the switch is cancelled.
 */
export async function loadReplica(
	session: AgentSession,
	replicaPath: string,
	header: SessionHeader,
	entries: readonly SessionEntry[],
	options?: LoadReplicaOptions,
): Promise<boolean> {
	const body = `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`;
	if (options?.fileMode === undefined) await writeReplicaAtomically(replicaPath, body);
	else await fs.writeFile(replicaPath, body, { mode: options.fileMode, flag: "wx" });
	if (options?.isLive && !options.isLive()) return false;

	// Resume through AgentSession without adopting the host's cwd. The replica keeps its model:
	// applyReplicaHostState mirrors the host's, which runs inference.
	const switched = await session.switchSession(replicaPath, { preserveLocalCwd: true, keepModel: true });
	if (switched === false) throw new ReplicaActivationCancelledError();
	if (options?.leafId !== undefined && session.sessionManager.getLeafId() !== options.leafId) {
		session.setReplicaLeaf(options.leafId);
	}
	return true;
}

/**
 * Append one host entry to the replica and update the agent's message list. Entries are never
 * rendered directly (rendering is events-only, preventing double-render); they keep the replica
 * file, the agent's message array (/dump, context estimates), and todos current.
 *
 * `authoritative` is the host's active leaf when the entry was announced, from a sequenced client's entry frame:
 * the replica's leaf follows it, so an entry the host appended off its active branch is journaled without
 * contaminating the messages, and a host title change is adopted. The leaf can name an entry announced right
 * after this one; the branch then moves when that entry arrives, and the messages are rebuilt from the branch
 * then. Without it (collab) the entry becomes the leaf.
 */
export function ingestReplicaEntry(
	session: AgentSession,
	entry: SessionEntry,
	authoritative?: { leafId: string | null },
): void {
	const { sessionManager } = session;
	const previousLeaf = sessionManager.getLeafId();
	sessionManager.ingestReplicatedEntry(entry, authoritative);
	if (authoritative) {
		const leaf = sessionManager.getLeafId();
		// The host stayed on its branch (or has not reached the leaf it named yet): nothing the branch shows changed.
		if (leaf === previousLeaf) return;
		const extendsBranch = leaf === entry.id && entry.parentId === previousLeaf;
		if (extendsBranch && entry.type === "message") {
			session.agent.replaceMessages([...session.messages, entry.message]);
		} else if (!extendsBranch || entry.type === "compaction" || entry.type === "branch_summary") {
			// The branch gained several entries at once, or its context was rewritten.
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		}
		return;
	}
	if (entry.type === "message") {
		session.agent.replaceMessages([...session.messages, entry.message]);
	} else if (entry.type === "compaction" || entry.type === "branch_summary") {
		// Compaction/branch entries rewrite the host's model context: the pre-boundary transcript
		// collapses behind a summary. Appending the entry alone leaves the replica holding the stale
		// full history, so rebuild the message array from the ingested entries exactly as the host
		// does after appendCompaction/branchWithSummary (session-maintenance.ts, agent-session.ts).
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	}
}

/** Per-view: has an assistant `message_start` (real or synthesized) been seen for the current stream? */
const assistantStreamSynced = new WeakMap<InteractiveModeContext, boolean>();

/** Forget stream-sync state; call after loading a new snapshot so the next orphan update re-synthesizes its start. */
export function resetReplicaEventState(ctx: InteractiveModeContext): void {
	assistantStreamSynced.delete(ctx);
}

/**
 * Feed one host session event to the TUI.
 *
 * `dispatch` defaults to the controller's direct handler, which a hosted client awaits event by event.
 * The collab guest passes the controller's coalescing `dispatchSessionEvent` instead, the path a local
 * session uses (#14715): `message_update` joins the coalesced streaming rebuild and every other event
 * runs serialized behind it, so a mirrored stream tail cannot reorder.
 *
 * Orphan-delta guard: when attaching mid-turn the `message_start` for the in-flight assistant
 * message predates the snapshot. `message_update` carries the full accumulating message, so the
 * missing start is synthesized once before the first orphaned update; every other handler is
 * tolerant of unknown anchors (guarded by streamingComponent/pendingTools lookups). The state
 * resets when the assistant message ends or the agent run ends.
 */
export async function applyReplicaEvent(
	ctx: InteractiveModeContext,
	event: AgentSessionEvent,
	dispatch: (event: AgentSessionEvent) => Promise<void> = e => ctx.eventController.handleEvent(e),
): Promise<void> {
	// All state transitions happen synchronously on receipt, before any handler is awaited: a slow
	// handler (e.g. one blocked on `ctx.init()`) must neither delay a later event's dispatch nor
	// clobber the flag a newer stream already set.
	let synthesizedStart: Promise<void> | undefined;
	if (event.type === "message_start" && event.message.role === "assistant") {
		assistantStreamSynced.set(ctx, true);
	} else if (
		event.type === "message_update" &&
		event.message.role === "assistant" &&
		!assistantStreamSynced.get(ctx)
	) {
		assistantStreamSynced.set(ctx, true);
		synthesizedStart = dispatch({ type: "message_start", message: event.message });
	} else if ((event.type === "message_end" && event.message.role === "assistant") || event.type === "agent_end") {
		assistantStreamSynced.delete(ctx);
	}
	// Start and event are dispatched back to back without awaiting between them.
	await Promise.all([synthesizedStart, dispatch(event)]);
}

/**
 * Apply the host's real model/thinking state to the replica agent so model display and
 * context-window math are native (no display-string overrides). Pure agent-state mutation:
 * session.setModel/setThinkingLevel would persist entries and clamp to local credentials. A passive
 * replica also mirrors the thinking level into its model controls (what the composer and selectors read).
 */
export function applyReplicaHostState(session: AgentSession, state: ReplicaHostState): void {
	const agent = session.agent;
	if (
		state.model &&
		(agent.state.model?.id !== state.model.id || agent.state.model?.provider !== state.model.provider)
	) {
		agent.setModel(state.model);
	}
	agent.setThinkingLevel(toReasoningEffort(state.thinkingLevel));
	agent.setDisableReasoning(state.disableReasoning ?? shouldDisableReasoning(state.thinkingLevel));
	if (session.passiveReplica) session.setReplicaThinkingLevel(state.thinkingLevel);
}
