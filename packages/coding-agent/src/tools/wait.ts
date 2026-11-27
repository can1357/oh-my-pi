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
import waitIdleForkTemplate from "../prompts/tools/wait-idle-fork.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManagerApi } from "../async/job-manager";
import { buildJobResult, describeEvictedJob, settledJobIds, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { hasLiveOwnedService, listServicesTolerant, waitForOwnedServiceCompletion } from "../launch/services";
import { USER_AWAIT_ID } from "../registry/agent-awaits";
import type { AgentRegistryApi } from "../registry/agent-registry";
import type { PromptCacheEntry } from "../session/cache-warmer";
import { stalledWaiters } from "../session/stalled-waiters";
import type { IrcMessage } from "../irc/irc-types";
import type { CoordinationDetails } from "./details/wait";
import { throwIfAborted } from "./tool-errors";

import { cfgLaunchEnabled, type WaitIdleTimeout, waitIdleTimeout } from "./settings";

const waitSchema = type({});
/**
 * Windows (ms) a blocking wait gives its first wake before it returns with
 * nothing new under `wait.idleTimeout: ladder` (the default; a job or service
 * wait otherwise takes the configured window, or none, every time; a reply or
 * parent wait always takes these). The first idle wait hands the agent its turn back early while
 * work warms up; a back-to-back idle wait means it has nothing else to do, so
 * it takes the top window, and keeps taking it while the waits stay
 * back-to-back. The top-level interactive session skips the floor on job
 * waits: an early return there can only end its turn, one more request
 * than blocking until the result. Every idle return re-reads the whole prompt, and each one is a
 * request. Without a known prompt-cache lifetime, the top window stays inside
 * the shortest (5-minute) prompt-cache lifetime; when the session tracks a
 * longer cache lifetime (see {@link waitTopMs}), both job/service waits and
 * reply/parent waits stretch to `ttlMs - margin` (capped at 30m) so idle
 * returns still hit a warm cache with far fewer requests per hour of waiting
 * (live job progress still streams to the UI via `onUpdate` every 500ms).
 */
const WAIT_LADDER_MS = [5_000, 240_000] as const;
const WAIT_TOP_RUNG = WAIT_LADDER_MS.length - 1;
/** How long before its cache entry expires a wait's top window returns. */
const WAIT_CACHE_MARGIN_MS = 60_000;
/** Longest top window of a wait, whatever the cache lifetime. */
const WAIT_TOP_MAX_MS = 30 * 60_000;
/** A gap this long since the last idle wait returned means the agent worked in between: the ladder restarts at the floor. */
const WAIT_LADDER_RESET_MS = 60_000;
/** After one watched job settles, keep collecting briefly so near-simultaneous completions share one wait result. */
const WAIT_SETTLE_WINDOW_MS = 1500;
/** Coalesce job and widget change notifications at the wait card's update cadence. */
const PROGRESS_COALESCE_MS = 500;
/** How long after its row is evicted a job is still named by a wait that finds nothing to wait for. */
const RECENTLY_EVICTED_MS = 10 * 60_000;
/** Most evicted jobs such a wait names. */
const RECENTLY_EVICTED_SHOWN = 3;

/**
 * Top window of a blocking wait: the cache lifetime of the caller's latest
 * request less a margin, between the default 4m top window and
 * {@link WAIT_TOP_MAX_MS}; the default 4m top window without a known entry.
 */
function waitTopMs(entry: PromptCacheEntry | undefined): number {
	const floor = WAIT_LADDER_MS[WAIT_TOP_RUNG];
	if (!entry) return floor;
	return Math.min(Math.max(entry.ttlMs - WAIT_CACHE_MARGIN_MS, floor), WAIT_TOP_MAX_MS);
}

/** Back-to-back waits that each elapsed with nothing new. */
interface IdleStreak {
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
 * or a direct message already queued in its session. Peer broadcast legs and
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

/** An agent waiting on the caller, directly or through the agents `via` (nearest it first). */
interface BlockedOnCaller {
	id: string;
	via: readonly string[];
}

interface PendingReplies {
	/** Agents asked that can still answer: running, holding the question for a turn of its own, or that promised a reply and have something to wake them, and not blocked on the caller or the user; plus the caller's live parent (see {@link liveParent}). */
	from: string[];
	/** The caller's live parent, when it is in these lists without having been asked. */
	parent?: string;
	/** Agents asked that cannot answer before the caller acts: they wait on it (see `AgentAwaits.blockedVia`). */
	blocked: BlockedOnCaller[];
	/** Agents asked that cannot answer before the user does: a dialog of theirs waits on the user (`ask`, an approval), or a top-level agent is idle with nothing to wake it. */
	onUser: string[];
	/** Subagents that promised a reply, or the live parent, now idle with nothing to wake them but a message (see `AgentSessionHandle.hasPendingWake`). */
	stalled: string[];
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
 * promising a later reply while something can still wake it. Any other idle
 * agent has finished the turn it got the question in, and any automatic reply
 * (a woken subagent's relayed output) has arrived by then. An idle promiser
 * (or parent) with nothing to wake it acts only once messaged: a top-level
 * agent waits on the user, a subagent is stalled.
 */
function pendingReplies(messaging: WaitMessaging): PendingReplies {
	const { registry, senderId } = messaging;
	const replies: PendingReplies = { from: [], blocked: [], onUser: [], stalled: [], stopped: [] };
	const since = registry.get(senderId)?.session?.runStartedAt ?? 0;
	const asked = new Set<string>();
	const mesh = agentMesh();
	for (const { to, sentAt, promised } of IrcBus.global().unansweredSends(senderId, since)) {
		asked.add(to);
		const peer = mesh && parsePeerAddress(to);
		if (mesh && peer && !registry.get(to) && mesh.peer(peer.pid)) {
			// Another instance's agent: its state is not visible here, so a live instance can still answer.
			replies.from.push(to);
			continue;
		}
		const ref = registry.get(to);
		const session = ref?.session;
		const via = session ? registry.awaits.blockedVia(to, senderId, sentAt) : undefined;
		if (!ref || !session) replies.stopped.push(to);
		else if (via) replies.blocked.push({ id: to, via });
		else if (registry.awaits.blocksOn(to, USER_AWAIT_ID, sentAt)) replies.onUser.push(to);
		else if (session.isStreaming || session.hasQueuedIrcFrom(senderId)) replies.from.push(to);
		else if (!promised) replies.stopped.push(to);
		else if (session.hasPendingWake) replies.from.push(to);
		else (ref.kind === "main" ? replies.onUser : replies.stalled).push(to);
	}
	const parent = liveParent(messaging);
	const parentRef = parent ? registry.get(parent) : undefined;
	if (parent && parentRef && !asked.has(parent)) {
		replies.parent = parent;
		// Sent at 0: any block of the parent's counts, even one a message could end,
		// since the caller is waiting rather than sending one.
		const via = registry.awaits.blockedVia(parent, senderId, 0);
		if (via) replies.blocked.push({ id: parent, via });
		else if (registry.awaits.blocksOn(parent, USER_AWAIT_ID, 0)) replies.onUser.push(parent);
		else if (parentRef.session?.hasPendingWake) replies.from.push(parent);
		else (parentRef.kind === "main" ? replies.onUser : replies.stalled).push(parent);
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

/**
 * A subagent a wait would block on, through its job, that itself waits on the
 * caller (directly or through others): the new hold would close the cycle that
 * parks both. Only a wait that subagents' jobs alone can end holds on them (a
 * bash job or service is another way out). A block that began before the
 * caller's latest message to the subagent is ending, so it does not count.
 */
function watchedAgentBlockedOnCaller(messaging: WaitMessaging, jobs: readonly AsyncJob[]): BlockedOnCaller | undefined {
	const agents = jobs.flatMap(job => (job.agentId ? [job.agentId] : []));
	if (agents.length === 0 || agents.length !== jobs.length) return undefined;
	const { registry, senderId } = messaging;
	const bus = IrcBus.global();
	for (const id of agents) {
		const via = registry.awaits.blockedVia(id, senderId, bus.lastMessageAt(senderId, id) ?? 0);
		if (via) return { id, via };
	}
	return undefined;
}

/** `ids` as backticked names, comma-separated. */
function idList(ids: readonly string[]): string {
	return ids.map(id => `\`${id}\``).join(", ");
}

/** "`B` is waiting on you (via `C`)": each agent waiting on the caller, with the chain it waits through. */
function waitingOnCaller(blocked: readonly BlockedOnCaller[]): string {
	return blocked
		.map(({ id, via }) => `\`${id}\` is waiting on you${via.length > 0 ? ` (via ${idList(via)})` : ""}`)
		.join("; ");
}

/** Why a reply wait cannot (or can no longer) get its answer. */
function noReplyText(replies: PendingReplies): string {
	if (replies.blocked.length > 0) {
		return `${waitingOnCaller(replies.blocked)}, so it cannot reply before you act. Answer it first, or finish without its reply.`;
	}
	if (replies.stalled.length > 0) {
		return `${idList(replies.stalled)} is idle and nothing will wake it: message it (that wakes it), or finish with this item marked pending.`;
	}
	if (replies.onUser.length > 0) {
		return `${idList(replies.onUser)} is waiting on the user and cannot reply until they answer. Go on without the answer; its reply, if it comes, arrives as a message.`;
	}
	if (replies.stopped.length > 0) {
		return `${idList(replies.stopped)} finished its turn without replying. Ask again, or finish without the answer.`;
	}
	return "no background job or service you started is running, and no agent you messaged this run owes a reply. Other agents' results and messages arrive on their own.";
}

/**
 * The line an elapsed wait reports: the window it spent, then what to do once
 * nothing else is left. A bare still-running snapshot reads as an empty
 * result, and agents then start `sleep` jobs to block for longer. Every result
 * and message starts the next turn of an `endTurn` caller (see
 * `ToolSession.tuiTranscript`), so it is told to end its turn, unless agents
 * stay blocked on it with nothing left to wake it (`blocking`, see
 * `stalledWaiters`): those are named instead. Any other caller is told to wait
 * again right away, which takes the top window (a minute away from `wait`
 * restarts at the first window).
 */
function elapsedReport(
	what: string,
	span: { ms: number; topMs: number },
	endTurn: boolean,
	blocking: readonly string[],
): string {
	const next = !endTurn
		? `Nothing else left? Call \`wait\` again right away: it then blocks up to ${formatDuration(span.topMs)}.`
		: blocking.length > 0
			? `${idList(blocking)} is waiting on you, and nothing will wake you once your turn ends: message it first, or start a job that does what it waits for.`
			: "Nothing else left? End your turn: results and messages start your next one.";
	return `${what} within ${formatDuration(span.ms)}. ${next}`;
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
 * itself (the cycle that would park both sides), is waiting on the user, or
 * is idle with nothing but a message to wake it. A wait that would block on
 * subagents waiting on the caller returns at once, naming them. While it
 * blocks on agents (subagents' jobs, the agents asked, the parent), a wait
 * holds on them in `AgentAwaits`, which their own waits and turn ends read.
 * With nothing new, a wait returns after a window from {@link WAIT_LADDER_MS}:
 * the first for a first idle wait (the top for the interactive session's job
 * waits), the top for each back-to-back one. A job or service wait follows
 * `wait.idleTimeout` instead when set: one fixed window, or (`none`) no window,
 * blocking until a job or service finishes, a message arrives, or the call is
 * interrupted. A
 * direct message arriving mid-wait ends any wait. Messages never ride in the wait's result: each one
 * reaches the caller as a user turn right after it (see `handOffMail`).
 * A progress note, or a broadcast leg from a peer, asks the caller nothing, so
 * it never ends a wait and injects as an aside once it returns. A broadcast
 * from an agent a reply wait asked, or from the waiter's own ancestor (the only
 * broadcaster, the main agent), interrupts the wait without settling the
 * question (see `IrcBus.unansweredSends`). A progress note leaves its sender's
 * reply owed, so the reply wait goes on.
 */
export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next result of a background job or service you started, or a reply you asked for";
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
	/** A `/tan` fork runs one assignment: an idle wait keeps waiting while that assignment is blocked. */
	readonly #tanFork: boolean;
	#description = "";
	/** The `wait.idleTimeout` value {@link #description} was rendered for. */
	#descriptionFor: WaitIdleTimeout | undefined;

	constructor(private readonly session: ToolSession) {
		this.#endTurn = session.tuiTranscript === true;
		this.#tanFork = session.tanFork === true;
	}

	get description(): string {
		const idleTimeout = waitIdleTimeout.get(this.session.settings);
		if (idleTimeout !== this.#descriptionFor) {
			this.#description = prompt.render(waitDescription, {
				endTurn: this.#endTurn,
				subagent: (this.session.taskDepth ?? 0) > 0,
				ladder: idleTimeout === "ladder",
				untilNews: idleTimeout === "none",
				longest: formatDuration(typeof idleTimeout === "number" ? idleTimeout : WAIT_LADDER_MS[WAIT_TOP_RUNG]),
			});
			this.#descriptionFor = idleTimeout;
		}
		return this.#description;
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
		const cycle = messaging && !serviceRunning ? watchedAgentBlockedOnCaller(messaging, jobs) : undefined;
		if (cycle) {
			return {
				content: [
					{
						type: "text",
						text: `${waitingOnCaller([cycle])}, so its job cannot finish before you act. Answer it first, or go on without its result.`,
					},
				],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobs) },
			};
		}
		if (jobs.length === 0 && !serviceRunning) {
			const replies: PendingReplies = messaging
				? pendingReplies(messaging)
				: { from: [], blocked: [], onUser: [], stalled: [], stopped: [] };
			if (replies.from.length === 0) {
				// An idle poll, not a failure: flagged so the loop guard keeps counting
				// across it, unless an interrupt (news for the model) landed meanwhile,
				// the text names an agent asked that can no longer answer, or an agent
				// waited on is stalled (only the caller's message wakes it).
				const askedStuck = [...replies.blocked.map(({ id }) => id), ...replies.onUser, ...replies.stopped].some(
					id => id !== replies.parent,
				);
				const news = signal?.aborted || askedStuck || replies.stalled.length > 0;
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
	 * Block until an owned job settles, an owned service finishes, a direct message arrives, the idle window (see {@link #idleSpan}) elapses, or the call aborts.
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
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const replyWait = messaging !== undefined && jobs.length === 0 && !serviceRunning;
		const span = this.#idleSpan(replyWait, streak, jobs.length);
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
		// them, and a reply or parent wait on the agents that can still answer (a
		// message from one ends it, a promise keeps it going): their own waits
		// and turn ends read these holds. A bash job or service is another way
		// out, so such a wait blocks on no one.
		const watchedAgents = jobs.flatMap(job => (job.agentId ? [job.agentId] : []));
		const awaited = replyWait ? asked : !serviceRunning && watchedAgents.length === jobs.length ? watchedAgents : [];
		const releaseHold = messaging?.registry.awaits.hold(messaging.senderId, awaited, {
			interruptible: true,
			message: replyWait,
		});
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = span ? setTimeout(timedOut, span.ms) : undefined;
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.resolve();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		let progressTimer: NodeJS.Timeout | undefined;
		let watching = true;
		let wake: "job" | "message" | "service" | "unanswerable" | "timeout" | "abort";
		try {
			if (onUpdate && manager && jobs.length > 0) {
				const emitProgress = () => {
					progressTimer = undefined;
					onUpdate({
						content: [{ type: "text", text: "" }],
						details: { op: "wait", jobs: snapshotJobs(this.session, jobs, true) },
					});
				};
				const changed = () => {
					// A worker may receive an in-flight notification after it unsubscribed.
					if (watching && !progressTimer) progressTimer = setTimeout(emitProgress, PROGRESS_COALESCE_MS);
				};
				unsubscribers.push(manager.onJobsChanged(changed, watchedIds));
				if (manager.widgets) unsubscribers.push(manager.widgets.subscribe(changed));
				emitProgress();
			}
			const otherLegs = [
				...(busLeg ? [busLeg.then(() => "message" as const)] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				...(replyWait ? [replyGone.promise.then(() => "unanswerable" as const)] : []),
				...(span ? [timeout.then(() => "timeout" as const)] : []),
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
			watching = false;
			clearTimeout(progressTimer);
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
				if (wake === "timeout" && span) {
					// The report is one text block (`buildJobResult`); the timeout line joins it.
					const report = result.content.find(block => block.type === "text")?.text ?? "";
					const blocking = this.#blockedOnIdleCaller(messaging, jobs, serviceRunning);
					const text = `${report}\n\n${elapsedReport("No job finished", span, this.#endTurn, blocking)}`;
					return this.#elapsed({ ...result, content: [{ type: "text", text }] }, span.ms, streak);
				}
				// A finished service is news even while every watched job still runs.
				if (wake !== "service") return result;
				const { useless: _idle, ...woke } = result;
				return woke;
			}
			if (wake === "timeout" && span) {
				const blocking = this.#blockedOnIdleCaller(messaging, jobs, serviceRunning);
				const text = replyWait
					? elapsedReport(
							parentOnly ? `No message from \`${asked[0]}\`` : "No reply",
							span,
							this.#endTurn,
							blocking,
						)
					: `${elapsedReport("No service finished", span, this.#endTurn, blocking)} Read proc:// for status.`;
				// A wait that ran out with nothing to report is an idle poll.
				const result: AgentToolResult<CoordinationDetails> = {
					content: [{ type: "text", text }],
					details: { op: "wait", jobs: [] },
					useless: true,
				};
				return this.#elapsed(result, span.ms, streak);
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
	 * The window a wait blocks with nothing new before it returns, and the top
	 * window its elapsed report promises the next wait; `undefined` when only
	 * news ends it. A job or service wait follows `wait.idleTimeout`; a reply or
	 * parent wait always takes the ladder, since it also ends once no agent asked
	 * can still answer.
	 */
	#idleSpan(
		replyWait: boolean,
		streak: IdleStreak | undefined,
		jobCount: number,
	): { ms: number; topMs: number } | undefined {
		const idleTimeout = replyWait ? "ladder" : waitIdleTimeout.get(this.session.settings);
		if (idleTimeout === "none") return undefined;
		if (idleTimeout !== "ladder") return { ms: idleTimeout, topMs: idleTimeout };
		const rung = streak || (this.#endTurn && jobCount > 0) ? WAIT_TOP_RUNG : 0;
		const topMs = waitTopMs(this.session.getPromptCacheEntry?.());
		return { ms: rung === WAIT_TOP_RUNG ? topMs : WAIT_LADDER_MS[rung], topMs };
	}

	/**
	 * Agents blocked on an `endTurn` caller that nothing wakes once its turn
	 * ends (see `stalledWaiters`): no job of its own that can settle without it
	 * (a subagent's job whose subagent waits on it cannot), no live service, and
	 * no other wake of its session. Empty for any other caller, or when
	 * something will wake it.
	 */
	#blockedOnIdleCaller(
		messaging: WaitMessaging | undefined,
		jobs: readonly AsyncJob[],
		serviceRunning: boolean,
	): string[] {
		if (!this.#endTurn || !messaging || serviceRunning) return [];
		const { registry, senderId } = messaging;
		if (jobs.some(job => !job.agentId || !registry.awaits.blocksOn(job.agentId, senderId, 0))) return [];
		if (this.session.hasWakeAfterTurn?.()) return [];
		return stalledWaiters(registry, senderId).map(waiter => waiter.id);
	}

	/**
	 * End a wait whose window elapsed with nothing new: extend the idle streak
	 * and, once the streak holds a second wait, append the reminder to get on with
	 * work that does not need the result instead of waiting again.
	 */
	#elapsed(
		result: AgentToolResult<CoordinationDetails>,
		windowMs: number,
		streak: IdleStreak | undefined,
	): AgentToolResult<CoordinationDetails> {
		const waitedMs = (streak?.waitedMs ?? 0) + windowMs;
		this.#idle = { endedAt: Date.now(), waitedMs };
		// One idle wait is patience; a second back-to-back is a loop.
		if (!streak) return result;
		const notice = prompt.render(this.#tanFork ? waitIdleForkTemplate : waitIdleTemplate, {
			waited: formatDuration(waitedMs),
			endTurn: this.#endTurn,
		});
		return { ...result, content: [...result.content, { type: "text", text: notice }] };
	}
}
