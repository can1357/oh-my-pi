import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { formatDuration, prompt } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import { agentMesh } from "../irc/mesh";
import { parsePeerAddress } from "../irc/mesh-protocol";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import waitIdleTemplate from "../prompts/tools/wait-idle.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManagerApi } from "../async/job-manager";
import { buildJobResult, describeEvictedJob, settledJobIds, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { hasLiveOwnedService, listServicesTolerant, waitForOwnedServiceCompletion } from "../launch/services";
import { USER_AWAIT_ID } from "../registry/agent-awaits";
import type { AgentRegistryApi } from "../registry/agent-registry";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";

import { cfgLaunchEnabled } from "./settings";

const waitSchema = type({});
/**
 * Windows (ms) a blocking wait gives its first wake before it returns with
 * nothing new. The first idle wait hands the agent its turn back early while
 * work warms up; a back-to-back idle wait means it has nothing else to do, so
 * it takes the top window, and keeps taking it while the waits stay
 * back-to-back. The top window stays inside a 5-minute prompt-cache lifetime:
 * an idle return re-reads the whole prompt, and subagents run without the
 * cache warmer, so a longer window would make every top-window return a miss.
 */
const WAIT_LADDER_MS = [5_000, 240_000] as const;
const WAIT_TOP_RUNG = WAIT_LADDER_MS.length - 1;
/** A gap this long since the last idle wait returned means the agent worked in between: the ladder restarts at the floor. */
const WAIT_LADDER_RESET_MS = 60_000;
/** First rung whose elapsed window appends the progress reminder: one idle wait is patience, a second back-to-back is a loop. */
const WAIT_NOTICE_RUNG = 1;
/** After one watched job settles, keep collecting briefly so near-simultaneous completions share one wait result. */
const WAIT_SETTLE_WINDOW_MS = 1500;
const PROGRESS_INTERVAL_MS = 500;
/** How long after its row is evicted a job is still named by a wait that finds nothing to wait for. */
const RECENTLY_EVICTED_MS = 10 * 60_000;
/** Most evicted jobs such a wait names. */
const RECENTLY_EVICTED_SHOWN = 3;

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
 * Hands the caller's bus mail to its session, which injects each message as a
 * user turn once the wait returns; a wait result never carries a message, so
 * the model never mistakes one for tool output. The mail is `woke`, the
 * message that ended the wait, plus mailbox mail (a failed live hand-off,
 * which reaches the caller only through here). Returns the hand-off when a
 * message that ends a wait now waits for the caller: mail handed over here,
 * or a direct message already queued in its session. Broadcast legs and
 * progress notes queued there alone end nothing; they inject once the wait
 * returns. With no mail the check stays synchronous, so a wait registers its
 * bus waiter before a message sent right after the call can slip past it.
 */
function handOffMail(messaging: WaitMessaging, woke?: IrcMessage): Promise<void> | undefined {
	const inbox = messaging.registry.get(messaging.senderId)?.session;
	if (!inbox) return undefined;
	const bus = IrcBus.global();
	const mail = woke ? [woke] : [];
	for (let msg = bus.take(messaging.senderId); msg; msg = bus.take(messaging.senderId)) mail.push(msg);
	if (mail.length === 0) return inbox.hasIrcInterrupts() ? Promise.resolve() : undefined;
	// Bus ids are snowflakes: they order messages sent within one millisecond.
	mail.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return (async () => {
		for (const msg of mail) await inbox.deliverIrcMessage(msg);
	})();
}

/**
 * A wait cut short by news that injects right after it as its own turn: a
 * message, steering, or a completion notice. Not `useless`: the loop guard
 * must count it as progress, not an idle poll.
 */
function interruptedResult(): AgentToolResult<CoordinationDetails> {
	return {
		content: [{ type: "text", text: "Wait interrupted by message." }],
		details: { op: "wait", jobs: [], interrupted: true },
	};
}

interface PendingReplies {
	/** Agents asked that can still answer: running, holding the question for a turn of its own, or that promised a reply, and not blocked on the caller or the user; plus the caller's live parent (see {@link liveParent}). */
	from: string[];
	/** The caller's live parent, when it is in these lists without having been asked. */
	parent?: string;
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
	const asked = new Set<string>();
	const mesh = agentMesh();
	for (const { to, sentAt, promised } of IrcBus.global().unansweredSends(senderId, since)) {
		asked.add(to);
		const peer = mesh && parsePeerAddress(to);
		if (mesh && peer && !registry.get(to) && mesh.peer(peer.pid)) {
			// Another instance's agent: its state is not visible here, so a live instance can still answer.
		const session = registry.get(to)?.session;
		if (session && registry.awaits.blocksOn(to, senderId, sentAt)) replies.blocked.push(to);
		else if (session && registry.awaits.blocksOn(to, USER_AWAIT_ID, sentAt)) replies.onUser.push(to);
		else if (session && (promised || session.isStreaming || session.hasQueuedIrcFrom(senderId)))
			replies.from.push(to);
			continue;
		}
		else replies.stopped.push(to);
	}
	const parent = liveParent(messaging);
	if (parent && !asked.has(parent)) {
		replies.parent = parent;
		// Sent at 0: any block of the parent's counts, even one a message could end,
		// since the caller is waiting rather than sending one.
		if (registry.awaits.blocksOn(parent, senderId, 0)) replies.blocked.push(parent);
		else if (registry.awaits.blocksOn(parent, USER_AWAIT_ID, 0)) replies.onUser.push(parent);
		else replies.from.push(parent);
	}
	return replies;
}

/**
 * The caller's spawning parent while its session is live. A parent directs
 * its subagent and may message it at any time ("wait for my go"), so a
 * subagent's wait with nothing else to block on blocks for it, unless the
 * parent is itself waiting on the caller or the user.
 */
function liveParent(messaging: WaitMessaging): string | undefined {
	const parentId = messaging.registry.get(messaging.senderId)?.parentId;
	return parentId && messaging.registry.get(parentId)?.session ? parentId : undefined;
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
	return "no background job or service you started is running, and no agent you messaged this run owes a reply. Other agents' results and messages arrive on their own.";
}

/**
 * The line an elapsed wait reports: the window it spent, then what to do once
 * nothing else is left. A bare still-running snapshot reads as an empty
 * result, and agents then start `sleep` jobs to block for longer. Every result
 * and message starts the next turn of an `endTurn` caller (see
 * `ToolSession.tuiTranscript`), so it is told to end its turn; any other
 * caller, to wait again right away, which takes the top window (a minute away
 * from `wait` restarts at the first window).
 */
function elapsedReport(what: string, rung: number, endTurn: boolean): string {
	const next = endTurn
		? "Nothing else left? End your turn: results and messages start your next one."
		: `Nothing else left? Call \`wait\` again right away: it then blocks up to ${formatDuration(WAIT_LADDER_MS[WAIT_TOP_RUNG])}.`;
	return `${what} within ${formatDuration(WAIT_LADDER_MS[rung])}. ${next}`;
}

/** Whether `session` has the `wait` tool active, so prompts may point blocked callers at it. */
export function hasWaitTool(session: ToolSession): boolean {
	return session.isToolActive?.("wait") ?? true;
}

/**
 * Blocks on background jobs and services the calling agent started, or on
 * the reply to a message it sent this run, or (for a subagent) its live
 * parent's next message. Other agents' work never sustains a wait: a peer
 * owes no message. A reply wait ends once no agent asked can
 * still answer soon: each one finished its turn, is blocked on the caller
 * itself (the cycle that would park both sides), or is waiting on the user.
 * With nothing new, a wait returns after a window from {@link WAIT_LADDER_MS}:
 * the first for a first idle wait, the top for each back-to-back one. A
 * direct message arriving mid-wait ends any wait. Messages never ride in the wait's result: each one
 * reaches the caller as a user turn right after it (see `handOffMail`).
 * Broadcast legs and progress notes ask the caller nothing, so they never end
 * a wait and inject as asides once it returns; the exception is a broadcast
 * from an agent a reply wait asked, which interrupts it without settling the
 * question (see `IrcBus.unansweredSends`). A progress note leaves its sender's
 * reply owed, so the reply wait goes on.
 */
export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next result of a background job or service you started, or a reply you asked for";
	readonly description: string;
	readonly parameters = waitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly handlesToolInterrupt = true;
	readonly approval = "read";
	/** Starts after earlier calls of its batch settle, so a job a same-batch `task` or `bash` call registers is waited on. */
	readonly concurrency = "exclusive";
	readonly loadMode = "essential";
	readonly intent = "optional";
	#idle: IdleStreak | undefined;
	/** The top-level interactive session: every result and message starts its next turn, so it ends its turn instead of waiting. */
	readonly #endTurn: boolean;

	constructor(private readonly session: ToolSession) {
		this.#endTurn = session.tuiTranscript === true;
		this.description = prompt.render(waitDescription, {
			endTurn: this.#endTurn,
			subagent: (session.taskDepth ?? 0) > 0,
			longest: formatDuration(WAIT_LADDER_MS[WAIT_TOP_RUNG]),
		});
	}

	async execute(
		_toolCallId: string,
		_params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		// Any wait ends the idle streak unless its window elapses too (`#elapsed`).
		const idle = this.#idle;
		this.#idle = undefined;
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? undefined;
		const messaging = registry && senderId ? { registry, senderId } : undefined;
		// Stamped once at entry, before any await: a job already settled here
		// was not handed over by this call (#16052).
		const callStartedAt = Date.now();
		const manager = this.session.asyncJobManager;
		const settledAtEntry = manager ? settledJobIds(manager, senderId) : undefined;

		const handOff = messaging && handOffMail(messaging);
		if (handOff) {
			await handOff;
			return interruptedResult();
		}
		// Refreshes owned-service tracking only; jobs are in-process, so a hung
		// daemon must not turn every wait into an error.
		if (cfgLaunchEnabled.get(this.session.settings)) {
			try {
				await listServicesTolerant(this.session, signal);
			} catch (error) {
				// An interrupt landing during the refresh (most often the notice
				// of the job this wait is for) ends the wait as one landing just
				// after it does: the checks below and the aborted wake path.
				if (signal?.reason !== TOOL_INTERRUPT_ABORT_REASON) throw error;
			}
			const handOff = messaging && handOffMail(messaging);
			if (handOff) {
				await handOff;
				return interruptedResult();
			}
		}
		const jobs = manager?.getRunningJobs({ ownerId: senderId }) ?? [];
		// An accepted completion whose delivery has not reached the transcript
		// yet (queued, parked on the yield queue, or skipped while an earlier
		// wait watched it) is exactly what this wait is for: return it now.
		const undelivered = manager ? undeliveredJobs(manager, senderId) : [];
		if (manager && undelivered.length > 0) {
			return buildJobResult(this.session, manager, "wait", [...undelivered, ...jobs], [], [], {
				startedAtMs: callStartedAt,
				settledAtEntry,
			});
		}
		const serviceRunning = hasLiveOwnedService(this.session);
		if (jobs.length === 0 && !serviceRunning) {
			const replies = messaging ? pendingReplies(messaging) : { from: [], blocked: [], onUser: [], stopped: [] };
			if (replies.from.length === 0) {
				// An idle poll, not a failure: flagged so the loop guard keeps counting
				// across it, unless an interrupt (news for the model) landed meanwhile
				// or the text names an agent asked that can no longer answer.
				const askedStuck = [...replies.blocked, ...replies.onUser, ...replies.stopped].some(
					id => id !== replies.parent,
				);
				const news = signal?.aborted || askedStuck;
				// Jobs whose rows are gone read as missing; say where their results went.
				const gone = (manager?.getEvictedJobs({ ownerId: senderId }) ?? [])
					.filter(record => callStartedAt - record.evictedAt < RECENTLY_EVICTED_MS)
					.slice(0, RECENTLY_EVICTED_SHOWN)
					.map(record => `\n- ${describeEvictedJob(record, callStartedAt)}`)
					.join("");
				return {
					content: [
						{
							type: "text",
							text: `Nothing to wait for: ${noReplyText(replies)}${gone ? `\nFinished earlier:${gone}` : ""}`,
						},
					],
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
			startedAtMs: callStartedAt,
			settledAtEntry,
		});
	}

	/**
	 * Block until an owned job settles, an owned service finishes, a direct message arrives, the ladder window elapses, or the call aborts.
	 * With neither jobs nor a service, the block is a reply wait: it also ends once no agent asked can still reply.
	 */
	async #blockUntilWake(args: {
		jobs: AsyncJob[];
		manager: AsyncJobManagerApi | undefined;
		messaging: WaitMessaging | undefined;
		serviceRunning: boolean;
		idle: IdleStreak | undefined;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
		/** Epoch ms when the enclosing `wait` call started; see {@link JobResultOptions.startedAtMs}. */
		startedAtMs: number;
		/** Jobs already settled when this call started; see {@link JobResultOptions.settledAtEntry}. */
		settledAtEntry: ReadonlySet<string> | undefined;
	}): Promise<AgentToolResult<CoordinationDetails>> {
		const { jobs, manager, messaging, serviceRunning, idle, signal, onUpdate, startedAtMs, settledAtEntry } = args;
		const streak = idle && Date.now() - idle.endedAt < WAIT_LADDER_RESET_MS ? idle : undefined;
		const rung = streak ? WAIT_TOP_RUNG : 0;
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const replyWait = messaging !== undefined && jobs.length === 0 && !serviceRunning;
		const initialReplies = replyWait ? pendingReplies(messaging) : undefined;
		const asked = initialReplies?.from ?? [];
		// Only the parent can end this wait, and the caller asked it nothing.
		const parentOnly = asked.length === 1 && asked[0] === initialReplies?.parent;
		const busAbort = new AbortController();
		// Only `busAbort` can reject this leg, and it fires once the wait has settled.
		// Without a session to hand it to, a message the leg took would be lost.
		const busLeg = messaging?.registry.get(messaging.senderId)?.session
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
				// Every turn settles idle just ahead of its `agent_end`. Unlike `subscribe`, this does not
				// make an agent homed on another thread stream its whole event feed and view here.
				unsubscribers.push(
					session.subscribeRunState(state => {
						if (state === "idle") void session.waitForIrcReplies().then(checkReplies);
					}),
				);
			}
		}
		// A wait that only these subagents' results can end blocks the caller on
		// them, which their own reply waits read. A bash job or service is
		// another way out, so such a wait blocks on no one.
		const watchedAgents = jobs.flatMap(job => (job.agentId ? [job.agentId] : []));
		const releaseHold =
			messaging && !serviceRunning && watchedAgents.length === jobs.length
				? messaging.registry.awaits.hold(messaging.senderId, watchedAgents, { interruptible: true })
				: undefined;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, WAIT_LADDER_MS[rung]);
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
		let wake: "job" | "message" | "service" | "unanswerable" | "timeout" | "abort";
		try {
			const otherLegs = [
				...(busLeg ? [busLeg.then(() => "message" as const)] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				...(replyWait ? [replyGone.promise.then(() => "unanswerable" as const)] : []),
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
			if (message && messaging) {
				await handOffMail(messaging, message);
				return interruptedResult();
			}
			if (signal?.aborted) {
				// Steering, a peer IRC, or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) return interruptedResult();
				throwIfAborted(signal);
			}
			if (manager && jobs.length > 0) {
				const result = buildJobResult(this.session, manager, "wait", jobs, [], [], {
					startedAtMs,
					settledAtEntry,
				});
				if (wake === "timeout") {
					// The report is one text block (`buildJobResult`); the timeout line joins it.
					const report = result.content.find(block => block.type === "text")?.text ?? "";
					const text = `${report}\n\n${elapsedReport("No job finished", rung, this.#endTurn)}`;
					return this.#elapsed({ ...result, content: [{ type: "text", text }] }, rung, streak);
				}
				// A finished service is news even while every watched job still runs.
				if (wake !== "service") return result;
				const { useless: _idle, ...woke } = result;
				return woke;
			}
			if (wake === "timeout") {
				const text = replyWait
					? elapsedReport(parentOnly ? `No message from \`${asked[0]}\`` : "No reply", rung, this.#endTurn)
					: `${elapsedReport("No service finished", rung, this.#endTurn)} Read proc:// for status.`;
				// A wait that ran out with nothing to report is an idle poll.
				const result: AgentToolResult<CoordinationDetails> = {
					content: [{ type: "text", text }],
					details: { op: "wait", jobs: [] },
					useless: true,
				};
				return this.#elapsed(result, rung, streak);
			}
			return {
				content: [
					{
						type: "text",
						text:
							wake === "unanswerable" && noReply
								? noReplyText(noReply)
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
	): AgentToolResult<CoordinationDetails> {
		const waitedMs = (streak?.waitedMs ?? 0) + WAIT_LADDER_MS[rung];
		this.#idle = { rung, endedAt: Date.now(), waitedMs };
		if (rung < WAIT_NOTICE_RUNG) return result;
		const notice = prompt.render(waitIdleTemplate, { waited: formatDuration(waitedMs) });
		return { ...result, content: [...result.content, { type: "text", text: notice }] };
	}
}
