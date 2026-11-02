/**
 * Due-by clock for dispatched subagents.
 *
 * The dispatcher states, per spawn, when it expects the result (`dueMinutes`),
 * or takes `task.dueMinutes`. The clock runs in the process, outside every
 * agent's turn: an owner inside a blocking `task` call reads nothing until the
 * call returns, so it cannot time its own child. At the due-by the owner is
 * told; at twice the time, the owner's owner is told (the agent that
 * dispatched the owner, or the person at the UI when the owner is the
 * top-level session). A child that settles first disarms its clock.
 *
 * Nothing is stopped. Passing a due-by says the expectation was wrong, not
 * the child, so the notices say "taking longer than you said".
 *
 * Invariant (one rule, covering every identity edge). A notice addressed to a
 * dispatch is delivered to a session if and only if that session's live
 * conversation — the entries on its current branch, from the leaf back to the
 * nearest context-reset boundary — still holds the entry the address is
 * anchored to: the entry carrying the dispatching tool call once that call is
 * in the transcript, and until then (a child launched while its call still
 * streams, an ancestor the clock recorded no dispatch for) the leaf the
 * recipient was at when the work was dispatched. The address advances from
 * that leaf to the dispatching call, never back. While a recipient is
 * mid-transition the delivery waits for the transition to settle and
 * re-checks; it never lands in any other session, and a notice with no such
 * session is surfaced once as a loss. This replaces the earlier identity and
 * conversation tokens: a full fork keeps the entry (still owns it), returning
 * to a navigated-away leaf restores it, a `/new`/switch/branch drops it, and a
 * transcript the dispatch never reached (a worker revived onto a different
 * transcript than the one it dispatched from, a replacement under a reused id)
 * does not hold it, so none of them can be misdelivered to.
 */
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { formatDuration, logger, prompt } from "@oh-my-pi/pi-utils";
import escalationTemplate from "../prompts/tools/subagent-overdue-escalation.md" with { type: "text" };
import ownerTemplate from "../prompts/tools/subagent-overdue.md" with { type: "text" };
import type { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { SessionEntry } from "../session/session-entries";
import type { CustomMessage } from "../session/messages";

/**
 * Due-by, in minutes, for a dispatch that names none (`task.dueMinutes`).
 *
 * Chosen so a dispatcher that names nothing is rarely told about a job that
 * behaves as intended. Over one week of a busy multi-agent workload
 * (2026-10-24 to 2026-10-31), subagent sessions (29,769) ran a median 19.7 min
 * and a p90 of 198 min; 14.6% ran 2 h or more, 8.5% 4 h, 5.8% 6 h and 2.4%
 * 12 h. Session length includes idle follow-up turns, so it overstates run
 * length: over the same week, completed `task` calls (22,531) passed 6 h in
 * 1.3% and 12 h in 0.2%. So with 6 h, an owner that names no due-by is told
 * about at most one normal job in seventeen, and its own owner, at 12 h,
 * about one in forty. A 2 h default would have told the owner about one in
 * seven. Work expected to finish sooner, or to run longer, names its own.
 */
export const DEFAULT_TASK_DUE_MINUTES = 360;

/** Custom message type of a due-by notice. */
export const SUBAGENT_OVERDUE_MESSAGE_TYPE = "subagent-overdue";

/** `setTimeout` fires at once past this delay; longer waits re-arm in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A session that is mid-transition can settle and be re-checked a bounded number of times. */
const MAX_TRANSITION_WAITS = 8;

/**
 * Where a notice is delivered: a conversation addressed by one entry of it. A
 * recipient holds the address only while its live branch still contains that
 * entry; an id reused later, or a transcript the dispatch never reached, does
 * not.
 */
export interface DispatchAnchor {
	/** Registry id of the recipient this address names. */
	id: string;
	/**
	 * The entry the address is anchored to: the entry carrying {@link toolCallId}
	 * once that call is in the transcript, until then the leaf the recipient was
	 * at when the work was dispatched. Null only when it held no conversation.
	 */
	entryId: string | null;
	/**
	 * The dispatching tool call id, for the agent that dispatched the work
	 * directly, while its entry has still to appear: the address advances onto
	 * that entry as soon as the branch holding the leaf carries it, and the id
	 * is then dropped so a later cut between the two is seen as the loss it is.
	 */
	toolCallId: string | undefined;
}

/** One dispatch the clock watches. */
export interface SubagentDispatch {
	/** Registry id of the dispatched subagent. */
	childId: string;
	/** The agent that dispatched it. */
	owner: DispatchAnchor;
	/** The owner's own dispatchers, nearest first, as addresses recorded at their dispatch. */
	ancestors: readonly DispatchAnchor[];
	/** The main session as it was at dispatch: the person at its UI is warned when no ancestor holds. */
	main: DispatchAnchor;
	/** Agent type of the child, for the notice. */
	agent: string;
	dispatchedAt: number;
	dueMs: number;
	/** The dispatcher named the due-by, rather than taking the default. */
	stated: boolean;
}

/** What `arm` is given per dispatch; the clock builds the delivery addresses from it. */
export interface SubagentDispatchInput {
	/** Registry id of the dispatched subagent. */
	childId: string;
	/** Registry id of the agent that dispatched it. */
	ownerId: string;
	/** The dispatching tool call id (the `task` call that started the child). */
	toolCallId: string;
	/** Agent type of the child, for the notice. */
	agent: string;
	dispatchedAt: number;
	dueMs: number;
	/** The dispatcher named the due-by, rather than taking the default. */
	stated: boolean;
}

/** What ends a watch: the run settling, or the run being cancelled. */
export interface SubagentRunWatch {
	/** Settles (either way) when the run ends; observed here, never left unhandled. */
	settled: Promise<unknown>;
	/** Aborted when the run is cancelled, even while it is still winding down. */
	signal: AbortSignal;
}

/** Whether `message` carries a tool call with id `toolCallId`. */
function hasToolCall(message: AssistantMessage, toolCallId: string): boolean {
	const content = message.content;
	if (!Array.isArray(content)) return false;
	for (const part of content) {
		if (typeof part === "object" && part !== null && part.type === "toolCall" && part.id === toolCallId) return true;
	}
	return false;
}

/**
 * The id of the entry on `session`'s live conversation that the address names,
 * or null when that conversation does not hold it. The live conversation is the
 * branch from the leaf back to the nearest context reset: a `/clear` boundary
 * ends it, so entries before the reset no longer count. With a `toolCallId` the
 * entry sought is the assistant entry carrying that call; otherwise it is
 * `entryId` itself. Exactly one of the two is given.
 */
function findDispatchEntry(session: AgentSession, toolCallId: string | undefined, entryId: string | null): string | null {
	const branch: readonly SessionEntry[] = session.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "reset_boundary") break;
		if (toolCallId === undefined) {
			if (entry.id === entryId) return entry.id;
		} else if (entry.type === "message" && entry.message.role === "assistant" && hasToolCall(entry.message, toolCallId)) {
			return entry.id;
		}
	}
	return null;
}

