import { logger } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import type { Settings } from "../config/settings";
import { escapePeerText } from "../session/harness-tags";
import type { SessionTitleSource } from "../session/session-entries";
import { droppedMessageText, IdleSubscriptions } from "./idle";
import { InboundGate, type OutgoingNotice } from "./inbound";
import {
	drainOffline,
	drainOfflineUnlocked,
	enqueueOfflineUnlocked,
	listOfflineSessions,
	withOfflineMailboxLock,
	type DrainedMail,
	type OfflineSession,
	type StoredMessage,
	type StoredRefusalNotice,
} from "./mailbox";
import { isReservedAddress, sessionAddress, sessionShortId } from "./names";
import { type PermissionClass, resolveInbound } from "./policy";
import {
	type InboxRequest,
	type InboxResponse,
	MAX_SERIALIZED_CHARS,
	MESSAGING_WIRE_VERSION,
	type SenderInfo,
	type SessionSnapshot,
	SNAPSHOT_TIMEOUT_MS,
} from "./protocol";
import { cfgMessagingList, cfgMessagingRateLimit, cfgMessagingRateWindowSeconds, cfgMessagingSend } from "./settings";
import {
	type InboxAuth,
	type InboxEntry,
	type InboxPublication,
	listInboxEntries,
	publishInbox,
	readInboxEntries,
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
	sessionId: string;
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
	deliverRemote(deliveries: readonly RemoteDelivery[]): void;
	pendingRemoteCount(): number;
	showNotice(text: string): void;
	deliverNotice(from: RemoteSender, text: string): void;
	askApproval: ((v: HeldMessageView, signal: AbortSignal) => Promise<"approve" | "deny" | undefined>) | undefined;
	currentRelayChain(): readonly string[];
	lastFinished(): { finishedAt: number; status: string | null } | undefined;
}

type BufferedDelivery =
	| { type: "message"; delivery: RemoteDelivery }
	| { type: "notice"; from: RemoteSender; text: string }
	| { type: "receipt"; text: string };

