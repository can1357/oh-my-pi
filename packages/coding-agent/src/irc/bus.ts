/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage). Replies are real turns by
 * the recipient, observed via `wait` — with one exception: when the sender
 * awaits a reply and the recipient is mid-turn with async execution
 * disabled, the recipient session generates an ephemeral side-channel
 * auto-reply (it may be blocked in a synchronous task spawn whose batch
 * includes the sender, so a real turn could never happen in time).
 */

import { logger, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import {
	authorizeIrcDelivery,
	type CollaborationPolicy,
	type IrcAuthorizationInput,
} from "../orchestration/collaboration-policy";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";
import type { IrcIpc } from "./ipc";

export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

export interface IrcSendOptions {
	expectsReply?: boolean;
	/** Marks fan-out deliveries so report-only and narrowed peer policies can reject broadcasts. */
	isBroadcast?: boolean;
	/** Skips the display-only main-UI relay for an already-visible delivery. */
	suppressRelay?: boolean;
}

interface WakeReservation {
	agentId: string;
	policy: CollaborationPolicy;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	#ipc: IrcIpc | undefined;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	readonly #completionFlags = new Map<string, Set<string>>();
	readonly #remainingWakeBudgets = new Map<string, number>();

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
	}

	attachIpc(ipc: IrcIpc | undefined): void {
		this.#ipc = ipc;
	}

	/** Deliver a message received from a same-CWD remote process. */
	async deliverRemote(message: IrcMessage, opts?: IrcSendOptions): Promise<IrcDeliveryReceipt> {
		return this.send(message, opts);
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
	 *
	 * `opts.expectsReply` marks sends whose caller is blocked on an answer
	 * (`send await:true`). It is forwarded to the recipient session so a
	 * mid-turn recipient that cannot reach a step boundary (async execution
	 * disabled — e.g. blocked in a synchronous task spawn awaiting the
	 * sender's own batch) can generate an ephemeral side-channel auto-reply
	 * instead of stranding the sender until timeout.
	 *
	 * `opts.suppressRelay` skips the display-only main-UI relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets the main
	 * agent directly: the main agent then already sees the body as its own
	 * incoming card, so relaying the sibling legs would duplicate it.
	 */
	async send(msg: Omit<IrcMessage, "id" | "ts">, opts?: IrcSendOptions): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		if (!this.#registry.get(message.to) && this.#ipc) {
			const reservations: WakeReservation[] = [];
			const remoteReceipt = await this.#ipc.send(message.to, msg, opts, remotePeer => {
				const requiresWake = remotePeer.status === "idle" || remotePeer.status === "parked";
				const senderPolicy = this.#policyFor(this.#registry.get(message.from));
				const senderError = this.#authorizationError(senderPolicy, message.from, {
					fromId: message.from,
					toId: message.to,
					requiresWake,
					isBroadcast: opts?.isBroadcast,
				});
				if (senderError) return senderError;
				const reservation = requiresWake ? this.#reserveWake(message.from, senderPolicy) : undefined;
				if (reservation) reservations.push(reservation);
				return undefined;
			});
			if (remoteReceipt) {
				if (remoteReceipt.outcome === "failed") this.#restoreWakeReservations(reservations);
				return remoteReceipt;
			}
			this.#restoreWakeReservations(reservations);
		}
		const ref = this.#registry.get(message.to);
		if (!ref || ref.status === "aborted") {
			return { to: message.to, outcome: "failed", error: `Unknown or terminated agent "${message.to}".` };
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		const hasWaiter = this.#hasMatchingWaiter(message.to, message.from);
		const liveSessionKnownIdle = typeof ref.session?.isStreaming === "boolean" && !ref.session.isStreaming;
		const requiresWake = ref.status === "parked" || (!hasWaiter && (ref.status === "idle" || liveSessionKnownIdle));
		const reservations: WakeReservation[] = [];
		const senderPolicy = this.#policyFor(this.#registry.get(message.from));
		const senderError = this.#authorizationError(senderPolicy, message.from, {
			fromId: message.from,
			toId: message.to,
			requiresWake,
			isBroadcast: opts?.isBroadcast,
		});
		if (senderError) {
			return { to: message.to, outcome: "failed", error: senderError };
		}
		const senderReservation = requiresWake ? this.#reserveWake(message.from, senderPolicy) : undefined;
		if (senderReservation) reservations.push(senderReservation);

		let revived = false;
		if (ref.status === "parked") {
			let recipientAuthorizedBeforeRevive = false;
			try {
				await this.#lifecycle().ensureLive(message.to, {
					beforeRevive: hydratedRef => {
						const recipientPolicy = this.#policyFor(hydratedRef);
						const recipientError = this.#authorizationError(recipientPolicy, message.to, {
							fromId: message.to,
							toId: message.from,
							requiresWake: true,
							isBroadcast: opts?.isBroadcast,
						});
						if (recipientError) throw new Error(recipientError);
						const reservation = this.#reserveWake(message.to, recipientPolicy);
						if (reservation) reservations.push(reservation);
						recipientAuthorizedBeforeRevive = true;
					},
				});
				revived = true;
			} catch (error) {
				this.#restoreWakeReservations(reservations);
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			// A concurrent non-IRC revival may have supplied the shared in-flight
			// promise without running our hook. Recheck before handing off delivery.
			if (!recipientAuthorizedBeforeRevive) {
				const liveRef = this.#registry.get(message.to);
				const recipientPolicy = this.#policyFor(liveRef);
				const recipientError = this.#authorizationError(recipientPolicy, message.to, {
					fromId: message.to,
					toId: message.from,
					requiresWake: true,
					isBroadcast: opts?.isBroadcast,
				});
				if (recipientError) {
					this.#restoreWakeReservations(reservations);
					return { to: message.to, outcome: "failed", error: recipientError };
				}
				const reservation = this.#reserveWake(message.to, recipientPolicy);
				if (reservation) reservations.push(reservation);
			}
		} else {
			const recipientPolicy = this.#policyFor(ref);
			const recipientError = this.#authorizationError(recipientPolicy, message.to, {
				fromId: message.to,
				toId: message.from,
				requiresWake,
				isBroadcast: opts?.isBroadcast,
			});
			if (recipientError) {
				this.#restoreWakeReservations(reservations);
				return { to: message.to, outcome: "failed", error: recipientError };
			}
			const recipientReservation = requiresWake ? this.#reserveWake(message.to, recipientPolicy) : undefined;
			if (recipientReservation) reservations.push(recipientReservation);
		}

		// A pending `wait` from the recipient consumes the message directly —
		// it is returned from their irc tool call and never hits the inbox or
		// the session injection path.
		const waiter = this.#takeMatchingWaiter(message.to, message.from);
		if (waiter) {
			waiter.resolve(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			if (!revived) this.#restoreWakeReservations(reservations);
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message, opts);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer
			// the message so a later `wait`/`inbox` from the recipient can still
			// pick it up. The receipt stays "failed" — the recipient has not
			// seen it.
			this.#enqueue(message);
			if (!revived) this.#restoreWakeReservations(reservations);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, filter.from);
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;

		const waiter: IrcWaiter = {
			from: filter.from,
			resolve: msg => {
				cleanup();
				resolve(msg);
			},
			cancel: () => {
				cleanup();
			},
		};
		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		};

		if (signal) {
			onAbort = () => {
				cleanup();
				reject(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			// Deliberately ref'd: on Bun/Windows an unref'd timeout whose promise
			// is the only pending work never fires, hanging `irc wait` (and any
			// `send await:true`) forever instead of timing out. The wait is
			// abortable via `signal`, so shutdown paths are not blocked by the
			// pending timer.
			timer = setTimeout(() => {
				cleanup();
				resolve(null);
			}, timeoutMs);
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);
		return promise;
	}

	/** Drain (or peek) pending messages for `agentId`. */
	inbox(agentId: string, opts?: { peek?: boolean }): IrcMessage[] {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox || mailbox.length === 0) return [];
		if (opts?.peek) return [...mailbox];
		this.#mailboxes.delete(agentId);
		return mailbox;
	}

	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	tryComplete(agentId: string, targetId: string): boolean {
		const pairId = this.#completionPairId(agentId, targetId);
		let completed = this.#completionFlags.get(pairId);
		if (!completed) {
			completed = new Set<string>();
			this.#completionFlags.set(pairId, completed);
		}
		completed.add(agentId);
		if (completed.has(agentId) && completed.has(targetId)) {
			this.#completionFlags.delete(pairId);
			return true;
		}
		return false;
	}

	clearCompletion(agentId: string, targetId: string): void {
		this.#completionFlags.delete(this.#completionPairId(agentId, targetId));
	}

	#completionPairId(agentId: string, targetId: string): string {
		return [agentId, targetId].sort().join(":");
	}
	#policyFor(ref: AgentRef | undefined): CollaborationPolicy | undefined {
		const session = ref?.session;
		return (
			ref?.collaborationPolicy ??
			(typeof session?.getCollaborationPolicy === "function" ? session.getCollaborationPolicy() : undefined)
		);
	}

	#remainingWakeBudget(agentId: string, policy: CollaborationPolicy | undefined): number | undefined {
		if (!policy || policy.wakeBudget <= 0) return undefined;
		return this.#remainingWakeBudgets.get(agentId) ?? policy.wakeBudget;
	}

	#authorizationError(
		policy: CollaborationPolicy | undefined,
		ownerId: string,
		input: IrcAuthorizationInput,
	): string | undefined {
		const decision = authorizeIrcDelivery(policy, {
			...input,
			remainingWakeBudget: this.#remainingWakeBudget(ownerId, policy),
		});
		return decision.allow
			? undefined
			: `IRC delivery denied by collaboration policy for "${ownerId}" (${decision.reasonCode}).`;
	}

	#reserveWake(agentId: string, policy: CollaborationPolicy | undefined): WakeReservation | undefined {
		if (!policy || policy.wakeBudget <= 0) return undefined;
		const remaining = this.#remainingWakeBudget(agentId, policy) ?? policy.wakeBudget;
		this.#remainingWakeBudgets.set(agentId, Math.max(0, remaining - 1));
		return { agentId, policy };
	}

	#restoreWakeReservations(reservations: readonly WakeReservation[]): void {
		for (const reservation of reservations) {
			const remaining = this.#remainingWakeBudgets.get(reservation.agentId) ?? 0;
			this.#remainingWakeBudgets.set(reservation.agentId, Math.min(reservation.policy.wakeBudget, remaining + 1));
		}
	}

	#hasMatchingWaiter(agentId: string, from: string): boolean {
		return this.#waiters.get(agentId)?.some(waiter => !waiter.from || waiter.from === from) === true;
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

	/** Resolve the OLDEST waiter for `agentId` whose from-filter accepts `from`. */
	#takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => !waiter.from || waiter.from === from);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => msg.from === from) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the main session
	 * UI. Skipped when the main agent is either endpoint: as recipient its
	 * own `deliverIrcMessage` (or `wait` tool result) already shows the
	 * message, and as sender the irc send tool call already rendered the
	 * outbound body — relaying it again would duplicate it in the transcript.
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
