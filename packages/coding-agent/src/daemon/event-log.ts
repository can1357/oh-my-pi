/**
 * Ordered, bounded event history and attachment-local reconnect replay.
 *
 * The module deliberately knows nothing about sockets. Callers can either use the
 * returned frames or provide a sink through the async `*To` methods.
 */

export type EventRecord<E> = Readonly<{ seq: number; event: E }>;

export type ReplayResult<E> =
	| Readonly<{ kind: "replay"; events: readonly EventRecord<E>[] }>
	| Readonly<{ kind: "snapshot_required"; reason: "history_unavailable" | "gap" }>;

export type EventLogOptions<E> = Readonly<{
	maxEvents?: number;
	maxBytes?: number;
	sizeOf?: (event: E) => number;
}>;

const DEFAULT_MAX_EVENTS = 2_048;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function validCursor(value: number): boolean {
	return Number.isInteger(value) && value >= 0;
}

/** A per-session, strictly ordered, bounded event history. */
export class OrderedEventLog<E> {
	readonly #maxEvents: number;
	readonly #maxBytes: number;
	readonly #sizeOf: (event: E) => number;
	#events: EventRecord<E>[] = [];
	#bytes = 0;
	#eventSizes: number[] = [];
	#nextSeq = 1;
	#attachments = new Map<string, number>();

	constructor(options: EventLogOptions<E> = {}) {
		this.#maxEvents = Math.max(1, Math.trunc(options.maxEvents ?? DEFAULT_MAX_EVENTS));
		this.#maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES));
		this.#sizeOf =
			options.sizeOf ??
			(event => {
				try {
					return Math.max(1, Buffer.byteLength(JSON.stringify(event), "utf8"));
				} catch {
					return 1;
				}
			});
	}

	get latestSeq(): number {
		return this.#nextSeq - 1;
	}

	/** Sequence that will be assigned to the next event. */
	get nextSeq(): number {
		return this.#nextSeq;
	}

	/** The oldest retained sequence, or the next sequence when empty. */
	get oldestSeq(): number {
		return this.#events[0]?.seq ?? this.#nextSeq;
	}

	get size(): number {
		return this.#events.length;
	}

