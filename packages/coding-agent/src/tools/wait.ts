import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { formatDuration, prompt } from "@oh-my-pi/pi-utils";
import { IrcBus, ircWaitAccepts } from "../irc/bus";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import waitIdleTemplate from "../prompts/tools/wait-idle.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManagerApi } from "../async/job-manager";
import { buildJobResult, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { hasLiveOwnedService, listServicesTolerant, waitForOwnedServiceCompletion } from "../launch/services";
import { drainPendingInbox, messageResult } from "../irc/messaging";
import { USER_AWAIT_ID } from "../registry/agent-awaits";
import type { AgentRegistryApi } from "../registry/agent-registry";
import { awaitNodeOfJob } from "../registry/agent-awaits";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

import { cfgLaunchEnabled, cfgToolsMaxTimeout } from "./settings";

const WAIT_TIMEOUT_DESCRIPTION = `seconds the whole call may take, replacing the idle-ladder window; with nothing owed, wait idles until a direct message, a job result or this deadline instead of returning at once; clamped to ${TOOL_TIMEOUTS.wait.min}-${TOOL_TIMEOUTS.wait.max} and to tools.maxTimeout`;
const waitSchema = type({
	"timeout?": type("number").describe(WAIT_TIMEOUT_DESCRIPTION),
});
/**
 * Windows (ms) a blocking wait without `timeout` gives its first wake before
 * it returns with nothing new. Each back-to-back idle wait climbs one rung, so
 * the agent gets its turn back early while work warms up, and a wait loop
 * backs off. The top rung is the `wait` default in {@link TOOL_TIMEOUTS}.
 */
const WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, TOOL_TIMEOUTS.wait.default * 1000] as const;
/** A gap this long since the last idle wait returned means the agent worked in between: the ladder restarts at the floor. */
const WAIT_LADDER_RESET_MS = 60_000;
/** First rung whose elapsed window appends the progress reminder: one idle wait is patience, a second back-to-back is a loop. */
const WAIT_NOTICE_RUNG = 1;
/** After one watched job settles, keep collecting briefly so near-simultaneous completions share one wait result. */
const WAIT_SETTLE_WINDOW_MS = 1500;
const PROGRESS_INTERVAL_MS = 500;

/** Back-to-back waits that each elapsed with nothing new. */
interface IdleStreak {
	/** Rung of the latest elapsed wait. */
	rung: number;
	/** When the latest elapsed wait returned. */
	endedAt: number;
	/** Window time spent across the streak. */
	waitedMs: number;
}

interface WaitMessaging {
	registry: AgentRegistryApi;
	senderId: string;
}

/**
 * Every message queued for the caller, oldest first: its bus mailbox and its
 * session inbox, plus `woke`, the message that ended the wait, if any. A wait
 * not already ending takes the inbox only when it holds a message that ends a
 * wait: broadcast legs and progress notes alone stay queued and inject as
 * asides once the wait returns. Mailbox mail (a failed live hand-off) reaches
 * the caller only through here, so it is always taken.
 */
