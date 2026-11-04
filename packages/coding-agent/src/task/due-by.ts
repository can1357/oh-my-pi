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
 *
 * Threads. Subagents may be homed on worker threads, so the clock lives only
 * on the main thread's registry and never reads a transcript itself. A
 * dispatch made on a worker arms it over the thread RPC, with the
 * dispatcher's address decided on the dispatcher's own thread
 * (`dispatchAddress`). Every question about a recipient's conversation is a
 * probe the recipient answers on its home thread (`dueByProbe`, which also
 * waits out its own transition inside the bound), and a notice is queued on
 * the recipient's home thread (`notifySubagentOverdue`), where its loop checks
 * the address locally and asks this clock, by a synchronous call that never
 * blocks main, whether the notice is still open, at the hand-off itself.
 */
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { formatDuration, logger, prompt } from "@oh-my-pi/pi-utils";
import escalationTemplate from "../prompts/tools/subagent-overdue-escalation.md" with { type: "text" };
import lostTemplate from "../prompts/tools/subagent-overdue-lost.md" with { type: "text" };
import ownerTemplate from "../prompts/tools/subagent-overdue.md" with { type: "text" };
import type { AgentRegistryApi, PersonNoticeClaim, PersonNoticeHost } from "../registry/agent-registry";
import { type AgentSessionHandle, isLocalAgentSession } from "../session/agent-session-handle";
import type { CustomMessage } from "../session/messages";
import { rpcSync } from "../thread/rpc";
import type { DueByAddress } from "./due-by-address";

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
 * Where a notice is delivered: a conversation addressed by one entry of it
 * (see {@link DueByAddress}), held by the agent registered as `id`. Whether
 * the recipient still holds it is answered by the recipient, on its own
 * thread; the clock only keeps the address it last answered.
 */
export interface DispatchAnchor extends DueByAddress {
	/** Registry id of the recipient this address names. */
	id: string;
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

/** What `arm` is given per dispatch; the clock builds the escalation addresses from it. */
export interface SubagentDispatchInput {
	/** Registry id of the dispatched subagent. */
	childId: string;
	/** Registry id of the agent that dispatched it. */
	ownerId: string;
	/**
	 * The dispatcher's own address for this dispatch, decided on the
	 * dispatcher's thread when it launched the child (`dispatchAddress`).
	 */
	ownerAddress: DueByAddress;
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

/** The due-by clock as every thread sees it: main's instance, or a worker's proxy of it. */
export interface SubagentDueClockApi {
	/** Watch one dispatch until its run settles or is cancelled. */
	arm(input: SubagentDispatchInput, run: SubagentRunWatch): void;
	/** When `childId`'s due-by falls, while its clock runs; undefined for a child with no clock. */
	dueAt(childId: string): number | undefined;
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
 *
 * A recipient's request hand-off holds the notice (`reserve`) for the one
 * synchronous step in which it decides to send it, and ends that hold by
 * `commit` (delivered, before the request goes out) or `release` (not sent).
 * While it is held nothing else ends it: its bound expiring, or the child
 * settling, is applied when the hold is released, and dropped when the hold
 * commits, because the request was then sent while the notice was live. Only
 * a recipient that can no longer answer (its link closed) ends a held notice.
 */
class PendingNotice {
	#end: NoticeEnd | undefined;
	#held = false;
	/** An end that came while held, applied if the hold is released. */
	#deferred: [NoticeEnd, LossCause] | undefined;
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

	/** Whether a request carrying this notice may still be sent: a pure read, for builds and peeks. */
	isOpen(isSettled: () => boolean): boolean {
		return this.#end === undefined && this.#deferred === undefined && this.msLeft > 0 && !isSettled();
	}

