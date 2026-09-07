import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { IrcBus, type IrcMessage } from "../irc/bus";
import parentIrcSteerTemplate from "../prompts/steering/parent-irc.md" with { type: "text" };
import ircAutoReplyTemplate from "../prompts/system/irc-autoreply.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSessionEvent } from "./agent-session-events";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Capabilities the IRC bridge borrows from its owning session. */
export interface IrcBridgeHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	isDisposed(): boolean;
	isStreaming(): boolean;
	planModeEnabled(): boolean;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	wakeForIrc(records: AgentMessage[]): void;
	runEphemeralTurn(args: { promptText: string }): Promise<{ replyText: string }>;
}

/** Owns incoming IRC queues, the session's non-interrupting aside queue, injection, and side-channel auto-replies. */
export class IrcBridge {
	readonly #host: IrcBridgeHost;
	#interrupts: AgentMessage[] = [];
	#asides: AgentMessage[] = [];
	/** In-flight replies owed to peers: side-channel auto-replies and wake-turn relays. */
	readonly #pendingReplies = new Set<Promise<void>>();

	constructor(host: IrcBridgeHost) {
		this.#host = host;
	}

	/** Whether an incoming peer message can interrupt a wait. */
	hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	/** Whether any undelivered IRC record remains queued. */
	hasPending(): boolean {
		return this.#interrupts.length > 0 || this.#asides.length > 0;
	}

	/**
	 * Waits until every reply this session still owes a peer has settled. A
	 * peer awaiting an answer (`send await:true`) holds its "stopped without
	 * replying" verdict on this, so a reply produced after the terminal
	 * `agent_end` still resolves the waiter.
	 */
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
	 *  ordinary prompt's `flushPending()`. Pass the snapshot to `restorePending` to undo the clear
	 *  if the transition is rolled back. */
	clearPending(): { interrupts: AgentMessage[]; asides: AgentMessage[] } {
		const snapshot = { interrupts: this.#interrupts, asides: this.#asides };
		this.#interrupts = [];
		this.#asides = [];
		return snapshot;
	}

	/** Restores a snapshot taken by `clearPending`, for a rolled-back session transition. Merges
	 *  ahead of whatever queued in the meantime (e.g. an in-flight IRC auto-reply appending while
	 *  the rolled-back switch's async load/hooks were still running) instead of overwriting it, so
	 *  those newly arrived records aren't silently discarded — snapshot records precede them since
	 *  they arrived first. */
	restorePending(snapshot: { interrupts: AgentMessage[]; asides: AgentMessage[] }): void {
		this.#interrupts = [...snapshot.interrupts, ...this.#interrupts];
		this.#asides = [...snapshot.asides, ...this.#asides];
	}

	/** Queues records for the next step-boundary aside injection: IRC wakes deferred by a
	 *  session transition, and extension `deliverAs: "aside"` sends. */
	queueAside(records: AgentMessage[]): void {
		this.#asides.push(...records);
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
			}
		}
		this.#interrupts = remainingInterrupts;
		this.#asides = remainingAsides;
		return messages;
	}

	/** Delivers an IRC message into the recipient session without awaiting any wake turn. */
	async deliver(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#host.isDisposed()) throw new Error("Recipient session is disposed.");
		const streaming = this.#host.isStreaming();
		const planModeIdle = !streaming && this.#host.planModeEnabled();
		const autoReply =
			(opts?.expectsReply ?? false) && ((streaming && !this.#host.settings.get("async.enabled")) || planModeIdle);
		// An idle subagent runs a monitored wake turn whose output is relayed
		// back to the sender (task executor `relayWakeTurnOutput`); the main
		// agent and mid-turn asides have no such relay.
		const relayOnStop = !streaming && !planModeIdle && msg.to !== MAIN_AGENT_ID && msg.wakeRelay !== true;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(ircIncomingTemplate, {
				from: msg.from,
				message: msg.body,
				replyTo: msg.replyTo ?? "",
				autoReplied: autoReply,
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
			},
			attribution: "agent",
			timestamp: msg.ts,
		};
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
		if (streaming) {
			const recipientParentId = AgentRegistry.global().get(msg.to)?.parentId;
			if (recipientParentId === msg.from) {
				this.#host.agent.steer({
					role: "user",
					content: prompt.render(parentIrcSteerTemplate, { from: msg.from, message: msg.body }),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				});
			} else {
				this.#interrupts.push(record);
			}
			if (autoReply) this.#startAutoReply(msg);
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
			if (autoReply) this.#startAutoReply(msg);
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

	#startAutoReply(msg: IrcMessage): void {
		this.trackReply(this.#runAutoReply(msg));
	}

	async #runAutoReply(msg: IrcMessage): Promise<void> {
		try {
			const { replyText } = await this.#host.runEphemeralTurn({
				promptText: prompt.render(ircAutoReplyTemplate, {
					from: msg.from,
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const body = replyText.trim();
			if (!body || this.#host.isDisposed()) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			void this.#host.emitSessionEvent({ type: "irc_message", message: record });
			this.#asides.push(record);
			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: String(error) });
		}
	}
}