function takeQueuedMessages(messaging: WaitMessaging, woke?: IrcMessage): IrcMessage[] {
	const { registry, senderId } = messaging;
	const bus = IrcBus.global();
	const queued = woke ? [woke] : [];
	for (let msg = bus.take(senderId); msg; msg = bus.take(senderId)) queued.push(msg);
	const wakes = queued.length > 0 ? undefined : (msg: IrcMessage) => ircWaitAccepts({ directOnly: true }, msg);
	queued.push(...drainPendingInbox(registry, senderId, wakes));
	// Bus ids are snowflakes: they order messages sent within one millisecond.
	return queued.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

interface PendingReplies {
	/** Agents asked that can still answer: running, holding the question for a turn of its own, or that promised a reply, and not blocked on the caller or the user. */
	from: string[];
	/** Agents asked that cannot answer before the caller finishes (see `AgentAwaits.blocksOn`). */
	blocked: string[];
	/** Agents asked that cannot answer before the user does: a dialog of theirs waits on the user (`ask`, an approval). */
	onUser: string[];
	/** Agents asked whose turn ended without an answer, or that are gone. */
	stopped: string[];
}

/**
 * Agents the caller messaged during its current run that have not answered
 * yet, split by whether a reply can still come. A message back answers, and
 * so does a settled job of the agent the caller owns, which delivers its
 * result. A running agent, or one still holding the question for a turn of
 * its own (a subagent answers a message that reached it as it finished after
 * its result is out), can answer, and so can a live one that sent progress
 * promising a later reply. Any other idle agent has finished the turn it got
 * the question in, and any automatic reply (a woken subagent's relayed
 * output) has arrived by then.
 */
function pendingReplies(messaging: WaitMessaging): PendingReplies {
	const { registry, senderId } = messaging;
	const replies: PendingReplies = { from: [], blocked: [], onUser: [], stopped: [] };
	const since = registry.get(senderId)?.session?.runStartedAt ?? 0;
	for (const { to, sentAt, promised } of IrcBus.global().unansweredSends(senderId, since)) {
		const session = registry.get(to)?.session;
		if (session && registry.awaits.blocksOn(to, senderId, sentAt)) replies.blocked.push(to);
		else if (session && registry.awaits.blocksOn(to, USER_AWAIT_ID, sentAt)) replies.onUser.push(to);
		else if (session && (promised || session.isStreaming || session.hasQueuedIrcFrom(senderId)))
			replies.from.push(to);
		else replies.stopped.push(to);
	}
	return replies;
}

/** Why a reply wait cannot (or can no longer) get its answer. */
function noReplyText(replies: PendingReplies): string {
	const ids = (list: string[]) => list.map(id => `\`${id}\``).join(", ");
	if (replies.blocked.length > 0) {
		return `${ids(replies.blocked)} cannot reply before you finish: it is waiting on your result. Finish without the answer.`;
	}
	if (replies.onUser.length > 0) {
		return `${ids(replies.onUser)} is waiting on the user and cannot reply until they answer. Go on without the answer; its reply, if it comes, arrives as a message.`;
	}
	if (replies.stopped.length > 0) {
		return `${ids(replies.stopped)} finished its turn without replying. Ask again, or finish without the answer.`;
	}
	return "no background job or service you started is running, and no agent you messaged this run owes a reply. Other agents' results and messages arrive on their own; to idle until one does, call `wait` with `timeout` instead of starting a sleep job.";
}

/** Why an idle wait cannot get a message: each of `waiters` is blocked on the caller's result. */
function awaitedText(waiters: string[]): string {
	const names = waiters.map(id => `\`${id}\``).join(", ");
	return `${names} ${waiters.length === 1 ? "is" : "are"} waiting on your result and cannot message you before you finish. Finish your work instead of idling.`;
}

/** Whether `session` has the `wait` tool active, so prompts may point blocked callers at it. */
export function hasWaitTool(session: ToolSession): boolean {
	return session.isToolActive?.("wait") ?? true;
}

/**
 * Blocks on background jobs and services the calling agent started, or on
 * the reply to a message it sent this run. Other agents' work never sustains
 * a wait: a peer owes no message. A reply wait ends once no agent asked can
 * still answer soon: each one finished its turn, is blocked on the caller
 * itself (the cycle that would park both sides), or is waiting on the user.
 * With nothing new, a wait returns after a window from {@link WAIT_LADDER_MS}
 * that climbs across back-to-back idle waits; an explicit `timeout` replaces
 * that window, and with nothing owed idles instead of returning at once,
 * unless an agent is blocked on the caller's result. A direct message arriving
 * mid-wait ends any wait, returning every message queued by then. Broadcast
 * legs and progress notes ask the caller nothing, so they never end a wait
 * and inject as asides once it returns; the exception is a broadcast from an
 * agent a reply wait asked, which answers it (see `IrcBus.unansweredSends`).
 * A progress note leaves its sender's reply owed, so the reply wait goes on.
 */
export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next result of a background job or service you started, or a reply you asked for";
	readonly description = prompt.render(waitDescription);
	readonly parameters = waitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly handlesToolInterrupt = true;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly intent = "optional";
	#idle: IdleStreak | undefined;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		// Any wait ends the idle streak unless its window elapses too (`#elapsed`).
		const idle = this.#idle;
		this.#idle = undefined;
		const registry = this.session.agentRegistry;
		// An explicit `timeout` replaces the idle-ladder window, and with nothing
		// owed turns "nothing to wait for" into an idle wait for the next message.
		// It bounds the whole call: the deadline is fixed here, before any
		// await, and every later step gets only what remains of it.
		const capMs =
			params.timeout === undefined
				? undefined
				: clampTimeout("wait", params.timeout, cfgToolsMaxTimeout.get(this.session.settings)) * 1000;
		const deadline = capMs === undefined ? undefined : Date.now() + capMs;
		const remainingMs = (): number | undefined =>
			deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
		const senderId = this.session.getAgentId?.() ?? undefined;
		const messaging = registry && senderId ? { registry, senderId } : undefined;
		const manager = this.session.asyncJobManager;

		if (messaging) {
			const queued = takeQueuedMessages(messaging);
			if (queued.length > 0) return messageResult(messaging.senderId, queued);
		}
		// Agents blocked on the caller's result when this call would idle: such
		// a call returns at once (see the idle branch below), so nothing before
		// that branch may spend its deadline. Owned work or a reply owed makes
		// the call a real wait, which an agent blocked on the caller does not end.
		const awaitedWhileIdle = (): string[] => {
			if (capMs === undefined || !messaging) return [];
			if (manager && manager.getRunningJobs({ ownerId: senderId }).length > 0) return [];
			if (manager && undeliveredJobs(manager, senderId).length > 0) return [];
			if (hasLiveOwnedService(this.session) || pendingReplies(messaging).from.length > 0) return [];
			return messaging.registry.awaits.waitersOn(messaging.senderId);
		};
		// Refreshes owned-service tracking only; jobs are in-process, so a hung
		// broker must not turn every wait into an error.
		if (cfgLaunchEnabled.get(this.session.settings)) {
			// A refresh while an agent is blocked on the caller would only delay
			// the refusal below by however long the broker takes; skip it.
			if (awaitedWhileIdle().length === 0) await this.#refreshServices(signal, remainingMs(), awaitedWhileIdle);
			// A cancellation that is not a wake still cancels the call.
			if (signal?.aborted && signal.reason !== TOOL_INTERRUPT_ABORT_REASON) throwIfAborted(signal);
			if (messaging) {
				const queued = takeQueuedMessages(messaging);
				if (queued.length > 0) return messageResult(messaging.senderId, queued);
			}
		}
		const jobs = manager?.getRunningJobs({ ownerId: senderId }) ?? [];
		// An accepted completion whose delivery has not reached the transcript
		// yet (queued, parked on the yield queue, or skipped while an earlier
		// wait watched it) is exactly what this wait is for: return it now.
		const undelivered = manager ? undeliveredJobs(manager, senderId) : [];
		if (manager && undelivered.length > 0) {
			return buildJobResult(this.session, manager, "wait", [...undelivered, ...jobs], []);
		}
		const serviceRunning = hasLiveOwnedService(this.session);
		if (jobs.length === 0 && !serviceRunning) {
			const replies = messaging ? pendingReplies(messaging) : { from: [], blocked: [], onUser: [], stopped: [] };
			if (replies.from.length === 0) {
				// An idle poll, not a failure: flagged so the loop guard keeps counting
				// across it, unless an interrupt (news for the model) landed meanwhile
				// or the text names an agent asked that can no longer answer.
				const replyNews = replies.blocked.length > 0 || replies.onUser.length > 0 || replies.stopped.length > 0;
				const news = signal?.aborted || replyNews;
				// Nothing owed and a deadline given: idle until a direct message,
				// steer, job result or service exit arrives, or the deadline
				// passes, instead of the dummy timer job a caller would otherwise
				// start to hold the wait open. An interrupt that already landed
				// ends that block at once with the interrupt's own result.
				if (capMs !== undefined && !replyNews) {
					// An agent blocked on the caller's result (an inline task spawn
					// of it, a `wait` or untimed eval handle wait on its job) cannot
					// send the message an idle wait is for: both would sit until a
					// deadline. Return at once, as a wait without `timeout` does.
					const waiters = messaging ? messaging.registry.awaits.waitersOn(messaging.senderId) : [];
					if (waiters.length > 0) {
						return {
							content: [{ type: "text", text: `Nothing to wait for: ${awaitedText(waiters)}` }],
							details: { op: "wait", jobs: [] },
							...(news ? {} : { useless: true }),
						};
					}
					return this.#blockUntilWake({
						jobs,
						manager,
						messaging,
						serviceRunning,
						idle,
						signal,
						onUpdate,
						capMs: remainingMs(),
						idleWait: true,
					});
				}
				return {
					content: [{ type: "text", text: `Nothing to wait for: ${noReplyText(replies)}` }],
					details: { op: "wait", jobs: [] },
					...(news ? {} : { useless: true }),
				};
			}
		}
		return this.#blockUntilWake({
			jobs,
			manager,
			messaging,
			serviceRunning,
			idle,
			signal,
			onUpdate,
			capMs: remainingMs(),
			idleWait: false,
		});
	}

	/**
	 * Refresh owned-service tracking within `budgetMs` (the rest of the
	 * caller's `timeout`, unbounded when absent). The refresh is raced, not
	 * trusted: client creation and connection setup do not observe the signal,
	 * so the wait stops waiting on it at the deadline, an abort, or once
	 * `awaited` reports an agent blocked on the caller of a call that would
	 * idle. The abandoned refresh checks its aborted signal once each of those
	 * steps ends and stops there, before it subscribes the session or changes
	 * its service tracking.
	 */
	async #refreshServices(
		signal: AbortSignal | undefined,
		budgetMs: number | undefined,
		awaited: () => string[],
	): Promise<void> {
		const registry = this.session.agentRegistry;
		const awaitedStop = new AbortController();
		const refreshSignal = AbortSignal.any([
			awaitedStop.signal,
			...(signal ? [signal] : []),
			...(budgetMs === undefined ? [] : [AbortSignal.timeout(budgetMs)]),
		]);
		const refresh = listServicesTolerant(this.session, refreshSignal).then(
			() => undefined,
			(error: unknown) => ({ error }),
		);
		const stopped = Promise.withResolvers<undefined>();
		const onStop = () => stopped.resolve(undefined);
		refreshSignal.addEventListener("abort", onStop, { once: true });
		// An agent may start blocking on the caller while the broker answers.
		const unsubscribe = registry?.awaits.onChange(() => {
			if (awaited().length > 0) awaitedStop.abort();
		});
		let failure: { error: unknown } | undefined;
		try {
			failure = await Promise.race([refresh, stopped.promise]);
		} finally {
			unsubscribe?.();
			refreshSignal.removeEventListener("abort", onStop);
		}
		// An interrupt landing during the refresh (most often the notice of the
		// job this wait is for) ends the wait as one landing just after it does:
		// the checks after the refresh and the aborted wake path. A deadline
		// passing during it does too: the block finds no budget left and returns
		// at once with what tracking it has. So does an agent starting to block
		// on the caller: the idle branch refuses. Any other failure is the
		// caller's to see.
		if (failure && !refreshSignal.aborted) throw failure.error;
	}

	/**
	 * Block until an owned job settles, an owned service finishes, a direct message arrives, the window elapses, or the call aborts.
	 * The window is the caller's `timeout` when given, else the ladder rung.
	 * With neither jobs nor a service, the block is a reply wait: it also ends once no agent asked can still reply.
	 * An `idleWait` block (nothing owed, the caller gave a deadline) ends only on a direct message, an interrupt
	 * (steering, an aside, a job result), an agent starting to block on the caller's result, or `capMs`.
	 */
	async #blockUntilWake(args: {
		jobs: AsyncJob[];
		manager: AsyncJobManagerApi | undefined;
		messaging: WaitMessaging | undefined;
		serviceRunning: boolean;
		idle: IdleStreak | undefined;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
		/** What remains of the caller's `timeout`; absent without one. */
		capMs: number | undefined;
		idleWait: boolean;
	}): Promise<AgentToolResult<CoordinationDetails>> {
		const { jobs, manager, messaging, serviceRunning, idle, signal, onUpdate, capMs, idleWait } = args;
		const streak = idle && Date.now() - idle.endedAt < WAIT_LADDER_RESET_MS ? idle : undefined;
		const rung = streak ? Math.min(streak.rung + 1, WAIT_LADDER_MS.length - 1) : 0;
		// An explicit `timeout` replaces the ladder window for this call; an
		// elapsed one still counts towards the idle streak and its reminder.
		const windowMs = capMs ?? WAIT_LADDER_MS[rung];
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const replyWait = !idleWait && messaging !== undefined && jobs.length === 0 && !serviceRunning;
		const asked = replyWait ? pendingReplies(messaging).from : [];
		const busAbort = new AbortController();
		// Only `busAbort` can reject this leg, and it fires once the wait has settled.
		const busLeg = messaging
			? IrcBus.global()
					.wait(messaging.senderId, { directOnly: true, repliesFrom: asked }, 0, busAbort.signal)
					.catch(() => null)
			: undefined;
		// A reply wait re-checks whether an agent asked can still answer on
		// every block change (including an asked agent opening or closing a
		// dialog that waits on the user), status change, and end of an asked
		// agent's turn (after any automatic reply that turn owes has been sent).
		let noReply: PendingReplies | undefined;
		const replyGone = Promise.withResolvers<void>();
		const unsubscribers: Array<() => void> = [];
		if (replyWait) {
			const checkReplies = () => {
				const replies = pendingReplies(messaging);
				if (replies.from.length > 0) return;
				noReply = replies;
				replyGone.resolve();
			};
			unsubscribers.push(messaging.registry.awaits.onChange(checkReplies));
			unsubscribers.push(messaging.registry.onChange(checkReplies));
			for (const id of asked) {
				const session = messaging.registry.get(id)?.session;
				if (!session) continue;
				unsubscribers.push(
					session.subscribe(event => {
						if (event.type === "agent_end") void session.waitForIrcReplies().then(checkReplies);
					}),
				);
			}
		}
		// An idle block ends once an agent starts blocking on the caller's
		// result: no message can come from it before the caller finishes.
		let awaitedBy: string[] = [];
		const awaited = Promise.withResolvers<void>();
		if (idleWait && messaging) {
			const checkWaiters = () => {
				const waiters = messaging.registry.awaits.waitersOn(messaging.senderId);
				if (waiters.length === 0) return;
				awaitedBy = waiters;
				awaited.resolve();
			};
			unsubscribers.push(messaging.registry.awaits.onChange(checkWaiters));
			// A worker's registry is a proxy: a block that began between the
			// caller's check and this subscription sends no change event here.
			checkWaiters();
		}
		// A wait on jobs blocks the caller until the first of them settles,
		// which reply and idle waits of the agents they run read. A job that is
		// not one agent's run is its own node: a workpool's aggregate job leads
		// on to the workers its holds name, a bash job to no one, so a wait with
		// a bash job in it blocks on no agent. A service is another way out, so
		// a wait with one blocks on no one either.
		const releaseHold =
			messaging && !serviceRunning && jobs.length > 0
				? messaging.registry.awaits.hold(messaging.senderId, jobs.map(awaitNodeOfJob), { interruptible: true })
				: undefined;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, windowMs);
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.resolve();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const emitProgress = () =>
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobs) },
			});
		const progressTimer = onUpdate && jobs.length > 0 ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		if (jobs.length > 0) emitProgress();
		let wake: "job" | "message" | "service" | "unanswerable" | "awaited" | "timeout" | "abort";
		try {
			const otherLegs = [
				...(busLeg ? [busLeg.then(() => "message" as const)] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				...(replyWait ? [replyGone.promise.then(() => "unanswerable" as const)] : []),
				...(idleWait && messaging ? [awaited.promise.then(() => "awaited" as const)] : []),
				timeout.then(() => "timeout" as const),
				abort.promise.then(() => "abort" as const),
			];
			wake = await Promise.race([...jobs.map(job => job.promise.then(() => "job" as const)), ...otherLegs]);
			if (wake === "job" && jobs.some(job => job.status === "running")) {
				const settle = Promise.withResolvers<void>();
				const settleTimer = setTimeout(settle.resolve, WAIT_SETTLE_WINDOW_MS);
				try {
					wake = await Promise.race([
						Promise.all(jobs.map(job => job.promise)).then(() => "job" as const),
						settle.promise.then(() => "job" as const),
						...otherLegs,
					]);
				} finally {
					clearTimeout(settleTimer);
				}
			}
		} finally {
			clearTimeout(timer);
			clearInterval(progressTimer);
			busAbort.abort();
			serviceAbort.abort();
			for (const unsubscribe of unsubscribers) unsubscribe();
			releaseHold?.();
			signal?.removeEventListener("abort", onAbort);
		}
		// Unwatch only after the result is built: a job recovered below is
		// consumed first, while one left unreported (message or interrupt won
		// the race) is re-enqueued for its ordinary async delivery.
		try {
			// A dequeued message wins a photo-finish with a job: the job remains
			// deliverable, whereas a lost message cannot be recovered from the bus.
			const message = await busLeg;
			if (message && messaging) return messageResult(messaging.senderId, takeQueuedMessages(messaging, message));
			if (signal?.aborted) {
				// Steering, a peer IRC, or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
					// A direct message queued in the session inbox (it missed the
					// bus waiter) is returned here rather than injected after.
					if (messaging) {
						const queued = takeQueuedMessages(messaging);
						if (queued.length > 0) return messageResult(messaging.senderId, queued);
					}
					// Not `useless`: a message woke the agent, which the loop guard
					// must treat as progress rather than an idle poll.
					return {
						content: [{ type: "text", text: "Wait interrupted by message." }],
						details: { op: "wait", jobs: [], interrupted: true },
					};
				}
				throwIfAborted(signal);
			}
			if (manager && jobs.length > 0) {
				const result = buildJobResult(this.session, manager, "wait", jobs, []);
				if (wake === "timeout") return this.#elapsed(result, rung, streak, windowMs);
				// A finished service is news even while every watched job still runs.
				if (wake !== "service") return result;
				const { useless: _idle, ...woke } = result;
				return woke;
			}
			if (wake === "timeout") {
				const span = formatDuration(windowMs);
				const text = idleWait
					? "Deadline reached: no message, steer or job result arrived."
					: replyWait
						? `No reply within ${span}.`
						: `No service finished within ${span}. Read proc:// for status.`;
				// A wait that ran out with nothing to report is an idle poll.
				const result: AgentToolResult<CoordinationDetails> = {
					content: [{ type: "text", text }],
					details: { op: "wait", jobs: [] },
					useless: true,
				};
				return this.#elapsed(result, rung, streak, windowMs);
			}
			return {
				content: [
					{
						type: "text",
						text:
							wake === "unanswerable" && noReply
								? noReplyText(noReply)
								: wake === "awaited"
									? `Nothing to wait for: ${awaitedText(awaitedBy)}`
									: "A service finished. Read proc:// for its status and output.",
					},
				],
				details: { op: "wait", jobs: [] },
			};
		} finally {
			manager?.unwatchJobs(watchedIds);
		}
	}

	/**
	 * End a wait whose window elapsed with nothing new: extend the idle streak
	 * and, from {@link WAIT_NOTICE_RUNG} on, append the reminder to get on with
	 * work that does not need the result instead of waiting again.
	 */
	#elapsed(
		result: AgentToolResult<CoordinationDetails>,
		rung: number,
		streak: IdleStreak | undefined,
		windowMs: number,
	): AgentToolResult<CoordinationDetails> {
		const waitedMs = (streak?.waitedMs ?? 0) + windowMs;
		this.#idle = { rung, endedAt: Date.now(), waitedMs };
		if (rung < WAIT_NOTICE_RUNG) return result;
		const notice = prompt.render(waitIdleTemplate, { waited: formatDuration(waitedMs) });
		return { ...result, content: [...result.content, { type: "text", text: notice }] };
	}
}
