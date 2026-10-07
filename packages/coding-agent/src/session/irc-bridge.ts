import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import parentIrcSteerTemplate from "../prompts/steering/parent-irc.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { normalizeToolName } from "../tools/builtin-names";
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

interface IrcPendingSnapshot {
	interrupts: AgentMessage[];
	asides: AgentMessage[];
	deferredWakes: AgentMessage[];
	sessionId: string | undefined;
	received: Map<string, Set<string>>;
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
	/** Accepted transport identities, not interpreted request/control state. */
	readonly #received = new Map<string, Set<string>>();
	#indexedSessionId: string | undefined;
	#indexedLeafId: string | null | undefined;
	#indexedEntryCount = 0;

	constructor(host: IrcBridgeHost) {
		this.#host = host;
	}

	#rememberIncoming(details: unknown): void {
		if (!details || typeof details !== "object") return;
		const id = Reflect.get(details, "id");
		const from = Reflect.get(details, "from");
		if (typeof id !== "string" || typeof from !== "string") return;
		let ids = this.#received.get(from);
		if (!ids) {
			ids = new Set();
			this.#received.set(from, ids);
		}
		ids.add(id);
	}

	#rememberRecord(record: AgentMessage): void {
		if (record.role === "custom" && record.customType === "irc:incoming") {
			this.#rememberIncoming(record.details);
		} else if (record.role === "toolResult") {
			const toolName = normalizeToolName(record.toolName);
			let details = record.details;
			if (toolName === "write" && isRecord(details) && isRecord(details.xdev)) {
				const dispatch = details.xdev;
				if (
					dispatch.mode !== "execute" ||
					typeof dispatch.tool !== "string" ||
					normalizeToolName(dispatch.tool) !== "wait"
				) return;
				details = dispatch.inner;
			} else if (toolName !== "wait") return;
			if (isRecord(details) && details.op === "wait") this.#rememberIncoming(details.waited);
		}
	}

	/** Index the whole durable journal, including compacted/abandoned branches.
	 * Outgoing agent state must not poison the incoming session's ledger. */
	#indexReceived(): void {
		const sessionId = this.#host.sessionManager.getSessionId();
		const leafId = this.#host.sessionManager.getLeafId();
		const entries = this.#host.sessionManager.getEntries();
		const changedSession = this.#indexedSessionId !== sessionId;
		if (!changedSession && this.#indexedLeafId === leafId && this.#indexedEntryCount === entries.length) return;
		if (changedSession) {
			this.#received.clear();
			this.#indexedEntryCount = 0;
		}
		if (this.#indexedEntryCount > entries.length) this.#indexedEntryCount = 0;
		for (let index = this.#indexedEntryCount; index < entries.length; index++) {
			const entry = entries[index];
			if (entry.type === "custom_message" && entry.customType === "irc:incoming") {
				this.#rememberIncoming(entry.details);
			} else if (entry.type === "message") this.#rememberRecord(entry.message);
		}
		this.#indexedEntryCount = entries.length;
		if (changedSession) {
			// Transition clears these before changing manager ID; rollback restores
			// the outgoing session's accepted pending records.
			for (const records of [this.#interrupts, this.#asides, this.#deferredWakes]) {
				for (const record of records) this.#rememberRecord(record);
			}
		}
		this.#indexedSessionId = sessionId;
		this.#indexedLeafId = leafId;
	}

	/** Whether an incoming peer message can interrupt a wait. */
	hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	/** Whether any undelivered IRC record remains queued. */
	hasPending(): boolean {
		return this.#interrupts.length > 0 || this.#asides.length > 0 || this.#deferredWakes.length > 0;
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
	clearPending(): IrcPendingSnapshot {
		const received = new Map<string, Set<string>>();
		for (const [sender, ids] of this.#received) received.set(sender, new Set(ids));
		const snapshot: IrcPendingSnapshot = {
			interrupts: this.#interrupts, asides: this.#asides, deferredWakes: this.#deferredWakes,
			sessionId: this.#indexedSessionId, received,
		};
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
	restorePending(snapshot: IrcPendingSnapshot): void {
		this.#interrupts = [...snapshot.interrupts, ...this.#interrupts];
		this.#asides = [...snapshot.asides, ...this.#asides];
		this.#deferredWakes = [...snapshot.deferredWakes, ...this.#deferredWakes];
		if (snapshot.sessionId !== undefined) {
			this.#indexReceived();
			if (snapshot.sessionId === this.#indexedSessionId) {
				for (const [sender, ids] of snapshot.received) {
					let accepted = this.#received.get(sender);
					if (!accepted) {
						accepted = new Set();
						this.#received.set(sender, accepted);
					}
					for (const id of ids) accepted.add(id);
				}
			}
		}
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
				const to = Reflect.get(details, "to");
				const ts = Reflect.get(details, "ts");
				const wakeRelay = Reflect.get(details, "wakeRelay");
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
					to: typeof to === "string" ? to : agentId,
					body,
					ts: typeof ts === "number" ? ts : record.timestamp,
					...(typeof replyTo === "string" ? { replyTo } : {}),
					...(wakeRelay === true ? { wakeRelay: true } : {}),
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
		this.#indexReceived();
		if (this.#received.get(msg.from)?.has(msg.id)) return "injected";
		const streaming = this.#host.isStreaming();
		const planModeIdle = !streaming && this.#host.planModeEnabled();
		const fromParent = AgentRegistry.global().get(msg.to)?.parentId === msg.from;
		// An idle subagent runs a monitored wake turn whose output is relayed
		// back to the sender (task executor `relayWakeTurnOutput`); the main
		// agent and mid-turn asides have no such relay.
		const relayOnStop = !streaming && !planModeIdle && msg.to !== MAIN_AGENT_ID && msg.wakeRelay !== true;
		// The body is agent-authored (a peer's message, or a wake relay's
		// `<task-result>` around a subagent's output), so it must not close the
		// harness envelope it is rendered into or open a forged one, e.g. a parent
		// steer. `details.message` keeps the raw body for the transcript card and inbox.
		const envelopeBody = escapeHarnessTags(msg.body);
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(streaming && fromParent ? parentIrcSteerTemplate : ircIncomingTemplate, {
				from: msg.from,
				message: envelopeBody,
				replyTo: msg.replyTo ?? "",
				interrupting: streaming,
				relayOnStop,
			}),
			display: true,
			details: {
				id: msg.id,
				from: msg.from,
				to: msg.to,
				ts: msg.ts,
				message: msg.body,
				...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
				...(msg.wakeRelay ? { wakeRelay: true } : {}),
				...(fromParent ? { fromParent: true } : {}),
			},
			attribution: "agent",
			timestamp: msg.ts,
		};
		if (streaming && fromParent) record.steeringSource = "agent";
		this.#rememberIncoming(record.details);
		try {
			if (streaming) {
				if (fromParent) this.#host.agent.steer(record);
				else this.#interrupts.push(record);
			} else if (planModeIdle) {
				this.#host.agent.appendMessage(record);
				this.#host.sessionManager.appendCustomMessageEntry(
					record.customType,
					record.content,
					record.display,
					record.details,
					record.attribution ?? "agent",
					record.timestamp,
					record.steeringSource,
				);
			} else {
				this.#host.wakeForIrc([record]);
			}
		} catch (error) {
			this.#received.get(msg.from)?.delete(msg.id);
			throw error;
		}
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
		return streaming || planModeIdle ? "injected" : "woken";
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