/** One rendered notice queued for an agent; dropped unread once it goes stale. */
export interface SubagentOverdueEntry {
	childId: string;
	stage: "owner" | "escalation";
	text: string;
	/** The child settled, or the recipient is no longer the conversation it was addressed to. */
	isStale(): boolean;
}

/** Batch the queued notices into one model-visible message. */
export function buildSubagentOverdueMessage(entries: SubagentOverdueEntry[]): CustomMessage {
	return {
		role: "custom",
		customType: SUBAGENT_OVERDUE_MESSAGE_TYPE,
		content: entries.map(entry => entry.text).join("\n\n"),
		display: true,
		attribution: "agent",
		details: { notices: entries.map(({ childId, stage }) => ({ childId, stage })) },
		timestamp: Date.now(),
	};
}

function isoMinute(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

/** A running subagent's due-by as the process view shows it: when it falls, or that there is none. */
export function describeDueBy(clock: SubagentDueClock, childId: string): string {
	const at = clock.dueAt(childId);
	return at === undefined ? "no due-by" : `due by ${isoMinute(at)}`;
}

export class SubagentDueClock {
	readonly #registry: AgentRegistry;
	readonly #timers = new Set<NodeJS.Timeout>();
	/** Due-by (wall clock) of each child whose clock runs, for the process view. */
	readonly #dueAt = new Map<string, { at: number }>();
	/**
	 * The address of the agent that dispatched each live child, keyed by the
	 * child's id. A new dispatch records its owner here, so a dispatch made by
	 * that child later can walk the chain of conversations that asked for the
	 * work. Dropped when the child's own clock disarms.
	 */
	readonly #origins = new Map<string, DispatchAnchor>();

	constructor(registry: AgentRegistry) {
		this.#registry = registry;
	}

	/** When `childId`'s due-by falls, while its clock runs; undefined for a child with no clock. */
	dueAt(childId: string): number | undefined {
		return this.#dueAt.get(childId)?.at;
	}

	/**
	 * Watch one dispatch until its run settles or is cancelled. A non-positive
	 * due-by arms nothing. Timers count on the monotonic clock, so a wall-clock
	 * step neither advances nor delays them.
	 */
	arm(input: SubagentDispatchInput, run: SubagentRunWatch): void {
		let done = false;
		const own = new Set<NodeJS.Timeout>();
		const due = { at: input.dispatchedAt + input.dueMs };
		const disarm = () => {
			if (done) return;
			done = true;
			for (const timer of own) {
				clearTimeout(timer);
				this.#timers.delete(timer);
			}
			own.clear();
			if (this.#dueAt.get(input.childId) === due) this.#dueAt.delete(input.childId);
			this.#origins.delete(input.childId);
			run.signal.removeEventListener("abort", disarm);
		};
		// Observed whether or not the clock arms: a rejection here must never
		// reach the host as unhandled.
		run.settled.then(disarm, disarm);
		if (!(input.dueMs > 0) || run.signal.aborted) {
			disarm();
			return;
		}
		run.signal.addEventListener("abort", disarm, { once: true });
		this.#dueAt.set(input.childId, due);
		const dispatch = this.#record(input);
		// Pin the owner's dispatch entry before any transition can move it, so a
		// full fork (which changes the session id) still resolves against it.
		this.#pinOwner(dispatch.owner);
		const start = performance.now() - Math.max(0, Date.now() - input.dispatchedAt);
		let ownerQueued = false;
		const at = (offsetMs: number, fire: () => void): void => {
			const delay = start + offsetMs - performance.now();
			const timer = setTimeout(
				() => {
					own.delete(timer);
					this.#timers.delete(timer);
					if (done) return;
					if (delay > MAX_TIMER_MS) at(offsetMs, fire);
					else fire();
				},
				Math.min(Math.max(0, delay), MAX_TIMER_MS),
			);
			timer.unref();
			own.add(timer);
			this.#timers.add(timer);
		};
		const isSettled = () => done;
		at(dispatch.dueMs, () => {
			void this.#tellOwner(dispatch, isSettled).then(
				queued => {
					if (queued) ownerQueued = true;
				},
				() => {},
			);
		});
		at(2 * dispatch.dueMs, () => {
			void this.#escalate(dispatch, () => ownerQueued, isSettled).catch(() => {});
		});
	}

	/** Clear every pending timer and recorded dispatch. */
	dispose(): void {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		this.#dueAt.clear();
		this.#origins.clear();
	}

	/** Build the owner and ancestor addresses for one dispatch, and record its origin. */
	#record(input: SubagentDispatchInput): SubagentDispatch {
		const ownerSession = this.#registry.get(input.ownerId)?.session;
		const owner: DispatchAnchor = {
			id: input.ownerId,
			toolCallId: input.toolCallId,
			entryId: ownerSession?.sessionManager.getLeafId() ?? null,
		};
		// Usually the dispatching call is already the conversation's last word, so
		// this advances the address onto it before anything can move it.
		if (ownerSession) this.#owns(ownerSession, owner);
		// A dispatch made by this child later addresses its escalation to this owner.
		this.#origins.set(input.childId, owner);
		const ancestors: DispatchAnchor[] = [];
		const seen = new Set<string>([input.childId, input.ownerId]);
		let cur = input.ownerId;
		for (;;) {
			// The precise address recorded when this ancestor dispatched the agent below it.
			const origin = this.#origins.get(cur);
			if (origin && !seen.has(origin.id)) {
				ancestors.push(origin);
				seen.add(origin.id);
				cur = origin.id;
				continue;
			}
			// No recorded dispatch (a Vibe worker's parent, a restored ancestor): the
			// conversation it held when the work was dispatched, by its leaf entry.
			const parentId = this.#registry.get(cur)?.parentId;
			if (parentId !== undefined && !seen.has(parentId)) {
				ancestors.push(this.#leafAnchor(parentId));
				seen.add(parentId);
				cur = parentId;
				continue;
			}
			break;
		}
		return {
			childId: input.childId,
			owner,
			ancestors,
			main: this.#leafAnchor(MAIN_AGENT_ID),
			agent: input.agent,
			dispatchedAt: input.dispatchedAt,
			dueMs: input.dueMs,
			stated: input.stated,
		};
	}

	/** Address a recipient by the leaf its conversation held now; no dispatching tool call. */
	#leafAnchor(id: string): DispatchAnchor {
		const session = this.#registry.get(id)?.session;
		return { id, toolCallId: undefined, entryId: session?.sessionManager.getLeafId() ?? null };
	}

	/**
	 * Advance the owner's address onto its dispatching call once the turn that
	 * made it has persisted. The due-by fires far later, so this always finishes
	 * first; a dispatch whose call never lands (a speculative launch the turn
	 * abandoned) keeps the dispatch-time leaf as its address.
	 */
	#pinOwner(anchor: DispatchAnchor): void {
		if (anchor.toolCallId === undefined || anchor.entryId === null) return;
		const session = this.#registry.get(anchor.id)?.session;
		if (!session) return;
		void session.settlePendingMessagePersistence().then(() => {
			if (this.#registry.get(anchor.id)?.session === session) this.#owns(session, anchor);
		}, () => {});
	}

	/**
	 * Whether `session`'s live conversation still holds the address `anchor`
	 * names, advancing it from the dispatch-time leaf onto the dispatching call
	 * as soon as that branch carries it. The leaf is checked first: a tool call
	 * id alone can repeat across transcripts, and only the conversation that
	 * dispatched holds the entry it dispatched from.
	 */
	#owns(session: AgentSession, anchor: DispatchAnchor): boolean {
		if (anchor.entryId === null) return false;
		if (findDispatchEntry(session, undefined, anchor.entryId) === null) return false;
		if (anchor.toolCallId !== undefined) {
			const call = findDispatchEntry(session, anchor.toolCallId, null);
			if (call !== null) {
				anchor.entryId = call;
				anchor.toolCallId = undefined;
			}
		}
		return true;
	}

	/**
	 * The live session that holds `anchor` now, without waiting: a session
	 * mid-transition counts as not holding (its branch is between states).
	 */
	#reachSync(anchor: DispatchAnchor): AgentSession | undefined {
		const session = this.#registry.get(anchor.id)?.session;
		if (!session || session.isSessionTransitioning) return undefined;
		return this.#owns(session, anchor) ? session : undefined;
	}

	/**
	 * The live session that holds `anchor`, waiting out any transition first so a
	 * fork that spans the due-by still delivers once it settles. Undefined when
	 * no live session holds it.
	 */
	async #resolveReach(anchor: DispatchAnchor): Promise<AgentSession | undefined> {
		for (let i = 0; i < MAX_TRANSITION_WAITS; i++) {
			const session = this.#registry.get(anchor.id)?.session;
			if (!session) return undefined;
			if (session.isSessionTransitioning) {
				await session.waitForSessionTransition();
				continue;
			}
			return this.#owns(session, anchor) ? session : undefined;
		}
		return undefined;
	}

	/** Queue `text` for `session`, the live session of `anchor`, dropped once it goes stale. */
	#notify(
		session: AgentSession,
		anchor: DispatchAnchor,
		entry: Pick<SubagentOverdueEntry, "childId" | "stage" | "text">,
		isSettled: () => boolean,
	): void {
		session.notifySubagentOverdue({
			...entry,
			// Read later, from the queue: a conversation that no longer holds the address must not read it.
			isStale: () => isSettled() || this.#reachSync(anchor) !== session,
		});
	}

	#childView(dispatch: SubagentDispatch, now: number): Record<string, unknown> {
		const child = this.#registry.get(dispatch.childId);
		return {
			childId: dispatch.childId,
			agent: dispatch.agent,
			ownerId: dispatch.owner.id,
			stated: dispatch.stated,
			dispatchedAt: isoMinute(dispatch.dispatchedAt),
			dueIn: formatDuration(dispatch.dueMs),
			dueAt: isoMinute(dispatch.dispatchedAt + dispatch.dueMs),
			activeAgo: child ? formatDuration(Math.max(1_000, now - child.lastActivity)) : undefined,
			activity: child?.activity,
		};
	}

	/** Returns whether a notice was queued for a live owner session (queued, not read). */
	async #tellOwner(dispatch: SubagentDispatch, isSettled: () => boolean): Promise<boolean> {
		const owner = await this.#resolveReach(dispatch.owner);
		if (!owner || isSettled()) {
			if (!owner) {
				logger.debug("Subagent due-by passed with no live owner", {
					childId: dispatch.childId,
					ownerId: dispatch.owner.id,
				});
			}
			return false;
		}
		const text = prompt.render(ownerTemplate, {
			...this.#childView(dispatch, Date.now()),
			escalateAt: isoMinute(dispatch.dispatchedAt + 2 * dispatch.dueMs),
			// Who the escalation would reach if it fired now: the same walk #escalate makes.
			hasAncestors: dispatch.ancestors.length > 0,
			escalateTo: dispatch.ancestors.find(ancestor => this.#reachSync(ancestor))?.id,
		});
		this.#notify(owner, dispatch.owner, { childId: dispatch.childId, stage: "owner", text }, isSettled);
		return true;
	}

	#escalationText(dispatch: SubagentDispatch, ownerQueued: boolean): string {
		const now = Date.now();
		return prompt.render(escalationTemplate, {
			...this.#childView(dispatch, now),
			ownerBlocked:
				!!this.#reachSync(dispatch.owner) && this.#registry.awaits.blocksOn(dispatch.owner.id, dispatch.childId, now),
			ownerQueued,
		});
	}

	async #escalate(dispatch: SubagentDispatch, ownerQueued: () => boolean, isSettled: () => boolean): Promise<void> {
		if (isSettled()) return;
		// The owner's owner is the nearest live agent above the owner; its model is told.
		for (const ancestor of dispatch.ancestors) {
			const session = await this.#resolveReach(ancestor);
			if (isSettled()) return;
			if (!session) continue;
			this.#notify(
				session,
				ancestor,
				{ childId: dispatch.childId, stage: "escalation", text: this.#escalationText(dispatch, ownerQueued()) },
				isSettled,
			);
			return;
		}
		// No live ancestor: the person at the UI is warned. With dispatchers above
		// the owner, that is the main session (while it holds the dispatch-time
		// conversation); a mid-transition main is passed over for the owner's own
		// UI rather than warned into a transcript it has not committed to.
		if (dispatch.ancestors.length > 0) {
			const session = this.#reachSync(dispatch.main) ?? this.#reachSync(dispatch.owner);
			if (session) session.emitNotice("warning", this.#escalationText(dispatch, ownerQueued()), SUBAGENT_OVERDUE_MESSAGE_TYPE);
			else {
				logger.debug("Subagent escalation reached no live ancestor or main session", {
					childId: dispatch.childId,
					ownerId: dispatch.owner.id,
				});
			}
			return;
		}
		// Top-level owner: the person at its own UI, waited out through a transition
		// so a fork spanning the escalation still surfaces the warning.
		const owner = await this.#resolveReach(dispatch.owner);
		if (isSettled()) return;
		if (owner) owner.emitNotice("warning", this.#escalationText(dispatch, ownerQueued()), SUBAGENT_OVERDUE_MESSAGE_TYPE);
		else {
			logger.debug("Subagent escalation reached no live owner UI", {
				childId: dispatch.childId,
				ownerId: dispatch.owner.id,
			});
		}
	}
}