	/** At a hand-off: hold the notice if it is still open; false (and ended, when due) otherwise. */
	reserve(isSettled: () => boolean): boolean {
		if (this.#end !== undefined || this.#held) return false;
		if (isSettled()) {
			this.end("settled");
			return false;
		}
		if (this.msLeft <= 0) {
			this.end("lost", "stuck");
			return false;
		}
		this.#held = true;
		return true;
	}

	/** The held request was not sent: the notice is open again, or ends as whatever came meanwhile. */
	release(): void {
		if (!this.#held) return;
		this.#held = false;
		const deferred = this.#deferred;
		this.#deferred = undefined;
		if (deferred) this.end(...deferred);
		else if (this.msLeft <= 0) this.end("lost", "stuck");
	}

	/** The held request is being handed to the provider now: delivered. */
	commit(): void {
		if (!this.#held) return;
		this.#held = false;
		this.#deferred = undefined;
		this.end("delivered");
	}

	/**
	 * End this notice. The first end wins; later ones are the same end reported
	 * twice. While a hand-off holds it, an end waits for that hand-off, unless
	 * `force` says the holder can no longer answer.
	 */
	end(end: NoticeEnd, cause: LossCause = "gone", force = false): void {
		if (this.#end !== undefined) return;
		if (this.#held && !force) {
			this.#deferred ??= [end, cause];
			return;
		}
		this.#held = false;
		this.#deferred = undefined;
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
	/** The child settled, the notice ended, or the recipient no longer holds its address. A pure read. */
	isStale(): boolean;
	/** At the hand-off: hold the notice for this request (see `SubagentOverdueDelivery.reserve`). */
	reserve(): boolean;
	release(): void;
	commit(): void;
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
export function describeDueBy(clock: SubagentDueClockApi, childId: string): string {
	const at = clock.dueAt(childId);
	return at === undefined ? "no due-by" : `due by ${isoMinute(at)}`;
}

/**
 * The due-by clock. It lives only on the main thread's registry; a dispatch
 * made on a worker arms it over the thread RPC, and every recipient answers
 * for its own transcript on its own thread, so a recipient homed anywhere is
 * told the same way.
 */
export class SubagentDueClock implements SubagentDueClockApi {
	readonly #registry: AgentRegistryApi;
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

	constructor(registry: AgentRegistryApi) {
		this.#registry = registry;
	}

	/** When `childId`'s due-by falls, while its clock runs; undefined for a child with no clock. */
	dueAt(childId: string): number | undefined {
		return this.#dueAt.get(childId)?.at;
	}

	/**
	 * Watch one dispatch until its run settles or is cancelled. A non-positive
	 * due-by sets no timers, but the dispatch is still recorded as the origin
	 * of the child's own dispatches, for as long as the child runs. Every
	 * address the dispatch's notices go to is captured here, at the dispatch;
	 * only leaves held on other threads are read in after, from the very
	 * sessions that held them now. Timers count on the monotonic clock, so a
	 * wall-clock step neither advances nor delays them.
	 */
	arm(input: SubagentDispatchInput, run: SubagentRunWatch): void {
		let done = false;
		const own = new Set<NodeJS.Timeout>();
		/** The notices of this dispatch that have still to end. */
		const live = new Set<PendingNotice>();
		const due = { at: input.dispatchedAt + input.dueMs };
		// A dispatch made by this child later addresses its escalation to this owner.
		const owner: DispatchAnchor = { id: input.ownerId, ...input.ownerAddress };
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
			// Only this dispatch's own record: a later dispatch under the same id keeps its own.
			if (this.#origins.get(input.childId) === owner) this.#origins.delete(input.childId);
			run.signal.removeEventListener("abort", disarm);
		};
		// Observed whether or not the clock arms: a rejection here must never
		// reach the host as unhandled.
		run.settled.then(disarm, disarm);
		if (run.signal.aborted) {
			disarm();
			return;
		}
		run.signal.addEventListener("abort", disarm, { once: true });
		this.#origins.set(input.childId, owner);
		if (!(input.dueMs > 0)) return;
		const { dispatch, ready } = this.#record(input, owner);
		this.#dueAt.set(input.childId, due);
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
		// The timers count from the dispatch, whatever the address reads still
		// owe: a slow read is spent from the notice's one bound, never added to it.
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
			void this.#escalate(dispatch, ready, notice, () => ownerQueued, isSettled).catch(() =>
				notice.end("lost", "unsent"),
			);
		});
	}

	/** Clear every pending timer and recorded dispatch. */
	dispose(): void {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		this.#dueAt.clear();
		this.#origins.clear();
	}

	/**
	 * Build the addresses of one dispatch whose owner address is `owner`, all
	 * decided now, at the dispatch: the ancestor chain and its recorded
	 * origins, and the session each leaf is read from. Each leaf is the one
	 * that session held at the dispatch time: read now for a session on this
	 * thread, and in after from that same session (a session that replaces it
	 * under the id later is never asked) for one on another thread, which
	 * answers with no leaf when its conversation moved since the dispatch.
	 * `ready` resolves once those reads land; until then an unread anchor
	 * names no conversation.
	 */
	#record(input: SubagentDispatchInput, owner: DispatchAnchor): { dispatch: SubagentDispatch; ready: Promise<void> } {
		const reads: Promise<void>[] = [];
		const leafAnchor = (id: string): DispatchAnchor => {
			const anchor: DispatchAnchor = { id, toolCallId: undefined, entryId: null };
			const session = this.#registry.get(id)?.session;
			if (!session) return anchor;
			if (isLocalAgentSession(session)) {
				anchor.entryId = session.dueByLeafAtNow(input.dispatchedAt);
			} else {
				reads.push(
					session.dueByLeafAt(input.dispatchedAt).then(
						entryId => {
							anchor.entryId = entryId;
						},
						() => {
							// A session whose home went away holds no conversation.
						},
					),
				);
			}
			return anchor;
		};
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
			// conversation it held at the dispatch, by its leaf entry.
			const parentId = this.#registry.get(cur)?.parentId;
			if (parentId !== undefined && !seen.has(parentId)) {
				ancestors.push(leafAnchor(parentId));
				seen.add(parentId);
				cur = parentId;
				continue;
			}
			break;
		}
		const dispatch: SubagentDispatch = {
			childId: input.childId,
			owner,
			ancestors,
			main: leafAnchor(MAIN_AGENT_ID),
			agent: input.agent,
			dispatchedAt: input.dispatchedAt,
			dueMs: input.dueMs,
			stated: input.stated,
		};
		return { dispatch, ready: Promise.all(reads).then(() => undefined) };
	}

	/**
	 * The live session that holds `anchor`, asked on its home thread, which
	 * waits out its own session transition for at most `waitMs` first (so a
	 * fork spanning the due-by still delivers once it settles). A held address
	 * comes back advanced onto its call once that is written, and the anchor
	 * keeps it. Undefined when no live session holds it.
	 */
	async #reach(anchor: DispatchAnchor, waitMs: number): Promise<AgentSessionHandle | undefined> {
		const session = this.#registry.get(anchor.id)?.session;
		if (!session) return undefined;
		try {
			const probe = await session.dueByProbe({ entryId: anchor.entryId, toolCallId: anchor.toolCallId }, waitMs);
			if (!probe.holds) return undefined;
			anchor.entryId = probe.address.entryId;
			anchor.toolCallId = probe.address.toolCallId;
			return session;
		} catch {
			// A session whose home went away holds nothing.
			return undefined;
		}
	}

