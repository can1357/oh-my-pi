import { logger, popLoopPhase, postmortem, pushLoopPhase } from "@oh-my-pi/pi-utils";
import { recordDaemonSessionAlias } from "../session/session-listing";
import { AttachmentEventStream, type EventRecord, OrderedEventLog } from "./event-log";
import { canonicalProjectRoot } from "./paths";
import {
	DAEMON_MAX_FRAME_BYTES,
	type DaemonEventDelivery,
	encodeDaemonSnapshotChunks,
	splitDaemonTerminalOutput,
} from "./protocol";
import type {
	DaemonSessionCreateOverrides,
	DaemonSessionRuntime,
	DaemonSessionRuntimeFactory,
} from "./session-runtime";

export const DEFAULT_DETACHED_SESSION_TTL_MS = 420_000;
export type DaemonAttachmentMode = "interactive" | "observe";

export type DaemonAttachment = {
	readonly sessionId: string;
	readonly attachmentId: string;
	readonly mode: DaemonAttachmentMode;
	readonly stream: AttachmentEventStream<unknown, unknown>;
};

export type DaemonSessionSummary = {
	sessionId: string;
	cwd: string;
	attachmentCount: number;
	interactiveAttached: boolean;
	isStreaming: boolean;
};

export type DaemonSessionRegistryOptions = {
	runtimeFactory: DaemonSessionRuntimeFactory;
	id?: () => string;
	sessionDir?: string;
	/** Resolve persisted session files for `session_load`/`session_resume`. */
	listSessions?: () => Promise<ReadonlyArray<{ id: string; path: string; cwd: string }>>;
	detachedSessionTtlMs?: number;
};

type AttachmentSink = (frame: unknown) => void | Promise<void>;

type AttachmentRecord = {
	id: string;
	mode: DaemonAttachmentMode;
	delivery: DaemonEventDelivery;
	stream: AttachmentEventStream<unknown, unknown>;
	sink: AttachmentSink;
	attaching: boolean;
	pending: EventRecord<unknown>[];
};

function projectAttachmentFrame(frame: unknown, delivery: DaemonEventDelivery): unknown {
	if (
		delivery === "all" ||
		typeof frame !== "object" ||
		frame === null ||
		!("type" in frame) ||
		frame.type !== "event"
	) {
		return frame;
	}
	if (!("event" in frame) || typeof frame.event !== "object" || frame.event === null || !("type" in frame.event)) {
		return frame;
	}
	const type = frame.event.type;
	if (type === "terminal_output" || type === "terminal_closed") return frame;
	return { ...frame, event: { type: "daemon_event_skipped" } };
}

type SessionRecord = {
	runtime: DaemonSessionRuntime;
	log: OrderedEventLog<unknown>;
	attachments: Map<string, AttachmentRecord>;
	interactiveAttachment?: string;
	unsubscribe: () => void;
	queue: Promise<void>;
	pendingEvents: BoundedDaemonEvent[];
	fanoutActive: boolean;
	closed: boolean;
	parkTimer?: NodeJS.Timeout;
};

function hostedSessionCloseReason(event: unknown): postmortem.Reason | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const record = event as Record<string, unknown>;
	if (record.type !== "terminal_closed") return undefined;
	if (record.reason === "exit") return postmortem.Reason.EXIT;
	if (record.reason === "error") return postmortem.Reason.MANUAL;
	return undefined;
}

/** Frame-envelope headroom below DAEMON_MAX_FRAME_BYTES for tag/seq/ids. */
const MAX_DAEMON_EVENT_BYTES = DAEMON_MAX_FRAME_BYTES - 8192;
const EVENT_FANOUT_BATCH_SIZE = 32;

/**
 * Bound one event to what a wire frame can carry. An oversized event is
 * POISON: encoding throws at send time, synchronously, through the session's
 * subscribe listener — and replay hits the same encode failure forever, so
 * the attachment stream wedges and the client freezes (observed with a huge
 * tool payload in a 120MB session). Replace it with a compact marker so seq
 * continuity and the live stream survive; the client loses one event's body,
 * not the session.
 */
