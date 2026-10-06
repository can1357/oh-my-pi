import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { escapePeerText } from "../session/harness-tags";
import type { SessionTitleSource } from "../session/session-entries";
import { droppedMessageText, IdleSubscriptions } from "./idle";
import { InboundGate, type OutgoingNotice } from "./inbound";
import { drainOffline, enqueueOffline, listOfflineSessions, type OfflineSession } from "./mailbox";
import { isReservedAddress, sessionAddress, sessionShortId } from "./names";
import { type PermissionClass, resolveInbound } from "./policy";
import {
	type InboxRequest,
	type InboxResponse,
	MAX_SERIALIZED_CHARS,
	MESSAGING_WIRE_VERSION,
	type SenderInfo,
	SNAPSHOT_TIMEOUT_MS,
} from "./protocol";
import { cfgMessagingList, cfgMessagingRateLimit, cfgMessagingRateWindowSeconds, cfgMessagingSend } from "./settings";
import {
	type InboxAuth,
	type InboxEntry,
	type InboxPublication,
	listInboxEntries,
	publishInbox,
	requestInbox,
} from "./transport";

export { MessagingUnavailableError } from "./protocol";

export interface RemoteSender {
	name: string | null;
	shortId: string;
	address: string;
	cwd: string;
}
export interface RemoteDelivery {
	id: string;
	from: RemoteSender;
	body: string;
	chain: readonly string[];
	receivedAt: number;
}
export interface HeldMessageView {
	from: RemoteSender;
	body: string;
}
export interface SessionListing {
	name: string | null;
	shortId: string;
	title: string | null;
	cwd: string;
	busy: boolean;
	entry: InboxEntry;
}
export type SessionCandidate = { name: string | null; shortId: string; cwd: string };
export type SessionResolution =
	| { kind: "found"; target: SessionListing }
	| { kind: "offline"; target: OfflineSession }
	| { kind: "incompatible"; name: string }
	| { kind: "self" }
	| { kind: "none" }
	| { kind: "ambiguous"; candidates: SessionCandidate[] };
export interface SendOutcome {
	ok: boolean;
	text: string;
}
export interface MessagingHost {
	sessionId(): string;
	cwd(): string;
	directPrint: boolean;
	sessionName(): string | undefined;
	titleSource(): SessionTitleSource | undefined;
	isBusy(): boolean;
	permissionClass(): PermissionClass;
	onPolicyInputsChange(cb: () => void): () => void;
	deliverRemote(d: RemoteDelivery): void;
	pendingRemoteCount(): number;
	showNotice(text: string): void;
	deliverNotice(from: RemoteSender, text: string): void;
	askApproval: ((v: HeldMessageView, signal: AbortSignal) => Promise<"approve" | "deny" | undefined>) | undefined;
	currentRelayChain(): readonly string[];
	lastFinished(): { finishedAt: number; status: string | null } | undefined;
}

type BufferedDelivery =
	| { type: "message"; delivery: RemoteDelivery }
	| { type: "notice"; from: RemoteSender; text: string };

export class MessagingService {
	#publication!: InboxPublication;
	#ready = false;
	#suspended = 0;
	#closed = false;
	#closing: Promise<void> | undefined;
	readonly #buffer: BufferedDelivery[] = [];
	readonly #sent = new Map<string, number[]>();
	readonly #outgoing = new Map<string, { entryId?: string; shortId: string }>();
	readonly #gate: InboundGate;
	readonly #idle: IdleSubscriptions;
	readonly #unsubscribe: () => void;
	readonly #startedAt = Date.now();

