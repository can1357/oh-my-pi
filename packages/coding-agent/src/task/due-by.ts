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
 * Invariant (one rule and one life, covering every identity edge). A notice
 * is a state machine this clock owns from arming to a single end: armed,
 * then due, then addressed to a conversation, then queued for it, then
 * delivered, lost, or overtaken by the child settling. Exactly one end, and
 * one bound ({@link NOTICE_DEADLINE_MS}) covers every phase after "due", the
 * queued wait included. "Delivered" means a model request that carries the
 * notice was handed to the provider: whether the notice is still live is
 * decided at that hand-off, in the same synchronous step that marks it
 * delivered, so a notice that went stale while queued, built or prepared is
 * never also read. Every end that is neither a delivery nor the child
 * settling goes through this clock's one loss path, as a single warning, and
 * every warning for the person (a loss, or an escalation the person
 * receives) goes through the registry's one person channel, which reaches
 * the person's window whatever it shows, from any agent of the tree. The
 * queue reports a notice it dropped back to the clock rather than
 * discarding it, so nothing ends silently.
 *
 * A notice addressed to a dispatch is delivered to a session if and only if
 * that session's live conversation — the entries on its current branch, from
 * the leaf back to the nearest context-reset boundary — still holds the entry
 * the address is anchored to: this dispatch's own dispatching tool call once
 * the transcript carries it, and until then (a child launched while its call
 * still streams, an ancestor the clock recorded no dispatch for) the leaf the
 * recipient was at when the work was dispatched. The address advances from
 * that leaf to the call and never back, and the call it accepts is this
 * dispatch's occurrence of the id — the very call the owner is executing at
 * arming, or, for a call still streaming then, the first one written below
 * the leaf afterwards — never an older turn or step that reused the id. A
 * transition is neither a yes nor a no: a delivery waits for it to settle and
 * re-checks, and a notice already queued is held rather than dropped, both
 * inside that one bound. This replaces the earlier identity and conversation
 * tokens: a full fork keeps the entry (still owns it), returning to a
 * navigated-away leaf restores it, a `/new`/switch/branch drops it, and a
 * transcript the dispatch never reached (a worker revived onto a different
 * transcript than the one it dispatched from, a replacement under a reused
 * id) does not hold it, so none of them can be misdelivered to.
 */
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { formatDuration, logger, prompt } from "@oh-my-pi/pi-utils";
import escalationTemplate from "../prompts/tools/subagent-overdue-escalation.md" with { type: "text" };
import lostTemplate from "../prompts/tools/subagent-overdue-lost.md" with { type: "text" };
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
 * The one bound on a notice, from its deadline to its end: resolving an
 * address, waiting out a session transition, and sitting unread in a
 * recipient's queue all spend it. A transition is a local transcript operation
 * measured in milliseconds and a queued notice is read at the next step
 * boundary, so a notice still unread after this is stuck; it is surfaced as a
 * loss rather than held out of sight or dropped into a conversation that has
 * not settled.
 */
export const NOTICE_DEADLINE_MS = 10_000;

/** The same bound, as the loss warning words it. */
const NOTICE_DEADLINE_LABEL = "10 seconds";

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
	/**
	 * Launched while the dispatching call still streams: the transcript does
	 * not carry this dispatch's call yet, so any occurrence of the id already in
	 * it belongs to an earlier dispatch.
	 */
	speculative: boolean;
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
 * Whether `entryId` is on `session`'s live conversation: its current branch,
 * from the leaf back to the nearest context reset. A `/clear` boundary ends the
 * conversation, so entries before the reset no longer count as held.
 */
function onLiveBranch(session: AgentSession, entryId: string): boolean {
	const branch: readonly SessionEntry[] = session.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "reset_boundary") return false;
		if (entry.id === entryId) return true;
	}
	return false;
}

/**
 * The entry carrying this dispatch's own occurrence of `toolCallId`, found by
 * the occurrence rather than by the id alone: a session reuses a tool call id
 * across turns and even across the steps of one run, so a match by id can be
 * an older dispatch that finished long ago.
 *
 * At arming (`current` given) the dispatch's call is the one the owner's
 * agent is executing: the latest assistant message of its live state that
 * carries the id. Only the transcript entry holding that same message (by its
 * timestamp) at or above `leafId` is accepted, so neither an older turn nor
 * an earlier step that reused the id can stand in for it. Afterwards
 * (`current` null) the only occurrence this dispatch can still own is one
 * written under that leaf — a child launched while its call was still
 * streaming, or a call whose entry was not yet written at arming — so the
 * search covers the leaf's descendants and nothing else. Null when the
 * transcript carries no such occurrence.
 */