type BoundedDaemonEvent = {
	event: unknown;
	bytes: number;
};

function boundDaemonEvent(event: unknown): BoundedDaemonEvent {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(event);
	} catch {
		// Circular payloads would also fail frame encoding.
		const marker = { type: "daemon_event_truncated", reason: "unserializable" };
		return { event: marker, bytes: Buffer.byteLength(JSON.stringify(marker), "utf8") };
	}
	// JSON.stringify(undefined / toJSON→undefined) yields undefined: encoding
	// such an event would drop the frame's event key and emit a malformed frame.
	if (serialized === undefined) {
		const marker = { type: "daemon_event_truncated", reason: "unserializable" };
		return { event: marker, bytes: Buffer.byteLength(JSON.stringify(marker), "utf8") };
	}
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes <= MAX_DAEMON_EVENT_BYTES) return { event, bytes };
	const type =
		typeof event === "object" && event !== null && "type" in event ? String(event.type).slice(0, 128) : "unknown";
	logger.warn("Dropping oversized daemon session event", { type, bytes });
	const marker = { type: "daemon_event_truncated", reason: "oversized", originalType: type, bytes };
	return { event: marker, bytes: Buffer.byteLength(JSON.stringify(marker), "utf8") };
}

function splitDaemonEvent(event: unknown): readonly BoundedDaemonEvent[] {
	if (
		typeof event !== "object" ||
		event === null ||
		Array.isArray(event) ||
		!("type" in event) ||
		event.type !== "terminal_output" ||
		!("data" in event) ||
		typeof event.data !== "string"
	)
		return [boundDaemonEvent(event)];
	// Terminal output is bounded by construction. Account for the fixed object
	// envelope without another full JSON serialization of the hottest path.
	return splitDaemonTerminalOutput(event.data).map(data => ({
		event: { ...event, data },
		bytes: Buffer.byteLength(data, "utf8") + 64,
	}));
}

/** Owns every daemon AgentSession and serializes all mutations to it. */
export class DaemonSessionRegistry {
	readonly #runtimeFactory: DaemonSessionRuntimeFactory;
	readonly #id: () => string;
	readonly #sessionDir: string | undefined;
	readonly #listSessions: DaemonSessionRegistryOptions["listSessions"];
	readonly #detachedSessionTtlMs: number;
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #closing = new Set<Promise<void>>();
	/** In-flight runtime factory builds (create/load); dispose drains these. */
	readonly #building = new Set<Promise<DaemonSessionRuntime>>();
	/** Set at dispose(): late factory completions must not install. */
	#disposed = false;

	constructor(options: DaemonSessionRegistryOptions) {
		this.#runtimeFactory = options.runtimeFactory;
		this.#id = options.id ?? (() => crypto.randomUUID());
		this.#sessionDir = options.sessionDir;
		this.#listSessions = options.listSessions;
		this.#detachedSessionTtlMs = Number.isFinite(options.detachedSessionTtlMs)
			? Math.max(0, options.detachedSessionTtlMs ?? DEFAULT_DETACHED_SESSION_TTL_MS)
			: DEFAULT_DETACHED_SESSION_TTL_MS;
	}

	get sessionCount(): number {
		return this.#sessions.size;
	}