	/** {@link #reach}, spending what is left of `notice`'s one bound on the wait. */
	async #resolveReach(anchor: DispatchAnchor, notice: PendingNotice): Promise<AgentSessionHandle | undefined> {
		if (notice.ended || notice.msLeft <= 0) return undefined;
		const session = await this.#reach(anchor, notice.msLeft);
		return notice.ended ? undefined : session;
	}

	/**
	 * The id of the first of `anchors` whose recipient holds it, told without
	 * waiting: undefined as soon as one cannot be told now (its session lives
	 * on another thread, or its read has not landed), since naming a later one
	 * could name the wrong agent.
	 */
	#nearestHoldingNow(anchors: readonly DispatchAnchor[]): string | undefined {
		for (const anchor of anchors) {
			const session = this.#registry.get(anchor.id)?.session;
			if (!session) continue;
			if (!isLocalAgentSession(session)) return undefined;
			if (session.dueByHoldsNow({ entryId: anchor.entryId, toolCallId: anchor.toolCallId })) return anchor.id;
		}
		return undefined;
	}

	/**
	 * Queue `text` for `session`, the live session of `anchor`, and let the
	 * queue answer back. The recipient's hand-off reserves the notice, then
	 * commits it (delivered, before the request goes out) or releases it, all
	 * in one synchronous step of its loop; its receipt then settles too, so the
	 * notice ends either way and no end is silent.
	 */
	#queue(
		session: AgentSessionHandle,
		anchor: DispatchAnchor,
		notice: PendingNotice,
		entry: Pick<SubagentOverdueEntry, "childId" | "stage" | "text">,
		isSettled: () => boolean,
	): void {
		const receipt = session.notifySubagentOverdue({
			...entry,
			// The recipient checks this address against its own live conversation,
			// on its own thread, when its queue builds the notice and again at the
			// hand-off of the request that carries it.
			address: { entryId: anchor.entryId, toolCallId: anchor.toolCallId },
			// The clock's side. The bound is read from the monotonic clock, not from
			// whether its timer has run: a blocked event loop can hold that timer
			// past the bound. From a worker each is a synchronous call to main,
			// which never blocks on a worker, so the hold, the commit and the
			// worker's send are one step on the worker.
			isOpen: rpcSync(() => notice.isOpen(isSettled)),
			reserve: rpcSync(() => notice.reserve(isSettled)),
			release: rpcSync(() => notice.release()),
			commit: rpcSync(() => notice.commit()),
		});
		void Promise.resolve(receipt).then(
			() => notice.end("delivered"),
			async () => {
				// The recipient answered no, or can no longer answer at all (its
				// link closed): either way it holds nothing for this notice now.
				if (isSettled()) return notice.end("settled", "gone", true);
				if (notice.msLeft <= 0) return notice.end("lost", "stuck", true);
				const held = await this.#reach(anchor, 0);
				notice.end("lost", held === session ? "unsent" : "gone", true);
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
	 * owner's; with none of them able to show it there is no one to tell, and
	 * the loss is logged.
	 */
	#surfaceLoss(dispatch: SubagentDispatch, stage: "owner" | "escalation", cause: LossCause): void {
		const text = prompt.render(lostTemplate, {
			...this.#childView(dispatch, Date.now()),
			escalation: stage === "escalation",
			stuck: cause === "stuck",
			unsent: cause === "unsent",
			settleWait: NOTICE_DEADLINE_LABEL,
		});
		const hosts = [this.#host({ id: MAIN_AGENT_ID }), this.#host({ id: dispatch.owner.id })].filter(
			(host): host is PersonNoticeHost => host !== undefined,
		);
		void this.#registry
			.notifyPerson({ level: "warning", message: text, source: SUBAGENT_OVERDUE_MESSAGE_TYPE }, hosts)
			.then(
				told => {
					if (told) return;
					logger.debug("Subagent due-by notice reached nobody", {
						childId: dispatch.childId,
						ownerId: dispatch.owner.id,
						stage,
						cause,
					});
				},
				error => logger.warn("Subagent due-by loss warning failed", { error: String(error) }),
			);
	}

	/**
	 * The session registered as `anchor.id` now, as a stand-in for the person
	 * that must still hold `anchor`'s conversation when it names one.
	 */
	#host(anchor: { id: string; entryId?: string | null; toolCallId?: string }): PersonNoticeHost | undefined {
		const session = this.#registry.get(anchor.id)?.session;
		if (!session) return undefined;
		if (anchor.entryId === undefined) return { session };
		return { session, address: { entryId: anchor.entryId, toolCallId: anchor.toolCallId } };
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
		// Who the escalation would reach if it fired now, when that can be told
		// at once: the owner's notice never waits on another agent's thread.
		const escalateTo = this.#nearestHoldingNow(dispatch.ancestors);
		const text = prompt.render(ownerTemplate, {
			...this.#childView(dispatch, Date.now()),
			escalateAt: isoMinute(dispatch.dispatchedAt + 2 * dispatch.dueMs),
			hasAncestors: dispatch.ancestors.length > 0,
			escalateTo,
		});
		this.#queue(owner, dispatch.owner, notice, { childId: dispatch.childId, stage: "owner", text }, isSettled);
		return true;
	}

	async #escalationText(dispatch: SubagentDispatch, ownerQueued: boolean): Promise<string> {
		const ownerHolds = (await this.#reach(dispatch.owner, 0)) !== undefined;
		const now = Date.now();
		return prompt.render(escalationTemplate, {
			...this.#childView(dispatch, now),
			ownerBlocked: ownerHolds && this.#registry.awaits.blocksOn(dispatch.owner.id, dispatch.childId, now),
			ownerQueued,
		});
	}

	async #escalate(
		dispatch: SubagentDispatch,
		ready: Promise<void>,
		notice: PendingNotice,
		ownerQueued: () => boolean,
		isSettled: () => boolean,
	): Promise<void> {
		if (isSettled()) return notice.end("settled");
		// The addresses read from other threads, inside this notice's one bound.
		await this.#within(ready, notice);
		if (isSettled()) return notice.end("settled");
		if (notice.ended) return;
		// The owner's owner is the nearest live agent above the owner; its model is told.
		for (const ancestor of dispatch.ancestors) {
			const session = await this.#resolveReach(ancestor, notice);
			if (isSettled()) return notice.end("settled");
			if (notice.ended) return;
			if (!session) continue;
			const text = await this.#escalationText(dispatch, ownerQueued());
			if (isSettled()) return notice.end("settled");
			if (notice.ended) return;
			this.#queue(session, ancestor, notice, { childId: dispatch.childId, stage: "escalation", text }, isSettled);
			return;
		}
		// No live ancestor: the person is told, at their window whatever it shows,
		// which ends the notice as delivered — the person is the recipient. With
		// no window, a session's subscribers stand in for the person: with
		// dispatchers above the owner, the main session (while it holds the
		// dispatch-time conversation), else the owner's own; a mid-transition main
		// is passed over rather than told on a transcript it has not committed to.
		if (dispatch.ancestors.length > 0) {
			return this.#tellPerson(dispatch, notice, ownerQueued, isSettled, [dispatch.main, dispatch.owner], 0);
		}
		// Top-level owner: the person above it, waited out through a transition
		// so a fork spanning the escalation still surfaces the warning.
		return this.#tellPerson(dispatch, notice, ownerQueued, isSettled, [dispatch.owner], notice.msLeft);
	}