function findDispatchCall(
	session: AgentSession,
	leafId: string,
	toolCallId: string,
	current: AssistantMessage | null,
): string | null {
	const manager = session.sessionManager;
	if (current) {
		const path: readonly SessionEntry[] = manager.getBranch(leafId);
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i]!;
			if (entry.type === "reset_boundary") return null;
			if (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.timestamp === current.timestamp &&
				hasToolCall(entry.message, toolCallId)
			) {
				return entry.id;
			}
		}
		return null;
	}
	// The earliest occurrence written under the leaf is this dispatch's: a later
	// turn on any branch below it that reused the id was written after it.
	const entries = manager.getEntries();
	const start = entries.findIndex(entry => entry.id === leafId);
	if (start < 0) return null;
	for (let i = start + 1; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant" || !hasToolCall(entry.message, toolCallId)) {
			continue;
		}
		if (descendsFrom(session, entry, leafId)) return entry.id;
	}
	return null;
}

/** Whether `entry` lies under `ancestorId` in the same conversation: no context reset between them. */
function descendsFrom(session: AgentSession, entry: SessionEntry, ancestorId: string): boolean {
	let parentId = entry.parentId;
	while (parentId !== null) {
		if (parentId === ancestorId) return true;
		const parent = session.sessionManager.getEntry(parentId);
		if (!parent || parent.type === "reset_boundary") return false;
		parentId = parent.parentId;
	}
	return false;
}

