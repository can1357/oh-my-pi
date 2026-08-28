/**
 * Event gateway — the single ingestion point for memory-lifecycle events.
 *
 * Every memory write flows through here: the gateway redacts (via an
 * injected redactor port), truncates, builds a canonical record with
 * {@link createMemoryRecord} (crypto-random ids, SHA-256 content hash),
 * validates it with {@link validateMemoryRecord}, and hands a
 * {@link LifecycleEventDraft} to an injected {@link EventSinkPort}.
 *
 * Design decisions, deliberate and documented:
 *   - **Ports, not imports.** The journal and the redactor are injected
 *     interfaces. The gateway never touches storage or redaction internals,
 *     so any journal (the SQLite `persistence/event-journal.ts`, an
 *     in-memory test sink) and any redactor can sit behind it.
 *   - **The sink owns sequence numbers.** The gateway emits drafts without
 *     `seq`; whichever journal persists the event assigns it. Two counters
 *     racing over the same sequence is how duplicate seqs happen.
 *   - **Writes are serialized on a promise chain**, not a busy-wait poll:
 *     each append is chained onto the previous one, and `flush()` simply
 *     awaits the current tail. No timers, no spinning.
 *   - **Failures are counted, not printed.** A failed sink append invokes
 *     the optional `onError` callback and increments `droppedWrites`;
 *     library code never writes to the console.
 *   - **Time is injectable** (`now`) so tests are deterministic.
 */

import type { LifecycleCheckpointData, LifecycleMaintenanceData, MemoryLifecycleEvent } from "./event-timeline";
import type { ScopingContext } from "./scoping";
import type { CreateMemoryRecordInput, MemoryRecordType, SourceReference } from "./types";
import { createMemoryRecord, validateMemoryRecord } from "./types";

/** A lifecycle event before the persisting sink assigns its `seq`. */
export type LifecycleEventDraft = Omit<MemoryLifecycleEvent, "seq">;

/** Where lifecycle events go. Implemented by journals and test doubles. */
export interface EventSinkPort {
	append(event: LifecycleEventDraft): void | Promise<void>;
}

/** Text/object redaction port. R6's secret redactor implements this shape. */
export interface RedactorPort {
	/** Redact secrets from free text; reports whether anything was found. */
	redactText(text: string): { redacted: string; hasSecrets: boolean };
	/** Redact secrets from a structured payload (returns a new object). */
	redactObject(value: Record<string, unknown>): Record<string, unknown>;
}

export interface EventGatewayConfig {
	/** Sink that persists lifecycle events (journal-backed in production). */
	sink: EventSinkPort;
	/** Scope stamped onto every record this gateway produces. */
	scope: ScopingContext;
	/** Redactor port; only consulted when `redactSecrets` is true. */
	redactor?: RedactorPort;
	/** Master switch for redaction. Off = content passes through untouched. */
	redactSecrets?: boolean;
	/** Content longer than this is truncated (with a marker). */
	maxContentLength?: number;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
	/** Called with each sink failure; failures never throw out of the queue. */
	onError?: (error: unknown) => void;
}

export interface EventGatewayResult {
	recordId: string;
	contentHash: string;
	redacted: boolean;
}

/** Inputs accepted by {@link EventGateway.recordEvent}. */
export interface RecordEventInput {
	type: MemoryRecordType;
	content: string;
	structured?: Record<string, unknown>;
	sourceRefs: SourceReference[];
	tags?: string[];
	confidence?: number;
	importance?: number;
	sensitivity?: CreateMemoryRecordInput["sensitivity"];
	verification?: CreateMemoryRecordInput["verification"];
	validFrom?: string;
	validUntil?: string;
	expiresAt?: string;
	supersedes?: string[];
}

