import { type Agent, type AgentMessage, ASIDE_MESSAGE_COMMIT, ASIDE_MESSAGE_DISCARD } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { IrcDeliveryRejectedError } from "../irc/bus";
import parentIrcSteerTemplate from "../prompts/steering/parent-irc.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
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
	isIrcAdmissionBlocked(): boolean;
	hasIrcWakeTurnObserver(): boolean;
	planModeEnabled(): boolean;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	wakeForIrc(records: AgentMessage[]): void;
}

/** Owns incoming IRC queues and the session's non-interrupting aside queue. */
export class IrcBridge {
	readonly #host: IrcBridgeHost;
	#interrupts: AgentMessage[] = [];
	#asides: AgentMessage[] = [];
	/** Wake-intended records parked while a pooled yield contract owns the worker.
	 *  Pooled turns must not flush these (no observer would reply to the sender);
	 *  they resume into a monitored wake once the contract clears. */
	#deferredWakes: AgentMessage[] = [];
	/** In-flight wake-turn relays owed to peers. */
	readonly #pendingReplies = new Set<Promise<void>>();
	readonly #pendingRemote = new Map<AgentMessage, number>();
	#pendingRemoteBytes = 0;

	constructor(host: IrcBridgeHost) {
		this.#host = host;
	}

	/** Whether an incoming peer message can interrupt a wait. */
	hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	/** Whether any undelivered IRC record remains queued. */
	hasPending(eligible?: (record: AgentMessage) => boolean): boolean {
		return eligible
			? this.#interrupts.some(eligible) || this.#asides.some(eligible) || this.#deferredWakes.some(eligible)
			: this.#interrupts.length > 0 || this.#asides.length > 0 || this.#deferredWakes.length > 0;
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

	/** Takes every queued IRC record in interrupt-before-aside order. */
	drainPending(): AgentMessage[] {
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
		this.consume([...snapshot.interrupts, ...snapshot.asides, ...snapshot.deferredWakes]);
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
		this.#trackRemote([...snapshot.interrupts, ...snapshot.asides, ...snapshot.deferredWakes]);
	}

	/** Queues records for the next step-boundary aside injection: IRC wakes deferred by a
	 *  session transition, and extension `deliverAs: "aside"` sends. */
	queueAside(records: AgentMessage[]): void {
		this.#asides.push(...records);
		this.#trackRemote(records);
	}

	/** Parks wake-intended records while a pooled contract owns the worker. Unlike
	 *  asides, these are invisible to turn injection (`flushPending`, the loop
	 *  aside poll) and resume into a monitored wake once the contract clears. */
	queueDeferredWake(records: AgentMessage[]): void {
		this.#deferredWakes.push(...records);
		this.#trackRemote(records);
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
				});
				this.consume([record]);
			}
		}
		this.#interrupts = remainingInterrupts;
		this.#asides = remainingAsides;
		return messages;
	}

	#trackRemote(records: AgentMessage[]): void {
		for (const record of records) {
			if (
				this.#pendingRemote.has(record) ||
				record.role !== "custom" ||
				!record.details ||
				typeof record.details !== "object" ||
				Reflect.get(record.details, "remote") !== true
			)
				continue;
			const body = Reflect.get(record.details, "message");
			if (typeof body !== "string") continue;
			const bytes = Buffer.byteLength(body, "utf8");
			this.#pendingRemote.set(record, bytes);
			this.#pendingRemoteBytes += bytes;
			const settle = () => this.consume([record]);
			Object.defineProperties(record, {
				[ASIDE_MESSAGE_COMMIT]: { configurable: true, value: settle },
				[ASIDE_MESSAGE_DISCARD]: { configurable: true, value: settle },
			});
		}
	}

	/** Releases capacity when a pending record reaches context or is discarded. */
	consume(records: AgentMessage[]): void {
		for (const record of records) {
			const bytes = this.#pendingRemote.get(record);
			if (bytes === undefined) continue;
			this.#pendingRemote.delete(record);
			this.#pendingRemoteBytes -= bytes;
		}
	}

	/** Remote admission is shared with the bus's waiter route. */
	admissionError(msg: IrcMessage): string | undefined {
		if (msg.remote !== true) return;
		if (this.#host.isIrcAdmissionBlocked()) {
			return "Recipient is switching or compacting its session; retry shortly.";
		}
		if (
			this.#pendingRemote.size >= 100 ||
			this.#pendingRemoteBytes + Buffer.byteLength(msg.body, "utf8") > 4 * 1024 * 1024
		) {
			return "Recipient has too many pending peer messages (limit 100 messages / 4 MiB); retry later.";
		}
	}

	/** Delivers an IRC message into the recipient session without awaiting any wake turn. */
	async deliver(msg: IrcMessage): Promise<"injected" | "woken"> {
		const rejection = this.admissionError(msg);
		if (rejection) throw new IrcDeliveryRejectedError(rejection);
		if (this.#host.isDisposed()) throw new Error("Recipient session is disposed.");
		const streaming = this.#host.isStreaming();
		const appendIdle = !streaming && (this.#host.planModeEnabled() || msg.noWake === true);
		const fromParent = msg.remote !== true && AgentRegistry.global().get(msg.to)?.parentId === msg.from;
		// Only an executor-installed observer can relay a local idle wake's
		// output back to its sender. Remote wakes never promise that relay.
		const relayOnStop =
			!streaming &&
			!appendIdle &&
			msg.remote !== true &&
			this.#host.hasIrcWakeTurnObserver() &&
			msg.wakeRelay !== true;
		// The body is agent-authored (a peer's message, or a wake relay's
		// `<task-result>` around a subagent's output), so it must not close the
		// harness envelope it is rendered into or open a forged one, e.g. a parent
		// steer. `details.message` keeps the raw body for the transcript card and inbox.
		const envelopeBody = escapeHarnessTags(msg.body);
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(ircIncomingTemplate, {
				from: escapeHarnessTags(msg.from),
				message: envelopeBody,
				replyTo: escapeHarnessTags(msg.replyTo ?? ""),
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
				...(msg.remote !== undefined ? { remote: msg.remote } : {}),
				...(msg.noWake === true ? { noWake: true } : {}),
				...(msg.senderDisplay ? { senderDisplay: msg.senderDisplay } : {}),
				...(fromParent ? { fromParent: true } : {}),
			},
			attribution: "agent",
			timestamp: msg.ts,
		};
		this.#trackRemote([record]);
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
		if (streaming) {
			if (fromParent) {
				this.#host.agent.steer({
					role: "user",
					content: prompt.render(parentIrcSteerTemplate, {
						from: escapeHarnessTags(msg.from),
						message: envelopeBody,
					}),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				});
			} else {
				this.#interrupts.push(record);
			}
			return "injected";
		}
		if (appendIdle) {
			this.consume([record]);
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
		const records = this.drainPending();
		this.consume(records);
		for (const record of records) {
			this.#host.agent.emitExternalEvent({ type: "message_start", message: record });
			this.#host.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}
}