	constructor(
		private readonly host: MessagingHost,
		private readonly settings: Settings,
	) {
		const receivingHost: MessagingHost = {
			...host,
			sessionId: () => host.sessionId(),
			cwd: () => host.cwd(),
			sessionName: () => host.sessionName(),
			titleSource: () => host.titleSource(),
			isBusy: () => host.isBusy(),
			permissionClass: () => host.permissionClass(),
			onPolicyInputsChange: cb => host.onPolicyInputsChange(cb),
			pendingRemoteCount: () =>
				host.pendingRemoteCount() + this.#buffer.filter(item => item.type === "message").length,
			deliverRemote: delivery => this.#deliver({ type: "message", delivery }),
			deliverNotice: (from, text) => this.#deliver({ type: "notice", from, text }),
			showNotice: text => host.showNotice(text),
			askApproval: host.askApproval ? (view, signal) => host.askApproval!(view, signal) : undefined,
			currentRelayChain: () => host.currentRelayChain(),
			lastFinished: () => host.lastFinished(),
		};
		this.#gate = new InboundGate(
			receivingHost,
			settings,
			() => this.ownShortId(),
			(sender, notice, from) => this.#reply(sender, notice, from),
			() => this.#ready,
			() => this.#sender(),
		);
		this.#idle = new IdleSubscriptions(
			receivingHost,
			sender => this.#gate.decision(sender),
			(sender, notice, from) => this.#reply(sender, notice, from),
			() => this.#sender(),
		);
		this.#unsubscribe = host.onPolicyInputsChange(() => this.#gate.reapplyPolicy());
	}

	static async start(host: MessagingHost, settings: Settings): Promise<MessagingService> {
		const service = new MessagingService(host, settings);
		try {
			service.#publication = await publishInbox((request, auth) => service.#receive(request, auth));
			await service.#deliverOfflineMail();
			return service;
		} catch (error) {
			service.#unsubscribe();
			service.#gate.close();
			await service.#idle.close();
			await service.#publication?.close();
			throw error;
		}
	}

	get env(): Readonly<{ OMP_MESSAGING_SOCKET: string; OMP_MESSAGING_TOKEN: string }> {
		return { OMP_MESSAGING_SOCKET: this.#publication.endpoint, OMP_MESSAGING_TOKEN: this.#publication.token };
	}

	get peerAddress(): string {
		return `${process.platform === "win32" ? "pipe" : "uds"}:${this.#publication.endpoint}`;
	}

	markReady(): void {
		this.#ready = true;
		this.#flush();
	}

	suspendReceiving(): () => void {
		this.#suspended++;
		let resumed = false;
		return () => {
			if (resumed) return;
			resumed = true;
			this.#suspended--;
			this.#flush();
		};
	}

	#deliver(item: BufferedDelivery): void {
		if (this.#closed) return;
		if (!this.#ready || this.#suspended > 0) this.#buffer.push(item);
		else if (item.type === "message") this.host.deliverRemote(item.delivery);
		else this.host.deliverNotice(item.from, item.text);
	}

	#flush(): void {
		if (!this.#ready || this.#suspended > 0 || this.#closed) return;
		while (this.#buffer.length > 0 && this.#suspended === 0) this.#deliver(this.#buffer.shift()!);
	}

	ownAddress(): string | null {
		return sessionAddress({
			cwd: this.host.cwd(),
			sessionId: this.host.sessionId(),
			sessionName: this.host.sessionName(),
			titleSource: this.host.titleSource(),
			directPrint: this.host.directPrint,
		});
	}

	ownShortId(): string {
		return sessionShortId(this.host.sessionId());
	}

	#sender(): SenderInfo {
		return {
			name: this.ownAddress(),
			shortId: this.ownShortId(),
			cwd: this.host.cwd(),
			entryId: this.#publication.entryId,
			class: this.host.permissionClass(),
		};
	}

	async #sessions(signal?: AbortSignal): Promise<{
		compatible: SessionListing[];
		incompatible: SessionCandidate[];
		liveShortIds: Set<string>;
	}> {
		const entries = await listInboxEntries({ signal });
		const compatible: SessionListing[] = [];
		const incompatible: SessionCandidate[] = [];
		const liveShortIds = new Set<string>();
		await Promise.all(
			entries
				.filter(entry => entry.entryId !== this.#publication.entryId)
				.map(async entry => {
					const result = await requestInbox(entry, { type: "snapshot" }, { signal });
					if (!result.ok || !("snapshot" in result)) return;
					const { name, shortId, title, cwd, busy, v } = result.snapshot;
					liveShortIds.add(shortId);
					if (entry.version !== MESSAGING_WIRE_VERSION || v !== MESSAGING_WIRE_VERSION)
						incompatible.push({ name, shortId, cwd });
					else compatible.push({ name, shortId, title, cwd, busy, entry });
				}),
		);
		return { compatible, incompatible, liveShortIds };
	}

	async listSessions(signal?: AbortSignal): Promise<SessionListing[]> {
		return cfgMessagingList.get(this.settings) === "deny" ? [] : (await this.#sessions(signal)).compatible;
	}

	async resolve(to: string, signal?: AbortSignal): Promise<SessionResolution> {
		if (isReservedAddress(to)) return { kind: "none" };
		if (to === this.ownAddress() || to === this.ownShortId()) return { kind: "self" };
		const sessions = await this.#sessions(signal);
		const candidates = sessions.compatible.filter(session => session.name === to || session.shortId === to);
		if (candidates.length > 1) return { kind: "ambiguous", candidates };
		if (candidates.length === 1) return { kind: "found", target: candidates[0] };
		if (sessions.incompatible.some(session => session.name === to || session.shortId === to))
			return { kind: "incompatible", name: to };
		const offline = (await listOfflineSessions()).filter(
			session =>
				session.sessionId !== this.host.sessionId() &&
				!sessions.liveShortIds.has(session.shortId) &&
				(session.name === to || session.shortId === to),
		);
		if (offline.length > 1) return { kind: "ambiguous", candidates: offline };
		return offline.length === 1 ? { kind: "offline", target: offline[0] } : { kind: "none" };
	}

	async send(
		target: SessionListing | OfflineSession,
		body: string,
		opts: { notifyWhenIdle: boolean; signal?: AbortSignal },
	): Promise<SendOutcome> {
		if (cfgMessagingSend.get(this.settings) === "deny")
			return { ok: false, text: "Not sent: sending to other sessions is turned off (messaging.send)." };
		const notifyWhenIdle = opts.notifyWhenIdle && resolveInbound(this.settings).value !== "refuse";
		const idleNoticeSkipped =
			opts.notifyWhenIdle && !notifyWhenIdle
				? " No idle notification was requested because this session refuses inbound messages."
				: "";
		if (!body.trim() && idleNoticeSkipped)
			return {
				ok: false,
				text: "Not sent: cannot subscribe to idle notices while this session refuses inbound messages.",
			};
		if (!("entry" in target)) {
			const sessions = await this.#sessions(opts.signal);
			const shortId = target.shortId;
			const live = sessions.compatible.find(session => session.shortId === shortId);
			if (live) target = live;
			else if (sessions.incompatible.some(session => session.shortId === shortId))
				return {
					ok: false,
					text: `Not sent: ${target.name ?? shortId} runs an incompatible omp version.`,
				};
		}
		const address = target.name ?? target.shortId;
		if (!body.trim() && !opts.notifyWhenIdle) return { ok: false, text: "empty" };
		const id = crypto.randomUUID();
		const request: InboxRequest = !body.trim()
			? { type: "subscribe", id, from: this.#sender() }
			: {
					type: "message",
					id,
					from: this.#sender(),
					body,
					chain: [...this.host.currentRelayChain(), this.ownShortId()],
					notifyWhenIdle,
				};
		const size = JSON.stringify(request).length;
		if (size > MAX_SERIALIZED_CHARS)
			return {
				ok: false,
				text: `Failed to send to ${address}: Message too large for cross-session delivery: the serialized message is ${size} characters and the limit is 1,048,576. Shorten the message text — put bulk content in a file the recipient can read rather than in the message — or split it into smaller messages.`,
			};
		const now = Date.now();
		const targetId = "entry" in target ? target.entry.entryId : target.sessionId;
		const sent = (this.#sent.get(targetId) ?? []).filter(
			at => at > now - cfgMessagingRateWindowSeconds.get(this.settings) * 1000,
		);
		this.#sent.set(targetId, sent);
		if (sent.length >= cfgMessagingRateLimit.get(this.settings))
			return {
				ok: false,
				text: `Failed to send to ${address}: Too many messages to this session just now: ${sent.length} were sent recently and more would be dropped by its rate limit, so this one was not sent. Batch what remains into one message, or wait a little before sending more.`,
			};
		if (!("entry" in target)) {
			if (notifyWhenIdle)
				return {
					ok: false,
					text: `Not sent: notify=idle needs a running session; ${address} is not running.`,
				};
			if (request.type !== "message") return { ok: false, text: "empty" };
			sent.push(now);
			this.#outgoing.set(id, { shortId: target.shortId });
			const outcome = await enqueueOffline(target.sessionId, {
				id,
				from: request.from!,
				body,
				chain: request.chain ?? [],
				sentAt: now,
			});
			if (outcome === "full") {
				this.#outgoing.delete(id);
				const recent = this.#sent.get(targetId);
				const index = recent?.indexOf(now) ?? -1;
				if (index >= 0) recent!.splice(index, 1);
				return { ok: false, text: `Not sent: ${address}'s offline inbox is full (50 messages).` };
			}
			return {
				ok: true,
				text: `Queued for ${address} (not running); it will see this when resumed.${idleNoticeSkipped}`,
			};
		}
		if (target.entry.version !== MESSAGING_WIRE_VERSION)
			return { ok: false, text: `Not sent: ${address} runs an incompatible omp version.` };
		const remote: RemoteSender = { name: target.name, shortId: target.shortId, address, cwd: target.cwd };
		this.#outgoing.set(id, { entryId: target.entry.entryId, shortId: target.shortId });
		if (notifyWhenIdle) this.#idle.arm(target.entry.entryId, remote, id);
		sent.push(now);
		const result = await requestInbox(target.entry, request, { signal: opts.signal });
		if (!result.ok || "snapshot" in result) {
			this.#outgoing.delete(id);
			this.#idle.cancel(target.entry.entryId, id);
			const recent = this.#sent.get(target.entry.entryId);
			const index = recent?.indexOf(now) ?? -1;
			if (index >= 0) recent!.splice(index, 1);
			const error = !result.ok ? result.error : "Unexpected snapshot response";
			return {
				ok: false,
				text: `Failed to send to ${address}: ${error === "unreachable" ? "the session is no longer running." : error}`,
			};
		}
		if (result.outcome !== "held") this.#outgoing.delete(id);
		if (result.outcome === "refused" || result.outcome === "dropped") this.#idle.cancel(target.entry.entryId, id);
		switch (result.outcome) {
			case "delivered":
				return { ok: true, text: `Delivered to ${address}.${idleNoticeSkipped}` };
			case "queued":
				return {
					ok: true,
					text: `Queued for ${address} (busy; it will read this at its next step).${idleNoticeSkipped}`,
				};
			case "held":
				return { ok: true, text: `Held by ${address} for its user's approval.${idleNoticeSkipped}` };
			case "refused":
				return { ok: false, text: `Not sent: ${address} refused the message.` };
			case "subscribed":
				return { ok: true, text: `Will notify you when ${address} is next idle.` };
			case "dropped":
				return { ok: false, text: droppedMessageText(address, result.reason) };
		}
	}

	async #receive(request: InboxRequest, auth: InboxAuth): Promise<InboxResponse> {
		if (this.#closed) return { ok: false, error: "unreachable" };
		if (JSON.stringify(request).length > MAX_SERIALIZED_CHARS) return { ok: false, error: "too_large" };
		if (request.type === "snapshot")
			return {
				ok: true,
				snapshot: {
					v: MESSAGING_WIRE_VERSION,
					name: this.ownAddress(),
					shortId: this.ownShortId(),
					title: this.host.sessionName() ?? null,
					cwd: this.host.cwd(),
					busy: this.host.isBusy(),
					pid: process.pid,
					startedAt: this.#startedAt,
				},
			};
		if (request.type === "message") {
			if (!request.body.trim()) {
				if (!request.notifyWhenIdle) return { ok: false, error: "empty" };
				if (request.from) this.#idle.subscribe(request.from, request.id);
				return { ok: true, outcome: "subscribed" };
			}
			const sender = request.from ?? { ...this.#sender(), name: "own-child" };
			const result = this.#gate.receive(request, sender, auth === "own-child");
			if (
				request.notifyWhenIdle &&
				request.from &&
				result.ok &&
				"outcome" in result &&
				(result.outcome === "held" ||
					result.outcome === "delivered" ||
					result.outcome === "queued" ||
					result.outcome === "refused")
			)
				this.#idle.subscribe(request.from, request.id);
			return result;
		}
		if (request.type === "subscribe") {
			this.#idle.subscribe(request.from, request.id);
			return { ok: true, outcome: "subscribed" };
		}
		if (
			request.kind === "expired" ||
			request.kind === "dropped" ||
			(request.kind === "retired" && request.subject === "message")
		) {
			const outgoing = request.aboutId === undefined ? undefined : this.#outgoing.get(request.aboutId);
			if (
				outgoing &&
				(outgoing.entryId === request.from.entryId ||
					(outgoing.entryId === undefined && outgoing.shortId === request.from.shortId))
			) {
				this.#outgoing.delete(request.aboutId!);
				const from = {
					name: request.from.name,
					shortId: request.from.shortId,
					address: request.from.name ?? request.from.shortId,
					cwd: request.from.cwd,
				};
				if (request.kind === "expired")
					this.#deliver({
						type: "notice",
						from,
						text: `Your message to @${from.address} expired before its user approved it.`,
					});
				else if (request.kind === "retired")
					this.#deliver({
						type: "notice",
						from,
						text: `Your message to @${from.address} was dropped unread: that session switched to a different conversation.`,
					});
				else if (request.reason)
					this.#deliver({ type: "notice", from, text: droppedMessageText(from.address, request.reason) });
			}
		} else this.#idle.receive(request);
		return { ok: true, outcome: "delivered" };
	}

	async #reply(sender: SenderInfo, notice: OutgoingNotice, from = this.#sender()): Promise<void> {
		try {
			const entry = (await listInboxEntries()).find(item => item.entryId === sender.entryId);
			if (!entry || entry.entryId === this.#publication.entryId || entry.version !== MESSAGING_WIRE_VERSION) return;
			await requestInbox(entry, { ...notice, id: crypto.randomUUID(), from }, { timeoutMs: SNAPSHOT_TIMEOUT_MS });
		} catch (error) {
			logger.warn("Messaging notice failed", { error: String(error) });
		}
	}
	async retireConversation(): Promise<void> {
		if (this.#closed) return;
		this.#outgoing.clear();
		await Promise.all([this.#gate.retire(), this.#idle.retire()]);
		await this.#deliverOfflineMail();
	}

	async #deliverOfflineMail(): Promise<void> {
		let admitted = 0;
		for (const { message, ack } of await drainOffline(this.host.sessionId())) {
			const result = this.#gate.receiveOffline(message);
			if (
				result.ok &&
				"outcome" in result &&
				(result.outcome === "delivered" || result.outcome === "queued" || result.outcome === "held")
			) {
				await ack();
				admitted++;
			} else if (
				result.ok &&
				"outcome" in result &&
				(result.outcome === "refused" || (result.outcome === "dropped" && result.reason !== "queue_full"))
			) {
				if (result.outcome === "dropped")
					await this.#reply(message.from, {
						type: "notice",
						kind: "dropped",
						reason: result.reason,
						aboutId: message.id,
					});
				await ack();
			}
		}
		if (admitted > 0)
			this.host.showNotice(`${admitted} message(s) from other sessions arrived while this session was not running.`);
	}

	turnSettledIdle(): void {
		this.#idle.turnSettledIdle();
	}

	close(): Promise<void> {
		return (this.#closing ??= this.#close());
	}

	async #close(): Promise<void> {
		this.#closed = true;
		this.#unsubscribe();
		this.#gate.close();
		await this.#idle.close();
		this.#buffer.length = 0;
		this.#outgoing.clear();
		this.#sent.clear();
		await this.#publication.close();
	}
}

export function formatSessionListing(sessions: SessionListing[]): string {
	const field = (text: string) => escapePeerText(text).replace(/[\r\n]/g, " ");
	return [
		"## Other sessions",
		...sessions.map(
			session =>
				`- ${field(session.name ?? "(unnamed)")} [${session.shortId}] ${session.busy ? "busy" : "idle"} — ${field(session.cwd)}${session.title === null ? "" : ` — "${field(session.title)}"`}`,
		),
	].join("\n");
}
