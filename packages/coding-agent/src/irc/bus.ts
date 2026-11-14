/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked and killed agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage).
 */

import { type IrcDeliveryReceipt, type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { type AgentLifecycleApi, AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";

interface IrcWaiter {
	filter: IrcWaitFilter;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** Which messages a bus {@link IrcBusApi.wait} consumes. */
export interface IrcWaitFilter {
	/** Only messages from this agent. */
	from?: string;
	/**
	 * Skip broadcast legs and progress notes, which ask the waiter nothing: they
	 * reach it through ordinary delivery, a non-interrupting aside when it is busy.
	 */
	directOnly?: boolean;
	/**
	 * With `directOnly`, still take a broadcast from these agents: the waiter
	 * asked them something, so their news interrupts its wait without settling
	 * the outstanding direct question (see {@link IrcBusApi.unansweredSends}).
	 */
	repliesFrom?: readonly string[];
}

/** Whether a bus wait under `filter` consumes `msg`. */
function ircWaitAccepts(filter: IrcWaitFilter, msg: IrcMessage): boolean {
	if (filter.from !== undefined && msg.from !== filter.from) return false;
	if (!filter.directOnly || (!msg.broadcast && !msg.progress)) return true;
	return !msg.progress && (filter.repliesFrom?.includes(msg.from) ?? false);
}

/** When a send went out: wall-clock `ts`, and `seq` to order sends within one millisecond. */
interface SendMark {
	ts: number;
	seq: number;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

/** Public surface of the process-global IRC bus, implemented locally on main and by a proxy in workers. */
export interface IrcBusApi {
	/** Fire-and-forget delivery; the receipt reports how the message reached the recipient. */
	send(msg: Omit<IrcMessage, "id" | "ts">): Promise<IrcDeliveryReceipt>;
	/** Whether `from` successfully sent `to` anything, progress included, at or after `sinceTs`. */
	sentSince(from: string, to: string, sinceTs: number): boolean;
	/** Agents `from` messaged directly at or after `sinceTs` that have not answered since. */
	unansweredSends(from: string, sinceTs: number): Array<{ to: string; sentAt: number; promised: boolean }>;
	/** Block until a message for `agentId` that `filter` accepts arrives; null on timeout. */
	wait(
		agentId: string,
		filter: IrcWaitFilter,
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null>;
	/** Consume the oldest pending message for `agentId` (optionally from `from`). */
	take(agentId: string, from?: string): IrcMessage | undefined;
	/** Unread count for the local Agent Hub overlay. */
	unreadCount(agentId: string): number;
	/** Count a settled job of agent `from` owned by `to` as `from`'s reply to `to`. */
	recordReply(from: string, to: string): void;
}

export class IrcBus implements IrcBusApi {
	static #global: IrcBusApi | undefined;

	/** The installed bus; lazily a local {@link IrcBus} unless a worker installed a proxy. */
	static global(): IrcBusApi {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Install the process-global bus. Worker bootstrap only. */
	static installGlobal(api: IrcBusApi): void {
		IrcBus.#global = api;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	/**
	 * Count a settled job of agent `from` owned by `to` as `from`'s reply to
	 * `to`: the job delivers that agent's outcome, so it answers what `to`
	 * asked it before now (see {@link unansweredSends}). With no bus yet no
	 * message was ever sent, so there is nothing to answer.
	 */
	static recordReply(from: string, to: string): void {
		IrcBus.#global?.recordReply(from, to);
	}

	readonly #registry: AgentRegistryApi;
	readonly #lifecycle: () => AgentLifecycleApi;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	/** The latest successful non-progress send per `from` → `to`; see {@link sentSince}. */
	readonly #lastSent = new Map<string, Map<string, SendMark>>();
	/** The latest non-broadcast, non-progress reply per `from` → `to`, including wake relays. */
	readonly #lastReply = new Map<string, Map<string, SendMark>>();
	/** The latest direct (non-broadcast, non-progress, non-relay) send per `from` → `to`; see {@link unansweredSends}. */
	readonly #lastDirect = new Map<string, Map<string, SendMark>>();
	/** The latest progress message per `from` → `to`: a promise that a reply will follow. */
	readonly #lastProgress = new Map<string, Map<string, SendMark>>();
	/** The latest job-carried reply per agent → owner; see {@link IrcBus.recordReply}. */
	readonly #lastJobReply = new Map<string, Map<string, SendMark>>();
	/** Last {@link SendMark.seq} handed out, taken when a send starts. */
	#sendSeq = 0;

	constructor(registry: AgentRegistryApi = AgentRegistry.global(), lifecycle?: AgentLifecycleApi) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 */
	async send(msg: Omit<IrcMessage, "id" | "ts">): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		// Taken before delivery: a reply sent while this message is still being
		// delivered must still order after it.
		const mark: SendMark = { ts: message.ts, seq: ++this.#sendSeq };
		const receipt = await this.#deliver(message);
		if (receipt.outcome !== "failed") {
			if (message.progress) {
				this.#record(this.#lastProgress, message.from, message.to, mark);
			} else {
				this.#record(this.#lastSent, message.from, message.to, mark);
				if (!message.broadcast) {
					this.#record(this.#lastReply, message.from, message.to, mark);
					if (!message.wakeRelay) this.#record(this.#lastDirect, message.from, message.to, mark);
				}
			}
		}
		return receipt;
	}

	#record(table: Map<string, Map<string, SendMark>>, from: string, to: string, mark: SendMark): void {
		let sent = table.get(from);
		if (!sent) {
			sent = new Map();
			table.set(from, sent);
		}
		// Deliveries can settle out of order; keep the latest send.
		if ((sent.get(to)?.seq ?? 0) < mark.seq) sent.set(to, mark);
	}

	/** Instance half of {@link IrcBus.recordReply}: records the job-carried reply on this bus. */
	recordReply(from: string, to: string): void {
		this.#record(this.#lastJobReply, from, to, { ts: Date.now(), seq: ++this.#sendSeq });
	}

	/**
	 * Whether `from` successfully sent `to` anything, progress included, at or
	 * after `sinceTs`. The wake-turn relay uses it to skip agents that already
	 * answered their waker themselves, or promised it a later answer.
	 */
	sentSince(from: string, to: string, sinceTs: number): boolean {
		return [this.#lastSent, this.#lastProgress].some(table => (table.get(from)?.get(to)?.ts ?? -1) >= sinceTs);
	}

	/**
	 * Agents `from` messaged directly at or after `sinceTs` that have not
	 * answered since, with when the latest of those messages went out: the
	 * replies a `wait` can block for. A non-broadcast message back answers, and
	 * so does a settled job of the agent `from` owns, which delivers its result.
	 * Progress answers nothing; it marks the request `promised`, and from then on only
	 * an explicit message answers it (a job settling the turn that sent the
	 * progress must not). "Since" is by send order, not timestamp, so an answer
	 * to an earlier question never settles a later one sent within the same
	 * millisecond.
	 */
	unansweredSends(from: string, sinceTs: number): Array<{ to: string; sentAt: number; promised: boolean }> {
		const sends = this.#lastDirect.get(from);
		if (!sends) return [];
		const unanswered: Array<{ to: string; sentAt: number; promised: boolean }> = [];
		for (const [to, sent] of sends) {
			if (sent.ts < sinceTs) continue;
			const after = (table: Map<string, Map<string, SendMark>>) => (table.get(to)?.get(from)?.seq ?? 0) > sent.seq;
			const promised = after(this.#lastProgress);
			if (after(this.#lastReply) || (!promised && after(this.#lastJobReply))) continue;
			unanswered.push({ to, sentAt: sent.ts, promised });
		}
		return unanswered;
	}

	async #deliver(message: IrcMessage): Promise<IrcDeliveryReceipt> {
		const ref = this.#registry.get(message.to);
		if (!ref) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check the subagent roster or read history:// for known peers.`,
			};
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		// A `parked` or killed (`aborted`) recipient always needs the lifecycle to
		// revive it from its transcript — this is read from *this* bus's registry,
		// so it holds for any registry. The mid-park / adopted checks below query
		// the lifecycle's own state, which only describes the registry it manages:
		// consult them only when the lifecycle owns this bus's registry, otherwise
		// a custom-registry bus (fallen back to the global manager) would gate a
		// live recipient on unrelated global park state. Main/non-adopted live
		// peers skip the gate, and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			ref.status === "aborted" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(message.to) || lifecycle.has(message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await lifecycle.ensureLive(message.to);
				// Revival = we did not keep the same live instance (parked start, or
				// park completed and a fresh session was rebuilt).
				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				// Not revivable / released / revive failed. Do not buffer: a permanent
				// failure must not inflate unread counts or pretend delivery is pending.
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// A pending bus wait from the recipient consumes the message directly
		// and never hits the inbox; the `wait` tool hands it to its own session,
		// which injects it as a user turn.
		const waiter = this.#takeMatchingWaiter(message);
		if (waiter) {
			waiter.resolve(message);
			this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message);
			this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer
			// the message so a later `wait`/`inbox` from the recipient can still
			// pick it up. The receipt stays "failed" — the recipient has not
			// seen it.
			this.#enqueue(message);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` that `filter` accepts arrives;
	 * consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: IrcWaitFilter,
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, msg => ircWaitAccepts(filter, msg));
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		};

		const waiter: IrcWaiter = {
			filter,
			resolve: msg => settle({ kind: "message", msg }),
			cancel: () => cleanup(),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		return promise;
	}

	/**
	 * Consume the OLDEST pending message for `agentId` (optionally restricted
	 * to `from`), leaving the rest of the mailbox intact. This is the exact
	 * atomic step `wait` performs on entry, exposed for callers that must not
	 * block without draining the entire backlog.
	 */
	take(agentId: string, from?: string): IrcMessage | undefined {
		return this.#takeFromMailbox(agentId, msg => from === undefined || msg.from === from);
	}

	/** Unread count for the local Agent Hub overlay. */
	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	#enqueue(message: IrcMessage): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Resolve the OLDEST waiter for the recipient whose filter accepts `message`. */
	#takeMatchingWaiter(message: IrcMessage): IrcWaiter | undefined {
		const waiters = this.#waiters.get(message.to);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => ircWaitAccepts(waiter.filter, message));
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(message.to);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, accepts: (msg: IrcMessage) => boolean): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = mailbox.findIndex(accepts);
		if (index === -1) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the main session
	 * UI. Skipped when the main agent is either endpoint: as recipient its
	 * own `deliverIrcMessage` already shows the message, and as sender the
	 * irc send tool call already rendered the outbound body — relaying it
	 * again would duplicate it in the transcript.
	 */
	#relayToMainUi(message: IrcMessage): void {
		if (message.to === MAIN_AGENT_ID || message.from === MAIN_AGENT_ID) return;
		const mainSession = this.#registry.get(MAIN_AGENT_ID)?.session;
		if (!mainSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}
