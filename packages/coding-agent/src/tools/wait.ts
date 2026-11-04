import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManagerApi } from "../async/job-manager";
import { buildJobResult, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { hasLiveOwnedService, listServicesTolerant, waitForOwnedServiceCompletion } from "../launch/services";
import { drainPendingInbox, messageResult } from "../irc/messaging";
import type { AgentRegistryApi } from "../registry/agent-registry";
import { awaitNodeOfJob } from "../registry/agent-awaits";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

import { cfgLaunchEnabled, cfgToolsMaxTimeout } from "./settings";

const WAIT_TIMEOUT_DESCRIPTION = `seconds the whole call may take; with nothing owed, wait idles until a message, a job result or this deadline instead of returning at once; clamped to ${TOOL_TIMEOUTS.wait.min}-${TOOL_TIMEOUTS.wait.max} and to tools.maxTimeout`;
const waitSchema = type({
	"timeout?": type("number").describe(WAIT_TIMEOUT_DESCRIPTION),
});
/** Safety cap of a wait called without `timeout`. */
const WAIT_MAX_MS = TOOL_TIMEOUTS.wait.default * 1000;
const PROGRESS_INTERVAL_MS = 500;

interface WaitMessaging {
	registry: AgentRegistryApi;
	senderId: string;
}

function takeQueuedMessage(messaging: WaitMessaging | undefined): IrcMessage | undefined {
	if (!messaging) return undefined;
	return drainPendingInbox(messaging.registry, messaging.senderId) ?? IrcBus.global().take(messaging.senderId);
}

interface PendingReplies {
	/** Agents asked that can still answer: running, holding the question for a turn of its own, or that promised a reply, and not blocked on the caller. */
	from: string[];
	/** Agents asked that cannot answer before the caller finishes (see `AgentAwaits.blocksOn`). */
	blocked: string[];
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
	const replies: PendingReplies = { from: [], blocked: [], stopped: [] };
	const since = registry.get(senderId)?.session?.runStartedAt ?? 0;
	for (const { to, sentAt, promised } of IrcBus.global().unansweredSends(senderId, since)) {
		const session = registry.get(to)?.session;
		if (session && registry.awaits.blocksOn(to, senderId, sentAt)) replies.blocked.push(to);
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
 * still answer: each one finished its turn, or is blocked on the caller
 * itself, the cycle that would park both sides. A message arriving mid-wait
 * ends any wait.
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

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		const registry = this.session.agentRegistry;
		// An explicit `timeout` replaces the safety cap, and with nothing owed
		// turns "nothing to wait for" into an idle wait for the next message.
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

		const pending = takeQueuedMessage(messaging);
		if (pending && messaging) return messageResult(messaging.senderId, pending);
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
			const queued = takeQueuedMessage(messaging);
			if (queued && messaging) return messageResult(messaging.senderId, queued);
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
			const replies = messaging ? pendingReplies(messaging) : { from: [], blocked: [], stopped: [] };
			if (replies.from.length === 0) {
				// An idle poll, not a failure: flagged so the loop guard keeps counting
				// across it, unless an interrupt (news for the model) landed meanwhile
				// or the text names an agent asked that can no longer answer.
				const replyNews = replies.blocked.length > 0 || replies.stopped.length > 0;
				const news = signal?.aborted || replyNews;
				// Nothing owed and a deadline given: idle until a message, steer,
				// job result or service exit arrives, or the deadline passes,
				// instead of the dummy timer job a caller would otherwise start to
				// hold the wait open. An interrupt that already landed ends that
				// block at once with the interrupt's own result.
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
						signal,
						onUpdate,
						capMs: remainingMs(),
						idle: true,
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
			signal,
			onUpdate,
			capMs: remainingMs(),
			idle: false,
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
	 * Block until an owned job settles, an owned service finishes, a message arrives, the cap elapses, or the call aborts.
	 * With neither jobs nor a service, the block is a reply wait: it also ends once no agent asked can still reply.
	 * An `idle` block (nothing owed, the caller gave a deadline) ends only on a message, an interrupt
	 * (steering, an aside, a job result), an agent starting to block on the caller's result, or `capMs`.
	 */
	async #blockUntilWake(args: {
		jobs: AsyncJob[];
		manager: AsyncJobManagerApi | undefined;
		messaging: WaitMessaging | undefined;
		serviceRunning: boolean;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
		/** The caller's `timeout`; the 30-minute safety cap when absent. */
		capMs: number | undefined;
		idle: boolean;
	}): Promise<AgentToolResult<CoordinationDetails>> {
		const { jobs, manager, messaging, serviceRunning, signal, onUpdate, capMs, idle } = args;
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const busAbort = new AbortController();
		// Only `busAbort` can reject this leg, and it fires once the wait has settled.
		const busLeg = messaging
			? IrcBus.global()
					.wait(messaging.senderId, {}, 0, busAbort.signal)
					.catch(() => null)
			: undefined;
		// A reply wait re-checks whether an agent asked can still answer on
		// every block change, status change, and end of an asked agent's turn
		// (after any automatic reply that turn owes has been sent).
		const replyWait = !idle && messaging !== undefined && jobs.length === 0 && !serviceRunning;
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
			for (const id of pendingReplies(messaging).from) {
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
		if (idle && messaging) {
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
		const timer = setTimeout(timedOut, capMs ?? WAIT_MAX_MS);
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
			wake = await Promise.race([
				...jobs.map(job => job.promise.then(() => "job" as const)),
				...(busLeg ? [busLeg.then(() => "message" as const)] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				...(replyWait ? [replyGone.promise.then(() => "unanswerable" as const)] : []),
				...(idle && messaging ? [awaited.promise.then(() => "awaited" as const)] : []),
				timeout.then(() => "timeout" as const),
				abort.promise.then(() => "abort" as const),
			]);
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
			if (message && messaging) return messageResult(messaging.senderId, message);
			if (signal?.aborted) {
				// Steering, a peer IRC, or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
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
				// A finished service is news even while every watched job still runs.
				if (wake !== "service") return result;
				const { useless: _idle, ...woke } = result;
				return woke;
			}
			return {
				content: [
					{
						type: "text",
						text:
							wake === "service"
								? "A service finished. Read proc:// for its status and output."
								: wake === "unanswerable" && noReply
									? noReplyText(noReply)
									: wake === "awaited"
										? `Nothing to wait for: ${awaitedText(awaitedBy)}`
										: idle
											? "Deadline reached: no message, steer or job result arrived."
											: replyWait
												? "Wait limit reached with no reply. Ask again, or finish without the answer."
												: "Wait limit reached; background work may still be running. Read proc:// for status.",
					},
				],
				details: { op: "wait", jobs: [] },
				// A wait that ran out with nothing to report is an idle poll.
				...(wake === "timeout" ? { useless: true } : {}),
			};
		} finally {
			manager?.unwatchJobs(watchedIds);
		}
	}
}