/** Whether `session`'s transitions settled within `ms`; a stuck one can never block a delivery. */
async function settlesWithin(session: AgentSession, ms: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), ms);
	timer.unref();
	try {
		return await Promise.race([session.waitForSessionTransition().then(() => true), promise]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * How one notice ended. `settled` is the child finishing or being cancelled
 * before anyone read its notice: nobody needs telling about work that is over,
 * so that end alone is silent.
 */
type NoticeEnd = "delivered" | "lost" | "settled";

/**
 * Why a notice reached nobody, as the person is told: the conversation that
 * dispatched the work is gone; no request carrying it reached a model within
 * the bound; or no request carrying it was sent at all (a callback or a
 * transform took it out, or the turn stopped or failed first).
 */
type LossCause = "gone" | "stuck" | "unsent";

/**
 * One notice's life from its deadline to its single end: due, then addressed
 * to a conversation, then queued for it, then delivered, lost, or overtaken by
 * the child settling. One bound covers every phase after "due", the queued
 * wait included, and every end that is neither a delivery nor the child
 * settling is surfaced to the person.
 */
class PendingNotice {
	#end: NoticeEnd | undefined;
	readonly #deadlineAt = performance.now() + NOTICE_DEADLINE_MS;
	readonly #timer: NodeJS.Timeout;

	constructor(private readonly settle: (end: NoticeEnd, cause: LossCause) => void) {
		this.#timer = setTimeout(() => this.end("lost", "stuck"), NOTICE_DEADLINE_MS);
		this.#timer.unref();
	}

	/** True once this notice has ended; an entry still queued then is dropped unread. */
	get ended(): boolean {
		return this.#end !== undefined;
	}

	/** What is left of the one bound, for whichever phase waits next. */
	get msLeft(): number {
		return this.#deadlineAt - performance.now();
	}

	/** End this notice. The first end wins; later ones are the same end reported twice. */
	end(end: NoticeEnd, cause: LossCause = "gone"): void {
		if (this.#end !== undefined) return;
		this.#end = end;
		clearTimeout(this.#timer);
		this.settle(end, cause);
	}
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
		/** The notices of this dispatch that have still to end. */
		const live = new Set<PendingNotice>();
		const due = { at: input.dispatchedAt + input.dueMs };
		const disarm = () => {
			if (done) return;
			done = true;
			for (const timer of own) {
				clearTimeout(timer);
				this.#timers.delete(timer);
			}
			own.clear();
			// The child is over: a notice still unread ends silently rather than
			// telling anyone about work that has finished.
			for (const notice of live) notice.end("settled");
			live.clear();
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
		const track = (stage: "owner" | "escalation"): PendingNotice => {
			const notice: PendingNotice = new PendingNotice((end, cause) => {
				live.delete(notice);
				if (end === "lost") this.#surfaceLoss(dispatch, stage, cause);
			});
			live.add(notice);
			return notice;
		};
		at(dispatch.dueMs, () => {
			const notice = track("owner");
			void this.#tellOwner(dispatch, notice, isSettled).then(
				queued => {
					if (queued) ownerQueued = true;
				},
				() => notice.end("lost", "unsent"),
			);
		});
		at(2 * dispatch.dueMs, () => {
			const notice = track("escalation");
			void this.#escalate(dispatch, notice, () => ownerQueued, isSettled).catch(() => notice.end("lost", "unsent"));
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
		const leafId = ownerSession?.sessionManager.getLeafId() ?? null;
		const owner: DispatchAnchor = { id: input.ownerId, toolCallId: input.toolCallId, entryId: leafId };
		// A committed dispatch's call is normally already written: pin that very
		// occurrence now, before a later turn can reuse the id. A speculative one
		// is still streaming, so nothing written yet is its call; it advances
		// onto the call once that is written below the leaf.
		if (ownerSession && leafId !== null && !input.speculative) {
			const current = ownerSession.agent.state.messages.findLast(
				(message): message is AssistantMessage =>
					message.role === "assistant" && hasToolCall(message, input.toolCallId),
			);
			const call = current ? findDispatchCall(ownerSession, leafId, input.toolCallId, current) : null;
			if (call !== null) {
				owner.entryId = call;
				owner.toolCallId = undefined;
			}
		}
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
	 * Whether `session`'s live conversation still holds the address `anchor`
	 * names, advancing it from the dispatch-time leaf onto this dispatch's own
	 * call as soon as the transcript carries it. The leaf stands in only while
	 * that call is unwritten, only on the transcript the leaf came from, and
	 * only a call written below the leaf can claim it: an id the session used
	 * in an earlier turn names an older dispatch, never this one.
	 */
	#owns(session: AgentSession, anchor: DispatchAnchor): boolean {
		if (anchor.entryId === null) return false;
		if (anchor.toolCallId !== undefined) {
			if (session.sessionManager.getEntry(anchor.entryId) === undefined) return false;
			const call = findDispatchCall(session, anchor.entryId, anchor.toolCallId, null);
			if (call !== null) {
				anchor.entryId = call;
				anchor.toolCallId = undefined;
			}
		}
		return onLiveBranch(session, anchor.entryId);
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
	 * The live session that holds `anchor`, waiting out any transition first so
	 * a fork that spans the due-by still delivers once it settles. The wait
	 * spends `notice`'s one bound, so a transition that never settles leaves
	 * the notice undeliverable rather than held for ever. Undefined when no
	 * live session holds it.
	 */
	async #resolveReach(anchor: DispatchAnchor, notice: PendingNotice): Promise<AgentSession | undefined> {
		for (let i = 0; i < MAX_TRANSITION_WAITS; i++) {
			if (notice.ended) return undefined;
			const session = this.#registry.get(anchor.id)?.session;
			if (!session) return undefined;
			if (!session.isSessionTransitioning) return this.#owns(session, anchor) ? session : undefined;
			const left = notice.msLeft;
			if (left <= 0 || !(await settlesWithin(session, left))) return undefined;
		}
		return undefined;
	}

	/**
	 * Queue `text` for `session`, the live session of `anchor`, and let the
	 * queue answer back: its receipt resolves when a model request carrying the
	 * notice is handed to the provider and rejects when no such request was
	 * sent, so the notice ends either way and no end is silent.
	 */
	#queue(
		session: AgentSession,
		anchor: DispatchAnchor,
		notice: PendingNotice,
		entry: Pick<SubagentOverdueEntry, "childId" | "stage" | "text">,
		isSettled: () => boolean,
	): void {
		const receipt = session.notifySubagentOverdue({
			...entry,
			// Asked when the queue builds the notice and again at the hand-off of
			// the request that carries it, immediately before that request is sent:
			// a conversation that no longer holds the address must not read it, and
			// a notice past its bound must not be read at all. The bound is read
			// from the monotonic clock here, not from whether its timer has run: a
			// blocked event loop can hold that timer past the bound. A session
			// mid-transition is held back by the queue before this is asked, so a
			// passing transition never makes a queued notice stale.
			isStale: () => notice.ended || notice.msLeft <= 0 || isSettled() || this.#reachSync(anchor) !== session,
		});
		void Promise.resolve(receipt).then(
			() => notice.end("delivered"),
			() => {
				if (isSettled()) return notice.end("settled");
				if (notice.msLeft <= 0) return notice.end("lost", "stuck");
				notice.end("lost", this.#reachSync(anchor) === session ? "unsent" : "gone");
			},
		);
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

	/**
	 * Tell the person that a notice reached nobody. A warning is UI only: it
	 * enters no transcript and no model context, so it goes to the person's
	 * window whatever that window shows — putting the notice itself into
	 * another conversation is the misdelivery this clock refuses. With no
	 * window, the main session's subscribers stand in for the person, then the
	 * owner's; with none of them there is no one to tell, and the loss is
	 * logged.
	 */
	#surfaceLoss(dispatch: SubagentDispatch, stage: "owner" | "escalation", cause: LossCause): void {
		const host = this.#registry.get(MAIN_AGENT_ID)?.session ?? this.#registry.get(dispatch.owner.id)?.session;
		const text = prompt.render(lostTemplate, {
			...this.#childView(dispatch, Date.now()),
			escalation: stage === "escalation",
			stuck: cause === "stuck",
			unsent: cause === "unsent",
			settleWait: NOTICE_DEADLINE_LABEL,
		});
		if (
			this.#registry.notifyPerson({ level: "warning", message: text, source: SUBAGENT_OVERDUE_MESSAGE_TYPE }, host)
		) {
			return;
		}
		logger.debug("Subagent due-by notice reached nobody", {
			childId: dispatch.childId,
			ownerId: dispatch.owner.id,
			stage,
			cause,
		});
	}

	/** Returns whether a notice was queued for a live owner session (queued, not read). */
	async #tellOwner(dispatch: SubagentDispatch, notice: PendingNotice, isSettled: () => boolean): Promise<boolean> {
		const owner = await this.#resolveReach(dispatch.owner, notice);
		if (isSettled()) {
			notice.end("settled");
			return false;
		}
		if (notice.ended) return false;
		if (!owner) {
			notice.end("lost");
			return false;
		}
		const text = prompt.render(ownerTemplate, {
			...this.#childView(dispatch, Date.now()),
			escalateAt: isoMinute(dispatch.dispatchedAt + 2 * dispatch.dueMs),
			// Who the escalation would reach if it fired now: the same walk #escalate makes.
			hasAncestors: dispatch.ancestors.length > 0,
			escalateTo: dispatch.ancestors.find(ancestor => this.#reachSync(ancestor))?.id,
		});
		this.#queue(owner, dispatch.owner, notice, { childId: dispatch.childId, stage: "owner", text }, isSettled);
		return true;
	}

	#escalationText(dispatch: SubagentDispatch, ownerQueued: boolean): string {
		const now = Date.now();
		return prompt.render(escalationTemplate, {
			...this.#childView(dispatch, now),
			ownerBlocked:
				!!this.#reachSync(dispatch.owner) &&
				this.#registry.awaits.blocksOn(dispatch.owner.id, dispatch.childId, now),
			ownerQueued,
		});
	}

	async #escalate(
		dispatch: SubagentDispatch,
		notice: PendingNotice,
		ownerQueued: () => boolean,
		isSettled: () => boolean,
	): Promise<void> {
		if (isSettled()) return notice.end("settled");
		// The owner's owner is the nearest live agent above the owner; its model is told.
		for (const ancestor of dispatch.ancestors) {
			const session = await this.#resolveReach(ancestor, notice);
			if (isSettled()) return notice.end("settled");
			if (notice.ended) return;
			if (!session) continue;
			this.#queue(
				session,
				ancestor,
				notice,
				{ childId: dispatch.childId, stage: "escalation", text: this.#escalationText(dispatch, ownerQueued()) },
				isSettled,
			);
			return;
		}
		// No live ancestor: the person is told, at their window whatever it shows,
		// which ends the notice as delivered — the person is the recipient. With
		// no window, a session's subscribers stand in for the person: with
		// dispatchers above the owner, the main session (while it holds the
		// dispatch-time conversation), else the owner's own; a mid-transition main
		// is passed over rather than told on a transcript it has not committed to.
		if (dispatch.ancestors.length > 0) {
			const host = this.#reachSync(dispatch.main) ?? this.#reachSync(dispatch.owner);
			if (!host) return notice.end("lost");
			return this.#tellPerson(dispatch, notice, ownerQueued(), host);
		}
		// Top-level owner: the person above it, waited out through a transition
		// so a fork spanning the escalation still surfaces the warning.
		const owner = await this.#resolveReach(dispatch.owner, notice);
		if (isSettled()) return notice.end("settled");
		if (notice.ended) return;
		if (!owner) return notice.end("lost");
		return this.#tellPerson(dispatch, notice, ownerQueued(), owner);
	}

	/** Escalate to the person through the one person channel; `host` stands in for a window that is absent. */
	#tellPerson(dispatch: SubagentDispatch, notice: PendingNotice, ownerQueued: boolean, host: AgentSession): void {
		if (notice.msLeft <= 0) return notice.end("lost", "stuck");
		const message = this.#escalationText(dispatch, ownerQueued);
		const told = this.#registry.notifyPerson(
			{ level: "warning", message, source: SUBAGENT_OVERDUE_MESSAGE_TYPE },
			host,
		);
		notice.end(told ? "delivered" : "lost");
	}
}
