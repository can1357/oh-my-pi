import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import parentIrcSteerTemplate from "../prompts/steering/parent-irc.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSessionEvent } from "./agent-session-events";
import { escapeHarnessTags } from "./harness-tags";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Capabilities the IRC bridge borrows from its owning session. */
export interface IrcBridgeHost {
	agent: Agent;
	sessionManager: SessionManager;
	isDisposed(): boolean;
	isStreaming(): boolean;
	planModeEnabled(): boolean;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	wakeForIrc(records: AgentMessage[]): void;
}

/** Owns incoming IRC queues and the session's non-interrupting aside queue. */
export class IrcBridge {
	/** Tracks parent IRC steers by object identity without trusting prompt text or publication on receipt. */
	readonly #parentSteers = new WeakSet<AgentMessage>();
	/** A subagent's records from anyone but its parent: answered in their own turn, never by
	 *  extending a finished one (whose text is the subagent's result). */
	readonly #peerMessages = new WeakSet<AgentMessage>();

	readonly #host: IrcBridgeHost;
	#interrupts: AgentMessage[] = [];
	#asides: AgentMessage[] = [];
	/** Wake-intended records parked while a pooled yield contract owns the worker or a
	 *  driven run holds wakes (`AgentSession.holdIrcWakes`). Turns must not flush these
	 *  (no observer would reply to the sender); they resume into a monitored wake once
	 *  the contract clears or the hold is released. */
	#deferredWakes: AgentMessage[] = [];
	/** In-flight wake-turn relays owed to peers. */
	readonly #pendingReplies = new Set<Promise<void>>();

	constructor(host: IrcBridgeHost) {
		this.#host = host;
	}

	/** Identifies a consumed user-role steer as an actual parent IRC request, not another agent-authored steer. */
	isParentSteer(message: AgentMessage): boolean {
		return this.#parentSteers.has(message);
	}

	/** Whether `record` came to a subagent from anyone but its parent, or as a broadcast leg. */
	isPeerMessage(record: AgentMessage): boolean {
		return this.#peerMessages.has(record);
	}

	/** Whether an incoming peer message can interrupt a wait. */
	hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	/** Whether an aside is ready for step-boundary injection (not a parked wake). */
	hasAsides(): boolean {
		return this.#asides.length > 0;
	}

	/** Whether any undelivered IRC record remains queued. */
	hasPending(): boolean {
		return this.#interrupts.length > 0 || this.#asides.length > 0 || this.#deferredWakes.length > 0;
	}

	/** Whether an IRC message from `from` is still queued for a turn yet to run. */
	hasQueuedFrom(from: string): boolean {
		return [this.#interrupts, this.#asides, this.#deferredWakes].some(queue =>
			queue.some(
				record =>
					record.role === "custom" &&
					record.customType === "irc:incoming" &&
					isRecord(record.details) &&
					record.details.from === from,
			),
		);
	}