	append(event: E, measuredBytes?: number): EventRecord<E> {
		const record: EventRecord<E> = Object.freeze({ seq: this.#nextSeq++, event });
		const bytes =
			measuredBytes !== undefined && Number.isFinite(measuredBytes)
				? Math.max(1, Math.trunc(measuredBytes))
				: this.#sizeOf(event);
		this.#events.push(record);
		this.#eventSizes.push(bytes);
		this.#bytes += bytes;
		this.#trim();
		return record;
	}

	/** Return a stable copy of retained events through a barrier. */
	eventsThrough(barrierSeq: number): readonly EventRecord<E>[] {
		if (!validCursor(barrierSeq) || barrierSeq < this.oldestSeq - 1) return [];
		return this.#events.filter(record => record.seq <= barrierSeq).slice();
	}

	replayAfter(lastSeq: number): ReplayResult<E> {
		if (!validCursor(lastSeq) || lastSeq > this.latestSeq) return { kind: "snapshot_required", reason: "gap" };
		if (lastSeq < this.oldestSeq - 1) return { kind: "snapshot_required", reason: "history_unavailable" };
		const events = this.#events.filter(record => record.seq > lastSeq);
		for (let index = 1; index < events.length; index++) {
			if (events[index]!.seq !== events[index - 1]!.seq + 1) {
				return { kind: "snapshot_required", reason: "gap" };
			}
		}
		return { kind: "replay", events: events.slice() };
	}

	registerAttachment(attachmentId: string, lastSeq = 0): void {
		if (!attachmentId) throw new Error("attachmentId must not be empty");
		if (!validCursor(lastSeq)) throw new Error("lastSeq must be a non-negative integer");
		this.#attachments.set(attachmentId, Math.min(lastSeq, this.latestSeq));
		this.#trim();
	}

	unregisterAttachment(attachmentId: string): void {
		this.#attachments.delete(attachmentId);
		this.#trim();
	}

	/**
	 * ACKs are monotonic. Retained history is pruned only through the minimum ACK
	 * cursor across all registered attachments.
	 */
	acknowledge(attachmentId: string, seq: number): void {
		if (!validCursor(seq)) throw new Error("seq must be a non-negative integer");
		const previous = this.#attachments.get(attachmentId);
		if (previous === undefined) return;
		if (seq > previous) this.#attachments.set(attachmentId, Math.min(seq, this.latestSeq));
		this.#trim();
	}

	/** Alias useful to transports that call acknowledgements simply `ack`. */
	ack(seq: number): void;
	ack(attachmentId: string, seq: number): void;
	ack(attachmentOrSeq: string | number, seq?: number): void {
		if (typeof attachmentOrSeq === "number") {
			const attachmentId = this.#attachments.keys().next().value ?? "__default__";
			if (!this.#attachments.has(attachmentId)) this.#attachments.set(attachmentId, 0);
			this.acknowledge(attachmentId, attachmentOrSeq);
			return;
		}
		if (seq === undefined) throw new Error("seq is required with attachmentId");
		this.acknowledge(attachmentOrSeq, seq);
	}

	#trim(): void {
		if (this.#events.length === 0) return;
		const safeSeq = this.#attachments.size > 0 ? Math.min(...this.#attachments.values()) : 0;
		while (this.#events.length > 0 && this.#events[0]!.seq <= safeSeq) {
			this.#events.shift();
			this.#bytes -= this.#eventSizes.shift()!;
		}
		while (this.#events.length > this.#maxEvents || (this.#bytes > this.#maxBytes && this.#events.length > 1)) {
			this.#events.shift();
			this.#bytes -= this.#eventSizes.shift()!;
		}
	}
}

export type SnapshotFrame<E, S> =
	| Readonly<{ type: "snapshot_begin"; barrierSeq: number }>
	| Readonly<{ type: "snapshot_chunk"; barrierSeq: number; index: number; chunk: S }>
	| Readonly<{ type: "snapshot_end"; barrierSeq: number; nextSeq: number }>
	| Readonly<{ type: "event"; seq: number; event: E }>
	| Readonly<{ type: "snapshot_restart"; reason: "overflow" | "gap"; previousBarrierSeq: number }>;

export type SnapshotOptions<E, S> = Readonly<{
	chunkSize?: number;
	maxBufferedEvents?: number;
	snapshot: () => S | Promise<S>;
	chunks?: (snapshot: S) => readonly S[] | Promise<readonly S[]>;
	sink?: (frame: SnapshotFrame<E, S>) => void | Promise<void>;
	attachmentId?: string;
}>;

type SnapshotState<E, S> = {
	barrierSeq: number;
	chunks: readonly S[];
	chunkIndex: number;
	buffered: EventRecord<E>[];
	phase: "chunks" | "end" | "flush";
};

/**
 * Coordinates one attachment's snapshot barrier and event replay. A stream is
 * intentionally single-owner: its methods are serialized by `*To` for async
 * transports, while synchronous methods are convenient for in-memory servers.
 */
export class AttachmentEventStream<E, S> {
	readonly #log: OrderedEventLog<E>;
	readonly #options: SnapshotOptions<E, S>;
	readonly #chunkSize: number;
	readonly #maxBufferedEvents: number;
	readonly #attachmentId: string;
	#state: SnapshotState<E, S> | undefined;
	#deliveredSeq = 0;
	#queue: Promise<void> = Promise.resolve();

	constructor(log: OrderedEventLog<E>, options: SnapshotOptions<E, S>) {
		this.#log = log;
		this.#options = options;
		this.#chunkSize = Math.max(1, Math.trunc(options.chunkSize ?? 64));
		this.#maxBufferedEvents = Math.max(1, Math.trunc(options.maxBufferedEvents ?? 256));
		this.#attachmentId = options.attachmentId ?? `attachment-${Math.random().toString(36).slice(2)}`;
		this.#log.registerAttachment(this.#attachmentId);
	}

	get barrierSeq(): number | undefined {
		return this.#state?.barrierSeq;
	}

	get nextSeq(): number {
		return this.#log.nextSeq;
	}

	get currentBarrierSeq(): number | undefined {
		return this.barrierSeq;
	}

	get nextEventSeq(): number {
		return this.nextSeq;
	}
	get deliveredSeq(): number {
		return this.#deliveredSeq;
	}

	get snapshotting(): boolean {
		return this.#state !== undefined;
	}

	/** Starts replay or a fresh snapshot. Snapshot attachments receive begin first. */
	attach(lastSeq?: number): readonly SnapshotFrame<E, S>[] {
		if (this.#state) throw new Error("snapshot is already in progress");
		if (lastSeq !== undefined) {
			const replay = this.#log.replayAfter(lastSeq);
			if (replay.kind === "replay") {
				this.#deliveredSeq = lastSeq;
				this.#ack(lastSeq);
				const frames = replay.events.map(record => this.#eventFrame(record));
				if (replay.events.length > 0) this.#deliveredSeq = replay.events[replay.events.length - 1]!.seq;
				this.#ack(this.#deliveredSeq);
				return frames;
			}
		}
		const barrierSeq = this.#log.latestSeq;
		const snapshot = this.#options.snapshot();
		if (snapshot instanceof Promise) throw new Error("async snapshot requires attachTo");
		this.#beginSnapshot(snapshot, this.#syncChunks(snapshot), barrierSeq);
		return [{ type: "snapshot_begin", barrierSeq: this.#state!.barrierSeq }];
	}

	next(): readonly SnapshotFrame<E, S>[] {
		const state = this.#state;
		if (!state) return [];
		if (state.phase === "chunks") {
			if (state.chunkIndex < state.chunks.length) {
				const index = state.chunkIndex++;
				return [{ type: "snapshot_chunk", barrierSeq: state.barrierSeq, index, chunk: state.chunks[index]! }];
			}
			state.phase = "end";
		}
		if (state.phase === "end") {
			state.phase = "flush";
			const frames: SnapshotFrame<E, S>[] = [
				{ type: "snapshot_end", barrierSeq: state.barrierSeq, nextSeq: state.barrierSeq + 1 },
			];
			const flushed = this.#flush(state);
			frames.push(...flushed);
			if (this.#state === state) this.#state = undefined;
			return frames;
		}
		return [];
	}

	publish(record: EventRecord<E>): readonly SnapshotFrame<E, S>[] {
		if (!Number.isInteger(record.seq) || record.seq < 1) return this.#restart("gap");
		if (record.seq <= this.#deliveredSeq) return [];
		const state = this.#state;
		if (!state) {
			if (record.seq !== this.#deliveredSeq + 1) return this.#restart("gap");
			this.#deliveredSeq = record.seq;
			this.#ack(record.seq);
			return [this.#eventFrame(record)];
		}
		if (record.seq <= state.barrierSeq) return [];
		const expected =
			state.buffered.length === 0 ? state.barrierSeq + 1 : state.buffered[state.buffered.length - 1]!.seq + 1;
		if (record.seq !== expected) return this.#restart("gap");
		state.buffered.push(record);
		if (state.buffered.length > this.#maxBufferedEvents) return this.#restart("overflow");
		return [];
	}

	acknowledge(seq: number): void {
		if (Number.isInteger(seq) && seq >= this.#deliveredSeq) this.#ack(seq);
	}

	async attachTo(lastSeq?: number): Promise<readonly SnapshotFrame<E, S>[]> {
		return this.#enqueue(async () => {
			if (lastSeq !== undefined) {
				const replay = this.#log.replayAfter(lastSeq);
				if (replay.kind === "replay") {
					this.#deliveredSeq = lastSeq;
					const frames = replay.events.map(record => this.#eventFrame(record));
					if (replay.events.length) this.#deliveredSeq = replay.events[replay.events.length - 1]!.seq;
					this.#ack(this.#deliveredSeq);
					return this.#send(frames);
				}
			}
			const barrierSeq = this.#log.latestSeq;
			const snapshot = await this.#options.snapshot();
			this.#beginSnapshot(snapshot, await this.#chunks(snapshot), barrierSeq);
			return this.#send([{ type: "snapshot_begin", barrierSeq: this.#state!.barrierSeq }]);
		});
	}

	async nextTo(): Promise<readonly SnapshotFrame<E, S>[]> {
		return this.#enqueue(async () => this.#send(this.next()));
	}

	async publishTo(record: EventRecord<E>): Promise<readonly SnapshotFrame<E, S>[]> {
		return this.#enqueue(async () => this.#send(this.publish(record)));
	}

	close(): void {
		this.#log.unregisterAttachment(this.#attachmentId);
		this.#state = undefined;
	}

	#beginSnapshot(snapshot: S, chunks?: readonly S[], barrierSeq = this.#log.latestSeq): void {
		this.#state = {
			barrierSeq,
			chunks: chunks ?? this.#defaultChunks(snapshot),
			chunkIndex: 0,
			buffered: [],
			phase: "chunks",
		};
		this.#deliveredSeq = barrierSeq;
		this.#ack(barrierSeq);
	}

	#defaultChunks(snapshot: S): readonly S[] {
		if (Array.isArray(snapshot)) {
			const chunks: S[] = [];
			for (let index = 0; index < snapshot.length; index += this.#chunkSize) {
				chunks.push(snapshot.slice(index, index + this.#chunkSize) as S);
			}
			return chunks;
		}
		return [snapshot];
	}

	#syncChunks(snapshot: S): readonly S[] {
		if (!this.#options.chunks) return this.#defaultChunks(snapshot);
		const chunks = this.#options.chunks(snapshot);
		if (chunks instanceof Promise) throw new Error("async chunks require attachTo");
		return chunks;
	}

	async #chunks(snapshot: S): Promise<readonly S[]> {
		if (!this.#options.chunks) return this.#defaultChunks(snapshot);
		return await this.#options.chunks(snapshot);
	}

	#flush(state: SnapshotState<E, S>): SnapshotFrame<E, S>[] {
		const frames: SnapshotFrame<E, S>[] = [];
		let expected = state.barrierSeq + 1;
		for (const record of state.buffered) {
			if (record.seq !== expected) {
				return this.#restart("gap");
			}
			frames.push(this.#eventFrame(record));
			expected++;
			this.#deliveredSeq = record.seq;
		}
		this.#ack(this.#deliveredSeq);
		return frames;
	}

	#restart(reason: "overflow" | "gap"): SnapshotFrame<E, S>[] {
		const previousBarrierSeq = this.#state?.barrierSeq ?? this.#deliveredSeq;
		const barrierSeq = this.#log.latestSeq;
		this.#state = undefined;
		const snapshot = this.#options.snapshot();
		if (snapshot instanceof Promise) throw new Error("async snapshot requires publishTo");
		this.#beginSnapshot(snapshot, this.#syncChunks(snapshot), barrierSeq);
		return [
			{ type: "snapshot_restart", reason, previousBarrierSeq },
			{ type: "snapshot_begin", barrierSeq: this.#state!.barrierSeq },
		];
	}

	#eventFrame(record: EventRecord<E>): SnapshotFrame<E, S> {
		return { type: "event", seq: record.seq, event: record.event };
	}

	#ack(seq: number): void {
		this.#log.acknowledge(this.#attachmentId, seq);
	}

	async #send(frames: readonly SnapshotFrame<E, S>[]): Promise<readonly SnapshotFrame<E, S>[]> {
		if (this.#options.sink) for (const frame of frames) await this.#options.sink(frame);
		return frames;
	}

	#enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(task, task);
		this.#queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

/** Short aliases for callers that prefer session/attachment terminology. */
export {
	AttachmentEventStream as AttachmentReplayCoordinator,
	AttachmentEventStream as SnapshotCoordinator,
	OrderedEventLog as SessionEventLog,
	OrderedEventLog as EventLog,
};