export const EVIDENCE_TYPES = [
	"user-message",
	"assistant-message",
	"tool-result",
	"file-snapshot",
	"test-result",
	"build-result",
	"git-metadata",
	"user-correction",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

const DEFAULT_MAX_CONTENT_LENGTH = 65536;
const TRUNCATION_MARKER = "...[TRUNCATED]";

export class EventGateway {
	readonly #sink: EventSinkPort;
	readonly #scope: ScopingContext;
	readonly #redactor: RedactorPort | undefined;
	readonly #redactSecrets: boolean;
	readonly #maxContentLength: number;
	readonly #now: () => Date;
	readonly #onError: ((error: unknown) => void) | undefined;
	/** Tail of the serialized write chain; `flush()` awaits this. */
	#tail: Promise<void> = Promise.resolve();
	#droppedWrites = 0;

	constructor(config: EventGatewayConfig) {
		this.#sink = config.sink;
		this.#scope = config.scope;
		this.#redactor = config.redactor;
		this.#redactSecrets = config.redactSecrets === true;
		this.#maxContentLength =
			typeof config.maxContentLength === "number" && config.maxContentLength > 0
				? Math.floor(config.maxContentLength)
				: DEFAULT_MAX_CONTENT_LENGTH;
		this.#now = config.now ?? (() => new Date());
		this.#onError = config.onError;
	}

	/** Number of sink appends that failed (and were reported to `onError`). */
	get droppedWrites(): number {
		return this.#droppedWrites;
	}

	/** Record a memory event: redact, truncate, build, validate, enqueue. */
	recordEvent(input: RecordEventInput): EventGatewayResult {
		let content = input.content;
		let structured = input.structured;
		let redacted = false;

		if (this.#redactSecrets && this.#redactor) {
			const result = this.#redactor.redactText(content);
			content = result.redacted;
			redacted = result.hasSecrets;
			if (structured) structured = this.#redactor.redactObject(structured);
		}

		if (content.length > this.#maxContentLength) {
			content = `${content.slice(0, this.#maxContentLength)}${TRUNCATION_MARKER}`;
		}

		const record = createMemoryRecord({
			type: input.type,
			projectId: this.#scope.projectId,
			worktreeId: this.#scope.worktreeId,
			branchId: this.#scope.branchId,
			sessionId: this.#scope.sessionId,
			taskId: this.#scope.taskId,
			agentId: this.#scope.agentId,
			content,
			structured,
			sourceRefs: input.sourceRefs,
			tags: input.tags,
			confidence: input.confidence,
			importance: input.importance,
			sensitivity: input.sensitivity,
			verification: input.verification,
			validFrom: input.validFrom,
			validUntil: input.validUntil,
			expiresAt: input.expiresAt,
			supersedes: input.supersedes,
		});

		if (!validateMemoryRecord(record)) {
			throw new Error(`EventGateway.recordEvent produced an invalid ${input.type} record`);
		}
		if (record.type !== "evidence" && record.sourceRefs.length === 0) {
			throw new Error("Derived records must carry at least one sourceRef");
		}

		this.#enqueue({
			type: "memory-write",
			timestamp: record.createdAt,
			sessionId: this.#scope.sessionId,
			recordId: record.id,
			record,
		});

		return { recordId: record.id, contentHash: record.contentHash, redacted };
	}

	/** Record raw evidence (convenience wrapper over {@link recordEvent}). */
	recordEvidence(evidenceType: EvidenceType, payload: unknown, sourceRef: SourceReference): EventGatewayResult {
		const isCorrection = evidenceType === "user-correction";
		return this.recordEvent({
			type: "evidence",
			content: JSON.stringify({ evidenceType, payload }),
			structured: { evidenceType, payload },
			sourceRefs: [sourceRef],
			tags: ["evidence", evidenceType],
			confidence: isCorrection ? 1.0 : 0.8,
			importance: isCorrection ? 1.0 : 0.5,
			sensitivity: "project",
			verification: "observed",
		});
	}

	/** Record a working-state checkpoint lifecycle event. */
	recordCheckpoint(checkpointId: string, data: LifecycleCheckpointData): void {
		this.#enqueue({
			type: "checkpoint",
			timestamp: this.#now().toISOString(),
			sessionId: this.#scope.sessionId,
			recordId: checkpointId,
			checkpoint: data,
		});
	}

	/** Record a maintenance lifecycle event (decay, dedup, compaction, ...). */
	recordMaintenance(operation: string, affectedIds: readonly string[], details?: Record<string, unknown>): void {
		const maintenance: LifecycleMaintenanceData & { details?: Record<string, unknown> } = {
			operation,
			affectedIds: [...affectedIds],
		};
		if (details) maintenance.details = details;
		this.#enqueue({
			type: "maintenance",
			timestamp: this.#now().toISOString(),
			sessionId: this.#scope.sessionId,
			maintenance,
		});
	}

	/** Record a deletion lifecycle event for an existing record. */
	recordDeletion(recordId: string): void {
		this.#enqueue({
			type: "memory-delete",
			timestamp: this.#now().toISOString(),
			sessionId: this.#scope.sessionId,
			recordId,
		});
	}

	/** Resolve when every enqueued sink append so far has settled. */
	flush(): Promise<void> {
		return this.#tail;
	}

	/** Chain an append onto the serialized write queue; failures are counted. */
	#enqueue(event: LifecycleEventDraft): void {
		this.#tail = this.#tail
			.then(() => this.#sink.append(event))
			.catch(error => {
				this.#droppedWrites += 1;
				try {
					this.#onError?.(error);
				} catch {
					// An error handler that itself throws must not break the queue.
				}
			});
	}
}