	/** Waits until every in-flight wake-turn relay has settled. */
	async waitForReplies(): Promise<void> {
		while (this.#pendingReplies.size > 0) {
			await Promise.all(this.#pendingReplies);
		}
	}

	/** Registers a reply obligation that {@link waitForReplies} must outlast. */
	trackReply(pending: Promise<void>): void {
		this.#pendingReplies.add(pending);
		void pending.finally(() => this.#pendingReplies.delete(pending));
	}

	/** Takes queued IRC records in interrupt-before-aside order; `keepPeerMessages` leaves a
	 *  subagent's non-parent messages queued for their own wake turn. */
	drainPending(options?: { keepPeerMessages?: boolean }): AgentMessage[] {
		if (options?.keepPeerMessages) {
			const isPeer = (record: AgentMessage) => this.isPeerMessage(record);
			const records = [...this.#interrupts, ...this.#asides].filter(record => !isPeer(record));
			this.#interrupts = this.#interrupts.filter(isPeer);
			this.#asides = this.#asides.filter(isPeer);
			return records;
		}
		const records = [...this.#interrupts, ...this.#asides];
		this.#interrupts = [];
		this.#asides = [];
		return records;
	}

	/** Snapshots and discards every queued IRC record — used when a session-boundary transition
	 *  (new/switch) begins, since an aborted turn skips its final aside poll and would otherwise
	 *  leak the outgoing transcript's extension/peer content into the next session via the first
	 *  ordinary prompt's `flushPending()`. Deferred wakes ride along: without them a later
	 *  contract clear could wake the new transcript with a peer message belonging to the
	 *  previous session. Pass the snapshot to `restorePending` to undo the clear
	 *  if the transition is rolled back. */
	clearPending(): { interrupts: AgentMessage[]; asides: AgentMessage[]; deferredWakes: AgentMessage[] } {
		const snapshot = { interrupts: this.#interrupts, asides: this.#asides, deferredWakes: this.#deferredWakes };
		this.#interrupts = [];
		this.#asides = [];
		this.#deferredWakes = [];
		return snapshot;
	}

	/** Restores a snapshot taken by `clearPending`, for a rolled-back session transition. Merges
	 *  ahead of whatever queued in the meantime (e.g. an in-flight IRC auto-reply appending while
	 *  the rolled-back switch's async load/hooks were still running) instead of overwriting it, so
	 *  those newly arrived records aren't silently discarded — snapshot records precede them since
	 *  they arrived first. */
	restorePending(snapshot: {
		interrupts: AgentMessage[];
		asides: AgentMessage[];
		deferredWakes: AgentMessage[];
	}): void {
		this.#interrupts = [...snapshot.interrupts, ...this.#interrupts];
		this.#asides = [...snapshot.asides, ...this.#asides];
		this.#deferredWakes = [...snapshot.deferredWakes, ...this.#deferredWakes];
	}

	/** Queues records for the next step-boundary aside injection: IRC wakes deferred by a
	 *  session transition, and extension `deliverAs: "aside"` sends. */
	queueAside(records: AgentMessage[]): void {
		this.#asides.push(...records);
	}

	/** Parks wake-intended records while a pooled contract owns the worker. Unlike
	 *  asides, these are invisible to turn injection (`flushPending`, the loop
	 *  aside poll) and resume into a monitored wake once the contract clears. */
	queueDeferredWake(records: AgentMessage[]): void {
		this.#deferredWakes.push(...records);
	}

	/** Takes parked wake records for a post-clear monitored wake, oldest first. */
	drainDeferredWakes(): AgentMessage[] {
		const records = this.#deferredWakes;
		this.#deferredWakes = [];
		return records;
	}

	/** Surfaces and consumes queued incoming records before automatic injection. */
	drainInboxMessages(agentId: string, opts?: { from?: string; limit?: number }): IrcMessage[] {
		const messages: IrcMessage[] = [];
		const remainingInterrupts: AgentMessage[] = [];
		const remainingAsides: AgentMessage[] = [];
		const queues = [
			{ records: this.#interrupts, remaining: remainingInterrupts },
			{ records: this.#asides, remaining: remainingAsides },
		];
		for (const queue of queues) {
			for (const record of queue.records) {
				if (record.role !== "custom") {
					queue.remaining.push(record);
					continue;
				}
				if (record.customType !== "irc:incoming") {
					queue.remaining.push(record);
					continue;
				}
				const details = record.details;
				if (!details || typeof details !== "object") {
					queue.remaining.push(record);
					continue;
				}
				const id = Reflect.get(details, "id");
				const from = Reflect.get(details, "from");
				const body = Reflect.get(details, "message");
				const replyTo = Reflect.get(details, "replyTo");
				const broadcast = Reflect.get(details, "broadcast") === true;
				const progress = Reflect.get(details, "progress") === true;
				if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string") {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.from !== undefined && from !== opts.from) {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.limit !== undefined && messages.length >= opts.limit) {
					queue.remaining.push(record);
					continue;
				}
				messages.push({
					id,
					from,
					to: agentId,
					body,
					ts: record.timestamp,
					...(typeof replyTo === "string" ? { replyTo } : {}),
					...(broadcast ? { broadcast: true } : {}),
					...(progress ? { progress: true } : {}),
				});
			}
		}
		this.#interrupts = remainingInterrupts;
		this.#asides = remainingAsides;
		return messages;
	}

	/** Delivers an IRC message into the recipient session without awaiting any wake turn. */
	async deliver(msg: IrcMessage): Promise<"injected" | "woken"> {
		if (this.#host.isDisposed()) throw new Error("Recipient session is disposed.");
		const streaming = this.#host.isStreaming();
		const planModeIdle = !streaming && this.#host.planModeEnabled();
		const registry = AgentRegistry.global();
		const parentId = registry.get(msg.to)?.parentId;
		const fromParent = parentId === msg.from;
		// A subagent's result answers its parent, and its run may be waiting on its
		// own descendants, whose questions it must see in-run. Anyone else's
		// message, or a broadcast leg (which asks no one in particular), gets a
		// turn of its own.
		let fromDescendant = false;
		const seen = new Set<string>();
		for (
			let id = registry.get(msg.from)?.parentId;
			id !== undefined && !seen.has(id);
			id = registry.get(id)?.parentId
		) {
			if (id === msg.to) {
				fromDescendant = true;
				break;
			}
			seen.add(id);
		}
		const peerMessage = parentId !== undefined && (msg.broadcast === true || (!fromParent && !fromDescendant));
		// An idle subagent runs a monitored wake turn whose output is relayed
		// back to the sender (task executor `relayWakeTurnOutput`); the main
		// agent, mid-turn asides, relays, broadcast legs and progress notes have no such relay.
		const relayOnStop =
			!streaming &&
			!planModeIdle &&
			msg.to !== MAIN_AGENT_ID &&
			msg.wakeRelay !== true &&
			msg.broadcast !== true &&
			msg.progress !== true;
		// The body is agent-authored (a peer's message, or a wake relay's
		// `<task-result>` around a subagent's output), so it must not close the
		// harness envelope it is rendered into or open a forged one, e.g. a parent
		// steer. `details.message` keeps the raw body for the transcript card and inbox.
		const envelopeBody = escapeHarnessTags(msg.body);
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(ircIncomingTemplate, {
				from: msg.from,
				message: envelopeBody,
				replyTo: msg.replyTo ?? "",
				progress: msg.progress === true,
				interrupting: streaming,
				relayOnStop,
			}),
			display: true,
			details: {
				id: msg.id,
				from: msg.from,
				message: msg.body,
				...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
				...(msg.wakeRelay ? { wakeRelay: true } : {}),
				...(msg.broadcast ? { broadcast: true } : {}),
				...(msg.progress ? { progress: true } : {}),
				...(fromParent ? { fromParent: true } : {}),
			},
			attribution: "agent",
			timestamp: msg.ts,
		};
		if (peerMessage) this.#peerMessages.add(record);
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
		if (streaming) {
			if (fromParent && !peerMessage) {
				const steer: AgentMessage = {
					role: "user",
					content: prompt.render(parentIrcSteerTemplate, { from: msg.from, message: envelopeBody }),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				};
				this.#parentSteers.add(steer);
				this.#host.agent.steer(steer);
			} else {
				this.#interrupts.push(record);
			}
			return "injected";
		}
		if (this.#host.planModeEnabled()) {
			this.#host.agent.appendMessage(record);
			this.#host.sessionManager.appendCustomMessageEntry(
				record.customType,
				record.content,
				record.display,
				record.details,
				record.attribution ?? "agent",
			);
			return "injected";
		}
		this.#host.wakeForIrc([record]);
		return "woken";
	}

	/** Emits an IRC relay observation for rendering without persisting it. */
	emitRelayObservation(record: CustomMessage): void {
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
	}

	/** Persists queued IRC records that missed their step-boundary injection. */
	flushPending(): void {
		for (const record of this.drainPending()) {
			this.#host.agent.emitExternalEvent({ type: "message_start", message: record });
			this.#host.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}
}