	get attachmentCount(): number {
		let count = 0;
		for (const record of this.#sessions.values()) count += record.attachments.size;
		return count;
	}

	get protectedJobCount(): number {
		let count = 0;
		for (const record of this.#sessions.values()) count += record.runtime.protectedJobCount?.() ?? 0;
		return count;
	}

	get hasLiveSessions(): boolean {
		return [...this.#sessions.values()].some(record => !record.closed);
	}

	get hasInteractiveAttachments(): boolean {
		return [...this.#sessions.values()].some(record => record.interactiveAttachment !== undefined);
	}

	status(): { sessionCount: number; attachmentCount: number; protectedJobCount: number } {
		return {
			sessionCount: this.sessionCount,
			attachmentCount: this.attachmentCount,
			protectedJobCount: this.protectedJobCount,
		};
	}

	async create(
		sessionId: string | undefined,
		cwd: string,
		overrides?: DaemonSessionCreateOverrides,
	): Promise<DaemonSessionSummary> {
		const resolvedCwd = await canonicalProjectRoot(cwd);
		if (sessionId) {
			if (this.#sessions.has(sessionId))
				throw new RegistryError("session_busy", `session ${sessionId} already exists`);
			// A caller naming a session wants THAT session back (recovery after a
			// daemon replacement): rehydrate its transcript when it exists on
			// disk instead of silently starting a blank session under its id.
			const sessions = await this.#listSessions?.();
			const info = sessions?.find(item => item.id === sessionId);
			if (info) {
				const runtime = await this.#buildRuntime({
					cwd: await canonicalProjectRoot(info.cwd),
					sessionId,
					sessionFile: info.path,
					sessionDir: this.#sessionDir,
					overrides,
				});
				return this.#install(sessionId, runtime);
			}
		}
		const runtime = await this.#buildRuntime({
			cwd: resolvedCwd,
			sessionId,
			sessionDir: this.#sessionDir,
			overrides,
		});
		// An explicit id is a recovery contract and must survive a fresh
		// runtime whose underlying session manager minted a transient id.
		// Unnamed creates still use the underlying transcript identity so
		// every user-visible resume surface agrees.
		const id = sessionId ?? runtime.session.sessionId ?? runtime.sessionId ?? this.#id();
		if (this.#sessions.has(id)) {
			await runtime.dispose().catch(() => undefined);
			throw new RegistryError("session_busy", `session ${id} already exists`);
		}
		return this.#install(id, runtime);
	}

	async load(sessionId: string): Promise<DaemonSessionSummary> {
		const existing = this.#sessions.get(sessionId);
		if (existing) return this.#summary(sessionId, existing);
		const sessions = await this.#listSessions?.();
		const info = sessions?.find(item => item.id === sessionId);
		if (!info) throw new RegistryError("not_found", `session ${sessionId} was not found`);
		const cwd = await canonicalProjectRoot(info.cwd);
		const runtime = await this.#buildRuntime({
			cwd,
			sessionId,
			sessionFile: info.path,
			sessionDir: this.#sessionDir,
		});
		return this.#install(sessionId, runtime);
	}

	async resume(sessionId: string): Promise<DaemonSessionSummary> {
		return this.load(sessionId);
	}

	list(): DaemonSessionSummary[] {
		return [...this.#sessions].map(([id, record]) => this.#summary(id, record));
	}

	async close(sessionId: string, reason?: postmortem.Reason): Promise<{ closed: true }> {
		const record = this.#require(sessionId);
		await this.#serialize(record, () => this.#closeRecord(sessionId, record, reason));
		return { closed: true };
	}

	async attach(
		sessionId: string,
		attachmentId: string,
		mode: DaemonAttachmentMode,
		sink: AttachmentSink,
		lastSeq?: number,
		delivery: DaemonEventDelivery = "all",
	): Promise<{
		sessionId: string;
		attachmentId: string;
		mode: DaemonAttachmentMode;
		frames: unknown[];
		barrierSeq: number;
	}> {
		const record = this.#require(sessionId);
		if (record.attachments.has(attachmentId))
			throw new RegistryError("session_busy", `attachment ${attachmentId} already exists`);
		if (mode === "interactive" && record.interactiveAttachment && record.interactiveAttachment !== attachmentId)
			throw new RegistryError("session_busy", `session ${sessionId} already has an interactive attachment`);
		this.#cancelParking(record);
		const stream = new AttachmentEventStream<unknown, unknown>(record.log, {
			chunkSize: 64,
			maxBufferedEvents: 2048,
			snapshot: () => record.runtime.snapshot(),
			chunks: encodeDaemonSnapshotChunks,
			sink: frame => sink(projectAttachmentFrame(frame, delivery)),
			attachmentId,
		});
		const attachment: AttachmentRecord = {
			id: attachmentId,
			mode,
			delivery,
			stream,
			sink,
			attaching: true,
			pending: [],
		};
		record.attachments.set(attachmentId, attachment);
		if (mode === "interactive") record.interactiveAttachment = attachmentId;
		try {
			// Attach replays the event backlog and, when needed, a FULL state
			// snapshot — serialized synchronously right here. Tag the stretch so
			// a watchdog block during a multi-MB reattach names this path
			// instead of "unknown".
			pushLoopPhase(`daemon:attach-replay:${sessionId}`);
			const frames: unknown[] = [];
			try {
				frames.push(...stream.attach(lastSeq).map(frame => projectAttachmentFrame(frame, delivery)));
				for (;;) {
					const next = stream.next();
					if (next.length === 0) break;
					frames.push(...next.map(frame => projectAttachmentFrame(frame, delivery)));
				}
			} finally {
				popLoopPhase();
			}
			attachment.attaching = false;
			for (const pending of attachment.pending.splice(0)) {
				const pendingFrames = attachment.stream.publish(pending);
				for (const frame of pendingFrames)
					void Promise.resolve(attachment.sink(projectAttachmentFrame(frame, attachment.delivery))).catch(
						() => undefined,
					);
			}
			return {
				sessionId,
				attachmentId,
				mode,
				frames,
				barrierSeq: stream.barrierSeq ?? record.log.latestSeq,
			};
		} catch (error) {
			this.#detachRecord(record, attachmentId);
			throw error;
		}
	}

	detach(sessionId: string, attachmentId: string): { detached: true } {
		const record = this.#require(sessionId);
		const attachment = record.attachments.get(attachmentId);
		if (!attachment) throw new RegistryError("not_found", `attachment ${attachmentId} was not found`);
		this.#detachRecord(record, attachmentId);
		return { detached: true };
	}

	async command(sessionId: string, attachmentId: string, command: unknown): Promise<unknown> {
		const record = this.#require(sessionId);
		const attachment = record.attachments.get(attachmentId);
		if (!attachment) throw new RegistryError("not_found", `attachment ${attachmentId} was not found`);
		if (attachment.mode !== "interactive")
			throw new RegistryError("session_busy", "observe attachment cannot issue commands");
		return this.#serialize(record, () => {
			// Re-check INSIDE the record queue: a close that was queued ahead of
			// this command has already disposed the runtime by the time this
			// task runs, and a disposed runtime must never receive commands.
			if (record.closed) throw new RegistryError("not_found", `session ${sessionId} was closed`);
			return record.runtime.command(command, attachmentId);
		});
	}

	snapshotAck(sessionId: string, attachmentId: string, seq: number): { acknowledged: number } {
		const record = this.#require(sessionId);
		const attachment = record.attachments.get(attachmentId);
		if (!attachment) throw new RegistryError("not_found", `attachment ${attachmentId} was not found`);
		record.log.acknowledge(attachmentId, seq);
		attachment.stream.acknowledge(seq);
		return { acknowledged: seq };
	}

	/** Disconnect only releases the attachment; active work remains owned by the runtime. */
	disconnect(sessionId: string, attachmentId: string): void {
		const record = this.#sessions.get(sessionId);
		if (!record) return;
		if (record.attachments.has(attachmentId)) this.#detachRecord(record, attachmentId);
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		for (const sessionId of [...this.#sessions.keys()]) await this.close(sessionId);
		// Drain to quiescence: an in-flight runtime factory settles into a
		// #install rejection whose runtime disposal lands in #closing — loop
		// until nothing new appears so no runtime outlives the registry.
		while (this.#building.size > 0 || this.#closing.size > 0) {
			await Promise.allSettled([...this.#building, ...this.#closing]);
		}
	}

	/** Run the runtime factory tracked, so dispose() can drain late builds. */
	async #buildRuntime(args: Parameters<DaemonSessionRuntimeFactory>[0]): Promise<DaemonSessionRuntime> {
		if (this.#disposed) throw new RegistryError("internal", "registry is shutting down");
		const building = Promise.resolve(this.#runtimeFactory(args));
		this.#building.add(building);
		try {
			return await building;
		} finally {
			this.#building.delete(building);
		}
	}

	/** Dispose a runtime rejected by {@link #install}; awaitable via #closing. */
	#disposeRejected(runtime: DaemonSessionRuntime): void {
		const settling = Promise.resolve(runtime.dispose()).catch(() => undefined);
		this.#closing.add(settling);
		void settling.finally(() => this.#closing.delete(settling));
	}

	#install(sessionId: string, runtime: DaemonSessionRuntime): DaemonSessionSummary {
		// Final atomic guard: callers' existence checks run BEFORE awaited
		// factory work, so two racing creates/loads resolving to the same id
		// both reach here — and a factory that outlives the shutdown drain
		// budget must not install into a disposed registry (that would leak a
		// live runtime with no owner). The checks + set below are synchronous.
		if (this.#disposed) {
			this.#disposeRejected(runtime);
			throw new RegistryError("internal", "registry is shutting down");
		}
		if (this.#sessions.has(sessionId)) {
			this.#disposeRejected(runtime);
			throw new RegistryError("session_busy", `session ${sessionId} already exists`);
		}
		const log = new OrderedEventLog<unknown>();
		const record: SessionRecord = {
			runtime,
			log,
			attachments: new Map(),
			unsubscribe: () => undefined,
			queue: Promise.resolve(),
			pendingEvents: [],
			fanoutActive: false,
			closed: false,
		};
		record.unsubscribe = runtime.subscribe(event => {
			const boundedEvents = splitDaemonEvent(event);
			if (record.fanoutActive) {
				record.pendingEvents.push(...boundedEvents);
				return;
			}
			record.fanoutActive = true;
			let index = 0;
			pushLoopPhase(`daemon:event-fanout:${sessionId}`);
			try {
				for (; index < EVENT_FANOUT_BATCH_SIZE && index < boundedEvents.length; index++)
					this.#publishBoundedEventSafely(sessionId, record, boundedEvents[index]!);
			} finally {
				popLoopPhase();
			}
			if (index < boundedEvents.length) record.pendingEvents.push(...boundedEvents.slice(index));
			if (record.pendingEvents.length === 0) {
				record.fanoutActive = false;
				this.#scheduleParking(sessionId, record);
				return;
			}
			void this.#drainEventFanout(sessionId, record);
		});
		this.#scheduleParking(sessionId, record);
		this.#sessions.set(sessionId, record);
		// Ledger the registry handle → transcript mapping: anything that shows
		// this handle to the user must stay resumable after the daemon exits.
		void recordDaemonSessionAlias(sessionId, runtime.session.sessionFile ?? "");
		this.#scheduleParking(sessionId, record);
		return this.#summary(sessionId, record);
	}

	#publishBoundedEventSafely(sessionId: string, record: SessionRecord, boundedEvent: BoundedDaemonEvent): void {
		try {
			this.#publishBoundedEvent(sessionId, record, boundedEvent);
		} catch (error) {
			logger.warn("Daemon event fanout failed", { sessionId, error });
		}
	}

	#publishBoundedEvent(sessionId: string, record: SessionRecord, boundedEvent: BoundedDaemonEvent): void {
		const published = record.log.append(boundedEvent.event, boundedEvent.bytes);
		for (const attachment of record.attachments.values()) {
			if (attachment.attaching) {
				attachment.pending.push(published);
				continue;
			}
			const frames = attachment.stream.publish(published);
			for (const frame of frames)
				void Promise.resolve(attachment.sink(projectAttachmentFrame(frame, attachment.delivery))).catch(
					() => undefined,
				);
		}
		const closeReason = hostedSessionCloseReason(boundedEvent.event);
		if (closeReason) void this.close(sessionId, closeReason).catch(() => undefined);
	}

	async #drainEventFanout(sessionId: string, record: SessionRecord): Promise<void> {
		while (record.pendingEvents.length > 0) {
			await Bun.sleep(0);
			const batch = record.pendingEvents.splice(0, EVENT_FANOUT_BATCH_SIZE);
			pushLoopPhase(`daemon:event-fanout:${sessionId}`);
			try {
				for (const boundedEvent of batch) this.#publishBoundedEventSafely(sessionId, record, boundedEvent);
			} finally {
				popLoopPhase();
			}
		}
		record.fanoutActive = false;
		this.#scheduleParking(sessionId, record);
	}

	#summary(sessionId: string, record: SessionRecord): DaemonSessionSummary {
		return {
			sessionId,
			cwd: record.runtime.cwd,
			attachmentCount: record.attachments.size,
			interactiveAttached: record.interactiveAttachment !== undefined,
			isStreaming: record.runtime.session.isStreaming === true,
		};
	}

	#require(sessionId: string): SessionRecord {
		const record = this.#sessions.get(sessionId);
		if (!record || record.closed) throw new RegistryError("not_found", `session ${sessionId} was not found`);
		return record;
	}

	#detachRecord(record: SessionRecord, attachmentId: string): void {
		const attachment = record.attachments.get(attachmentId);
		if (!attachment) return;
		if (attachment.mode === "interactive") {
			void record.runtime.command({ type: "terminal_detach" }, attachmentId).catch(() => undefined);
		}
		record.attachments.delete(attachmentId);
		if (record.interactiveAttachment === attachmentId) record.interactiveAttachment = undefined;
		record.log.unregisterAttachment(attachmentId);
		this.#scheduleParking(record.runtime.sessionId, record);
	}

	#cancelParking(record: SessionRecord): void {
		clearTimeout(record.parkTimer);
		record.parkTimer = undefined;
	}

	#canPark(record: SessionRecord): boolean {
		return (
			!record.closed &&
			record.attachments.size === 0 &&
			record.runtime.session.isStreaming !== true &&
			(record.runtime.protectedJobCount?.() ?? 0) === 0
		);
	}

	#scheduleParking(sessionId: string, record: SessionRecord): void {
		this.#cancelParking(record);
		if (!this.#canPark(record)) return;
		record.parkTimer = setTimeout(() => {
			record.parkTimer = undefined;
			void this.#serialize(record, async () => {
				if (this.#sessions.get(sessionId) !== record || record.closed) return;
				if (!this.#canPark(record)) {
					this.#scheduleParking(sessionId, record);
					return;
				}
				await this.#closeRecord(sessionId, record);
			}).catch(error => {
				logger.warn("Failed to park detached daemon session", { sessionId, error });
			});
		}, this.#detachedSessionTtlMs);
	}

	async #closeRecord(sessionId: string, record: SessionRecord, reason?: postmortem.Reason): Promise<void> {
		if (record.closed) return;
		record.closed = true;
		// The transcript may have materialized only after install; refresh the
		// handle → file alias with the final path before the runtime goes away.
		void recordDaemonSessionAlias(sessionId, record.runtime.session.sessionFile ?? "");
		this.#cancelParking(record);
		logger.debug("Daemon session close started", { sessionId, attachmentCount: record.attachments.size });
		record.unsubscribe();
		for (const attachment of [...record.attachments.values()]) this.#detachRecord(record, attachment.id);
		record.attachments.clear();
		record.interactiveAttachment = undefined;
		this.#sessions.delete(sessionId);
		logger.debug("Daemon session removed from live registry", { sessionId });
		const disposal = record.runtime.dispose(reason);
		this.#closing.add(disposal);
		try {
			await disposal;
		} finally {
			this.#closing.delete(disposal);
			logger.debug("Daemon session runtime cleanup settled", { sessionId });
		}
	}

	async #serialize<T>(record: SessionRecord, task: () => Promise<T>): Promise<T> {
		const previous = record.queue;
		const deferred = Promise.withResolvers<T>();
		record.queue = previous.then(async () => {
			try {
				deferred.resolve(await task());
			} catch (error) {
				deferred.reject(error);
			}
		});
		return deferred.promise;
	}
}

export class RegistryError extends Error {
	readonly code: "not_found" | "session_busy" | "internal";

	constructor(code: "not_found" | "session_busy" | "internal", message: string) {
		super(message);
		this.name = "RegistryError";
		this.code = code;
	}
}