	/** Wait for `promise`, for at most what is left of `notice`'s bound. */
	async #within(promise: Promise<void>, notice: PendingNotice): Promise<void> {
		const left = notice.msLeft;
		if (left <= 0) return;
		const { promise: expired, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, left);
		timer.unref();
		try {
			await Promise.race([promise, expired]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Escalate to the person through the one person channel. The text is
	 * rendered first; then the escalation goes ahead only while one of
	 * `anchors` still holds its conversation (the first may wait out a
	 * transition for `waitMs`), and the show is held by a claim: the thread
	 * that shows it (the window's, or a stand-in session's) reserves the
	 * notice in the same step as the show and commits it right after, so a
	 * notice that ended (its child settled, its bound passed) is never also
	 * shown, and a shown one ends delivered exactly once.
	 */
	async #tellPerson(
		dispatch: SubagentDispatch,
		notice: PendingNotice,
		ownerQueued: () => boolean,
		isSettled: () => boolean,
		anchors: readonly DispatchAnchor[],
		waitMs: number,
	): Promise<void> {
		const message = await this.#escalationText(dispatch, ownerQueued());
		let holding = false;
		for (const [index, anchor] of anchors.entries()) {
			if (notice.ended || isSettled()) break;
			const wait = index === 0 ? Math.min(waitMs, notice.msLeft) : 0;
			if (await this.#reach(anchor, Math.max(0, wait))) {
				holding = true;
				break;
			}
		}
		if (isSettled()) return notice.end("settled");
		if (notice.ended) return;
		if (!holding) return notice.end("lost");
		if (notice.msLeft <= 0) return notice.end("lost", "stuck");
		const hosts = anchors
			.map(anchor => this.#host(anchor))
			.filter((host): host is PersonNoticeHost => host !== undefined);
		const claim: PersonNoticeClaim = {
			reserve: rpcSync(() => notice.reserve(isSettled)),
			commit: rpcSync(() => notice.commit()),
			release: rpcSync(() => notice.release()),
		};
		// A shown notice was committed, so it ended delivered, by the show itself.
		const told = await this.#registry.notifyPerson(
			{ level: "warning", message, source: SUBAGENT_OVERDUE_MESSAGE_TYPE },
			hosts,
			claim,
		);
		if (told) return;
		// Nobody showed it: any hold a vanished host left is let go, then it ends.
		notice.release();
		notice.end(isSettled() ? "settled" : "lost", notice.msLeft <= 0 ? "stuck" : "gone", true);
	}
}