export class MessagingService {
	#publication!: InboxPublication;
	#ready = false;
	#suspended = 0;
	#suspendedIdentity: Pick<SessionSnapshot, "sessionId" | "name" | "title" | "cwd"> | undefined;
	#closed = false;
	#batching = 0;
	#closing: Promise<void> | undefined;
	readonly #buffer: BufferedDelivery[] = [];
	readonly #sent = new Map<string, number[]>();
	readonly #outgoing = new Map<string, { entryId?: string; sessionId: string }>();
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
			deliverRemote: deliveries => {
				for (const delivery of deliveries) this.#deliver({ type: "message", delivery });
			},
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
		this.#unsubscribe = host.onPolicyInputsChange(() => {
			this.#batching++;
			try {
				this.#gate.reapplyPolicy();
			} finally {
				this.#batching--;
				this.#flush();
			}
		});
	}

	static async start(host: MessagingHost, settings: Settings): Promise<MessagingService> {
		const service = new MessagingService(host, settings);
		try {
			service.#publication = await publishInbox((request, auth) => service.#receive(request, auth), {
				sessionId: host.sessionId(),
			});
			const mail = await withOfflineMailboxLock(
				host.sessionId(),
				() => drainOfflineUnlocked(host.sessionId(), { dir: service.#publication.registryDir }),
				{ dir: service.#publication.registryDir },
			);
			await service.#deliverOfflineMail(mail);
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
		if (this.#suspended === 0) {
			this.#suspendedIdentity = {
				sessionId: this.host.sessionId(),
				name: this.ownAddress(),
				title: this.host.sessionName() ?? null,
				cwd: this.host.cwd(),
			};
		}
		this.#suspended++;
		let resumed = false;
		return () => {
			if (resumed) return;
			resumed = true;
			this.#suspended--;
			if (this.#suspended === 0) {
				const previous = this.#suspendedIdentity;
				this.#suspendedIdentity = undefined;
				if (previous && previous.sessionId !== this.host.sessionId())
					void this.retireConversation().catch(error =>
						logger.warn("Failed to retire cross-session conversation", { error: String(error) }),
					);
			}
			this.#flush();
		};
	}

	#deliver(item: BufferedDelivery): void {
		if (this.#closed) return;
		if (!this.#ready || this.#suspended > 0 || this.#batching > 0) this.#buffer.push(item);
		else if (item.type === "message") this.host.deliverRemote([item.delivery]);
		else if (item.type === "receipt") this.host.showNotice(item.text);
		else this.host.deliverNotice(item.from, item.text);
	}

	#flush(): void {
		if (!this.#ready || this.#suspended > 0 || this.#batching > 0 || this.#closed) return;
		while (this.#buffer.length > 0 && this.#suspended === 0) {
			const item = this.#buffer.shift()!;
			if (item.type !== "message") {
				this.#deliver(item);
				continue;
			}
			const deliveries = [item.delivery];
			while (this.#buffer[0]?.type === "message")
				deliveries.push((this.#buffer.shift()! as Extract<BufferedDelivery, { type: "message" }>).delivery);
			this.host.deliverRemote(deliveries);
		}
	}

	ownAddress(): string | null {
		if (this.#suspendedIdentity) return this.#suspendedIdentity.name;
		return sessionAddress({
			cwd: this.host.cwd(),
			sessionId: this.host.sessionId(),
			sessionName: this.host.sessionName(),
			titleSource: this.host.titleSource(),
			directPrint: this.host.directPrint,
		});
	}

	ownShortId(): string {
		return sessionShortId(this.#ownSessionId());
	}

	#ownSessionId(): string {
		return this.#suspendedIdentity?.sessionId ?? this.host.sessionId();
	}

	#sender(): SenderInfo {
		return {
			sessionId: this.#ownSessionId(),
			name: this.ownAddress(),
			shortId: this.ownShortId(),
			cwd: this.#suspendedIdentity?.cwd ?? this.host.cwd(),
			entryId: this.#publication.entryId,
			class: this.host.permissionClass(),
		};
	}

	async #sessions(signal?: AbortSignal): Promise<{
		compatible: SessionListing[];
		incompatible: (SessionCandidate & { sessionId: string })[];
		liveSessionIds: Set<string>;
	}> {
		const dir = this.#publication.registryDir;
		const entries = await listInboxEntries({ dir, signal });
		const compatible: SessionListing[] = [];
		const incompatible: (SessionCandidate & { sessionId: string })[] = [];
		const liveSessionIds = new Set<string>();
		await Promise.all(
			entries
				.filter(entry => entry.entryId !== this.#publication.entryId)
				.map(async entry => {
					const result = await requestInbox(entry, { type: "snapshot" }, { dir, signal });
					if (!result.ok || !("snapshot" in result)) return;
					const { sessionId, name, shortId, title, cwd, busy, v } = result.snapshot;
					liveSessionIds.add(sessionId);
					if (entry.version !== MESSAGING_WIRE_VERSION || v !== MESSAGING_WIRE_VERSION)
						incompatible.push({ sessionId, name, shortId, cwd });
					else compatible.push({ sessionId, name, shortId, title, cwd, busy, entry });
				}),
		);
		return { compatible, incompatible, liveSessionIds };
	}

	async listSessions(signal?: AbortSignal): Promise<SessionListing[]> {
		return cfgMessagingList.get(this.settings) === "deny" ? [] : (await this.#sessions(signal)).compatible;
	}

	async resolve(to: string, signal?: AbortSignal): Promise<SessionResolution> {
		if (isReservedAddress(to)) return { kind: "none" };
		if (to === this.ownAddress() || to === this.ownShortId()) return { kind: "self" };
		const sessions = await this.#sessions(signal);
		const addressed = sessions.compatible.filter(session => session.name === to || session.shortId === to);
		const ids = new Set(addressed.map(session => session.sessionId));
		const candidates = sessions.compatible.filter(session => ids.has(session.sessionId));
		if (candidates.length > 1) return { kind: "ambiguous", candidates };
		if (candidates.length === 1) return { kind: "found", target: candidates[0] };
		if (sessions.incompatible.some(session => session.name === to || session.shortId === to))
			return { kind: "incompatible", name: to };
		const offline = (await listOfflineSessions()).filter(
			session =>
				session.sessionId !== this.#ownSessionId() &&
				!sessions.liveSessionIds.has(session.sessionId) &&
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
		let address = target.name ?? target.shortId;
		if ("entry" in target) {
			const duplicates = (
				await readInboxEntries({ dir: this.#publication.registryDir, signal: opts.signal })
			).filter(entry => entry.sessionId === target.sessionId);
			if (duplicates.length > 1)
				return {
					ok: false,
					text: `Not sent: "${address}" matches more than one agent:\n${duplicates.map(() => `- ${target.name ?? "(unnamed)"} (session ${target.shortId}, ${target.cwd})`).join("\n")}\nAddress one by its session short id.`,
				};
		}
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
		const targetId = target.sessionId;
		const sent = (this.#sent.get(targetId) ?? []).filter(
			at => at > now - cfgMessagingRateWindowSeconds.get(this.settings) * 1000,
		);
		this.#sent.set(targetId, sent);
		if (sent.length >= cfgMessagingRateLimit.get(this.settings))
			return {
				ok: false,
				text: `Failed to send to ${address}: Too many messages to this session just now: ${sent.length} were sent recently and more would be dropped by its rate limit, so this one was not sent. Batch what remains into one message, or wait a little before sending more.`,
			};
		const dir = this.#publication.registryDir;
		const offlineTarget = "entry" in target ? undefined : target;
		const failedEntries = new Set<string>();
		sent.push(now);
		const fail = (text: string): SendOutcome => {
			this.#outgoing.delete(id);
			const index = sent.indexOf(now);
			if (index >= 0) sent.splice(index, 1);
			return { ok: false, text };
		};
		let result: InboxResponse;
		for (;;) {
			if (offlineTarget) {
				const saved = offlineTarget;
				const handoff = await withOfflineMailboxLock(
					saved.sessionId,
					async () => {
						const entries = (await readInboxEntries({ dir, signal: opts.signal })).filter(
							entry => entry.sessionId === saved.sessionId,
						);
						if (entries.length > 1)
							return {
								error: `Not sent: "${address}" matches more than one agent:\n${entries.map(() => `- ${saved.name ?? "(unnamed)"} (session ${saved.shortId}, ${saved.cwd})`).join("\n")}\nAddress one by its session short id.`,
							};
						if (entries.length === 1 && !failedEntries.has(entries[0].entryId)) {
							if (entries[0].version !== MESSAGING_WIRE_VERSION)
								return { error: `Not sent: ${address} runs an incompatible omp version.` };
							return { entry: entries[0] };
						}
						if (notifyWhenIdle)
							return { error: `Not sent: notify=idle needs a running session; ${address} is not running.` };
						if (request.type !== "message") return { error: "empty" };
						try {
							if (!(await fs.stat(saved.path)).isFile())
								return { error: `Not sent: ${address} is no longer available.` };
						} catch (error) {
							if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
								return { error: `Not sent: ${address} is no longer available.` };
							throw error;
						}
						const outcome = await enqueueOfflineUnlocked(
							saved.sessionId,
							{
								id,
								from: request.from!,
								body,
								chain: request.chain ?? [],
								sentAt: now,
								sessionFile: saved.path,
							},
							{ dir },
						);
						return outcome === "full"
							? { error: `Not sent: ${address}'s offline inbox is full (50 messages).` }
							: { queued: true };
					},
					{ dir, signal: opts.signal },
				).catch(error => {
					fail("");
					throw error;
				});
				if (handoff.error) return fail(handoff.error);
				if (handoff.queued) {
					this.#outgoing.set(id, { sessionId: saved.sessionId });
					return {
						ok: true,
						text: `Queued for ${address} (not running); it will see this when resumed.${idleNoticeSkipped}`,
					};
				}
				const snapshot = await requestInbox(handoff.entry!, { type: "snapshot" }, { dir, signal: opts.signal });
				if (!snapshot.ok || !("snapshot" in snapshot)) {
					if (!snapshot.ok && snapshot.error === "unreachable" && !opts.signal?.aborted) {
						failedEntries.add(handoff.entry!.entryId);
						continue;
					}
					return fail(
						`Failed to send to ${address}: ${!snapshot.ok ? snapshot.error : "Unexpected snapshot response"}`,
					);
				}
				if (snapshot.snapshot.sessionId !== saved.sessionId) {
					failedEntries.add(handoff.entry!.entryId);
					continue;
				}
				if (snapshot.snapshot.v !== MESSAGING_WIRE_VERSION)
					return fail(`Not sent: ${address} runs an incompatible omp version.`);
				target = { ...snapshot.snapshot, entry: handoff.entry! };
				address = target.name ?? target.shortId;
			}
			if (!("entry" in target)) throw new Error("Missing live messaging target");
			if (target.entry.version !== MESSAGING_WIRE_VERSION)
				return fail(`Not sent: ${address} runs an incompatible omp version.`);
			const remote: RemoteSender = {
				name: target.name,
				shortId: target.shortId,
				address: target.name ?? target.shortId,
				cwd: target.cwd,
			};
			this.#outgoing.set(id, { entryId: target.entry.entryId, sessionId: target.sessionId });
			if (notifyWhenIdle) this.#idle.arm(target.entry.entryId, remote, id);
			result = await requestInbox(target.entry, request, { dir, signal: opts.signal });
			if (result.ok && !("snapshot" in result)) break;
			this.#idle.cancel(target.entry.entryId, id);
			if (offlineTarget && !result.ok && result.error === "unreachable" && !opts.signal?.aborted) {
				failedEntries.add(target.entry.entryId);
				continue;
			}
			const error = !result.ok ? result.error : "Unexpected snapshot response";
			return fail(
				`Failed to send to ${address}: ${error === "unreachable" ? "the session is no longer running." : error}`,
			);
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
					sessionId: this.#ownSessionId(),
					name: this.ownAddress(),
					shortId: this.ownShortId(),
					title: this.#suspendedIdentity ? this.#suspendedIdentity.title : (this.host.sessionName() ?? null),
					cwd: this.#suspendedIdentity?.cwd ?? this.host.cwd(),
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
		if (request.kind === "refused") {
			if (request.toSessionId === this.#ownSessionId()) {
				this.#outgoing.delete(request.aboutId);
				this.#deliver({
					type: "receipt",
					text: `Your offline message to ${request.from.name ?? request.from.shortId} was refused.`,
				});
			}
			return { ok: true, outcome: "delivered" };
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
					(outgoing.entryId === undefined && outgoing.sessionId === request.from.sessionId))
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
			const dir = this.#publication.registryDir;
			const entry = (await listInboxEntries({ dir })).find(item => item.entryId === sender.entryId);
			if (!entry || entry.entryId === this.#publication.entryId || entry.version !== MESSAGING_WIRE_VERSION) return;
			await requestInbox(
				entry,
				{ ...notice, id: crypto.randomUUID(), from },
				{ dir, timeoutMs: SNAPSHOT_TIMEOUT_MS },
			);
		} catch (error) {
			logger.warn("Messaging notice failed", { error: String(error) });
		}
	}
	async retireConversation(): Promise<void> {
		if (this.#closed || this.#suspended > 0) return;
		this.#outgoing.clear();
		await Promise.all([this.#gate.retire(), this.#idle.retire()]);
		const previous = this.#publication;
		this.#publication = await publishInbox((request, auth) => this.#receive(request, auth), {
			dir: previous.registryDir,
			sessionId: this.host.sessionId(),
		});
		await previous.close();
		await this.#deliverOfflineMail(await drainOffline(this.host.sessionId(), { dir: this.#publication.registryDir }));
	}

	async #notifyOfflineRefusal(message: StoredMessage): Promise<void> {
		// ponytail: best-effort refusal receipt; a full sender inbox loses the notice, not user data
		try {
			const dir = this.#publication.registryDir;
			const sessionFile = (await listOfflineSessions()).find(
				session => session.sessionId === message.from.sessionId,
			)?.path;
			const request: Extract<InboxRequest, { kind: "refused" }> = {
				type: "notice",
				id: `refused-${message.id}`,
				from: this.#sender(),
				kind: "refused",
				subject: "message",
				aboutId: message.id,
				toSessionId: message.from.sessionId,
			};
			const notice: StoredRefusalNotice = {
				...request,
				sentAt: Date.now(),
				...(sessionFile ? { sessionFile } : {}),
			};
			const failed = new Set<string>();
			for (;;) {
				const entry = await withOfflineMailboxLock(
					message.from.sessionId,
					async () => {
						const entries = (await readInboxEntries({ dir })).filter(
							entry => entry.sessionId === message.from.sessionId,
						);
						if (
							entries.length === 1 &&
							entries[0].version === MESSAGING_WIRE_VERSION &&
							!failed.has(entries[0].entryId)
						)
							return entries[0];
						if ((await enqueueOfflineUnlocked(message.from.sessionId, notice, { dir })) === "full")
							throw new Error("Sender offline inbox is full");
						return undefined;
					},
					{ dir },
				);
				if (!entry) break;
				const result = await requestInbox(entry, request, { dir, timeoutMs: SNAPSHOT_TIMEOUT_MS });
				if (result.ok && !("snapshot" in result) && (result.outcome === "delivered" || result.outcome === "queued"))
					break;
				failed.add(entry.entryId);
			}
		} catch (error) {
			logger.warn("Failed to notify sender of refused offline message", { error: String(error) });
		}
	}

	async #deliverOfflineMail(mail: DrainedMail[]): Promise<void> {
		let admitted = 0;
		this.#batching++;
		try {
			for (const { message, ack } of mail) {
				if (!("body" in message)) {
					if (message.toSessionId === this.#ownSessionId())
						this.#deliver({
							type: "receipt",
							text: `Your offline message to ${message.from.name ?? message.from.shortId} was refused.`,
						});
					await ack();
					continue;
				}
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
					if (result.outcome === "refused") await this.#notifyOfflineRefusal(message);
					else if (result.outcome === "dropped")
						await this.#reply(message.from, {
							type: "notice",
							kind: "dropped",
							reason: result.reason,
							aboutId: message.id,
						});
					await ack();
				}
			}
		} finally {
			this.#batching--;
			this.#flush();
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
