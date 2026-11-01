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
 * A notice is addressed to the conversation that dispatched the work, not to
 * whatever holds the dispatcher's id later: each recipient is recorded at
 * dispatch as its id, its ref's identity token and its conversation token, and
 * is told only while all three still match.
 */
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { formatDuration, logger, prompt } from "@oh-my-pi/pi-utils";
import escalationTemplate from "../prompts/tools/subagent-overdue-escalation.md" with { type: "text" };
import ownerTemplate from "../prompts/tools/subagent-overdue.md" with { type: "text" };
import type { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
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

/**
 * A registry id, the lifetime token of the ref that held it at dispatch, and
 * the conversation that ref's session held then. An id is a name, not an
 * identity: a ref registered later under the same id carries a different
 * identity token and is refused. A session that replaced its conversation
 * since (`/new`, a switch to another transcript) carries a different
 * conversation token and is refused too. A revival or a fork keeps both.
 */
export interface DispatchIdentity {
	id: string;
	/** Absent when no ref held the id at dispatch; such an identity matches no ref. */
	identityToken?: string;
	/** Absent when no ref held the id at dispatch. */
	conversationToken?: string;
}

/** One dispatch the clock watches. */
export interface SubagentDispatch {
	/** Registry id of the dispatched subagent. */
	childId: string;
	/** The agent that dispatched it. */
	owner: DispatchIdentity;
	/** The owner's own dispatchers, nearest first, read from the registry at dispatch. */
	ancestors: readonly DispatchIdentity[];
	/** The main session as it was at dispatch: the person at its UI is told when no ancestor is live. */
	main: DispatchIdentity;
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

function identityOf(registry: AgentRegistry, id: string): DispatchIdentity {
	const ref = registry.get(id);
	return { id, identityToken: ref?.identityToken, conversationToken: ref?.conversationToken };
}

/** The owner, its dispatchers nearest first, and the main session, as the registry holds them now. */
export function dispatchChain(
	registry: AgentRegistry,
	ownerId: string,
): Pick<SubagentDispatch, "owner" | "ancestors" | "main"> {
	const ancestors: DispatchIdentity[] = [];
	const seen = new Set<string>([ownerId]);
	for (let id = registry.get(ownerId)?.parentId; id !== undefined && !seen.has(id);) {
		seen.add(id);
		const ref = registry.get(id);
		if (!ref) break;
		ancestors.push({ id, identityToken: ref.identityToken, conversationToken: ref.conversationToken });
		id = ref.parentId;
	}
	return { owner: identityOf(registry, ownerId), ancestors, main: identityOf(registry, MAIN_AGENT_ID) };
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
	arm(dispatch: SubagentDispatch, run: SubagentRunWatch): void {
		let done = false;
		const own = new Set<NodeJS.Timeout>();
		const due = { at: dispatch.dispatchedAt + dispatch.dueMs };
		const disarm = () => {
			if (done) return;
			done = true;
			for (const timer of own) {
				clearTimeout(timer);
				this.#timers.delete(timer);
			}
			own.clear();
			if (this.#dueAt.get(dispatch.childId) === due) this.#dueAt.delete(dispatch.childId);
			run.signal.removeEventListener("abort", disarm);
		};
		// Observed whether or not the clock arms: a rejection here must never
		// reach the host as unhandled.
		run.settled.then(disarm, disarm);
		if (!(dispatch.dueMs > 0) || run.signal.aborted) {
			disarm();
			return;
		}
		run.signal.addEventListener("abort", disarm, { once: true });
		this.#dueAt.set(dispatch.childId, due);
		const start = performance.now() - Math.max(0, Date.now() - dispatch.dispatchedAt);
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
			ownerQueued = this.#tellOwner(dispatch, isSettled);
		});
		at(2 * dispatch.dueMs, () => {
			this.#escalate(dispatch, ownerQueued, isSettled);
		});
	}

	/** Clear every pending timer. */
	dispose(): void {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		this.#dueAt.clear();
	}

	/**
	 * The live session of the ref recorded at dispatch, while it still holds the
	 * conversation recorded then; never a later ref that reuses the id, and never
	 * a conversation the session started since.
	 */
	#session(identity: DispatchIdentity): AgentSession | undefined {
		const ref = this.#registry.get(identity.id);
		if (!ref || ref.identityToken !== identity.identityToken) return undefined;
		return ref.conversationToken === identity.conversationToken ? (ref.session ?? undefined) : undefined;
	}

	/** Queue `text` for `session`, the live session of `identity`, dropped once it goes stale. */
	#notify(
		session: AgentSession,
		identity: DispatchIdentity,
		entry: Pick<SubagentOverdueEntry, "childId" | "stage" | "text">,
		isSettled: () => boolean,
	): void {
		session.notifySubagentOverdue({
			...entry,
			// Read later, from the queue: a conversation replaced meanwhile must not read it.
			isStale: () => isSettled() || this.#session(identity) !== session,
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
	#tellOwner(dispatch: SubagentDispatch, isSettled: () => boolean): boolean {
		const owner = this.#session(dispatch.owner);
		if (!owner) {
			logger.debug("Subagent due-by passed with no live owner", {
				childId: dispatch.childId,
				ownerId: dispatch.owner.id,
			});
			return false;
		}
		const text = prompt.render(ownerTemplate, {
			...this.#childView(dispatch, Date.now()),
			escalateAt: isoMinute(dispatch.dispatchedAt + 2 * dispatch.dueMs),
			// Who the escalation would reach if it fired now: the same walk #escalate makes.
			hasAncestors: dispatch.ancestors.length > 0,
			escalateTo: dispatch.ancestors.find(ancestor => this.#session(ancestor))?.id,
		});
		this.#notify(owner, dispatch.owner, { childId: dispatch.childId, stage: "owner", text }, isSettled);
		return true;
	}

	#escalate(dispatch: SubagentDispatch, ownerQueued: boolean, isSettled: () => boolean): void {
		const now = Date.now();
		const owner = this.#session(dispatch.owner);
		const text = prompt.render(escalationTemplate, {
			...this.#childView(dispatch, now),
			ownerBlocked: !!owner && this.#registry.awaits.blocksOn(dispatch.owner.id, dispatch.childId, now),
			ownerQueued,
		});
		// The owner's owner is the nearest live agent above the owner; past the
		// top-level session it is the person at that session's UI.
		for (const ancestor of dispatch.ancestors) {
			const session = this.#session(ancestor);
			if (!session) continue;
			this.#notify(session, ancestor, { childId: dispatch.childId, stage: "escalation", text }, isSettled);
			return;
		}
		// No live ancestor: the person at the main session's UI, or at the owner's own when it is the top.
		const session = (dispatch.ancestors.length > 0 ? this.#session(dispatch.main) : undefined) ?? owner;
		session?.emitNotice("warning", text, SUBAGENT_OVERDUE_MESSAGE_TYPE);
	}
}
