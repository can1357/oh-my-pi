import type { Model, ProviderResponseMetadata, RawSseEvent } from "@oh-my-pi/pi-ai";

const MAX_RAW_SSE_EVENTS = 1_000;
const MAX_RAW_SSE_CHARS = 512_000;
const MAX_RAW_SSE_EVENT_CHARS = 64_000;
// Reserve room for the `: omp-debug-truncated` / `: omp-debug-elided` marker
// lines so a trimmed event stays within MAX_RAW_SSE_EVENT_CHARS overall.
const TRIM_MARKER_RESERVE = 200;
// Caps applied to individual tool entries when compacting a `tools` array
// inside an oversized `data:` payload.
const MAX_TOOL_SCHEMA_CHARS = 200;
const MAX_TOOL_DESCRIPTION_CHARS = 200;

export type RawSseDebugRecord =
	| {
			kind: "response";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			status: number;
			requestId?: string | null;
			transport?: string;
	  }
	| {
			kind: "event";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			event: string | null;
			raw: string[];
			truncated: boolean;
			originalChars: number;
	  };

export interface RawSseDebugSnapshot {
	records: readonly RawSseDebugRecord[];
	droppedRecords: number;
	droppedChars: number;
	totalEvents: number;
	lastUpdatedAt?: number;
}

// Per-record char counts are stored in a parallel array (`#recordChars`) on
// the buffer rather than stamped onto each record via a symbol property.
// Stamping triggered hidden-class transitions in V8/JSC — the previous
// revision saw `trimRawLines` regress 4× (0.5s → 2.0s in a 50s profile)
// because every event-record allocation went through the slow dictionary
// path. The parallel array keeps records as plain monomorphic objects.
type TrimResult = { raw: string[]; truncated: boolean; originalChars: number; chars: number };

// `chars` uses the historical formula `reduce(line.length + 1, init = 1)` so
// the accounting matches the previous `countRecordChars` byte-for-byte (the
// trailing +1 covers the record-level newline that `rawRecordText` appends in
// `toRawText`).
function countLines(lines: readonly string[]): number {
	let chars = 0;
	for (let i = 0; i < lines.length; i++) chars += lines[i].length + 1;
	return chars;
}

function elideText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

// Shrinks one tool definition in place: schemas (`parameters` for OpenAI
// shapes, `input_schema` for Anthropic) become elided JSON strings and long
// descriptions are cut, while `name`/`type` survive untouched. Chat-completions
// nests the payload under `function`.
function compactToolEntry(tool: unknown): boolean {
	if (typeof tool !== "object" || tool === null) return false;
	const obj = tool as Record<string, unknown>;
	let changed = false;
	if (typeof obj.function === "object" && obj.function !== null) {
		changed = compactToolEntry(obj.function);
	}
	for (const key of ["parameters", "input_schema"]) {
		const schema = obj[key];
		if (schema === undefined || schema === null) continue;
		const text = typeof schema === "string" ? schema : JSON.stringify(schema);
		if (text.length <= MAX_TOOL_SCHEMA_CHARS) continue;
		obj[key] = elideText(text, MAX_TOOL_SCHEMA_CHARS);
		changed = true;
	}
	if (typeof obj.description === "string" && obj.description.length > MAX_TOOL_DESCRIPTION_CHARS) {
		obj.description = elideText(obj.description, MAX_TOOL_DESCRIPTION_CHARS);
		changed = true;
	}
	return changed;
}

// Walks a parsed SSE payload and compacts every `tools` array it finds
// (e.g. `response.tools` echoed back by the Responses API). Mutates `node`.
function compactToolsDeep(node: unknown): boolean {
	if (Array.isArray(node)) {
		let changed = false;
		for (const item of node) changed = compactToolsDeep(item) || changed;
		return changed;
	}
	if (typeof node !== "object" || node === null) return false;
	let changed = false;
	const obj = node as Record<string, unknown>;
	for (const key in obj) {
		const value = obj[key];
		if (key === "tools" && Array.isArray(value)) {
			for (const tool of value) changed = compactToolEntry(tool) || changed;
		} else {
			changed = compactToolsDeep(value) || changed;
		}
	}
	return changed;
}

// Rewrites oversized `data:` lines with tool schemas compacted. Returns null
// when nothing changed (unparseable payloads or no tools to shrink). Only
// invoked on events that already blew the budget, so the JSON round-trip is
// off the streaming hot path.
function compactToolLines(raw: readonly string[]): string[] | null {
	let changed = false;
	const out = raw.map(line => {
		if (!line.startsWith("data:") || line.length <= MAX_TOOL_SCHEMA_CHARS) return line;
		const start = line.charCodeAt(5) === 32 ? 6 : 5;
		try {
			const parsed = JSON.parse(line.slice(start));
			if (!compactToolsDeep(parsed)) return line;
			changed = true;
			return `data: ${JSON.stringify(parsed)}`;
		} catch {
			return line;
		}
	});
	return changed ? out : null;
}

// Keeps the first and last portions of an over-budget event and drops the
// middle, so leading fields (id/model/status) AND trailing fields
// (usage/finish_reason) both stay visible. A `: omp-debug-elided` comment
// marks the cut; split lines carry `…` at the cut edge.
function headTailTrim(lines: string[], budget: number, elidedTotal: number): string[] {
	const headBudget = budget >> 1;
	const tailBudget = budget - headBudget;

	let i = 0;
	let headRemaining = headBudget;
	const out: string[] = [];
	while (i < lines.length && lines[i].length + 1 <= headRemaining) {
		headRemaining -= lines[i].length + 1;
		out.push(lines[i]);
		i++;
	}

	let j = lines.length - 1;
	let tailRemaining = tailBudget;
	const tail: string[] = [];
	while (j >= i && lines[j].length + 1 <= tailRemaining) {
		tailRemaining -= lines[j].length + 1;
		tail.push(lines[j]);
		j--;
	}
	tail.reverse();

	let elided = elidedTotal - countLines(out) - countLines(tail);
	if (i <= j) {
		// lines[i..j] straddle the cut: keep a head slice of the first and a
		// tail slice of the last (the same line when i === j).
		const headSlice = lines[i].slice(0, Math.max(0, headRemaining - 2));
		const tailStart =
			i === j
				? Math.max(headSlice.length, lines[j].length - tailRemaining + 2)
				: Math.max(0, lines[j].length - tailRemaining + 2);
		const tailSlice = lines[j].slice(tailStart);
		elided -= headSlice.length + tailSlice.length;
		if (headSlice.length > 0) out.push(`${headSlice}…`);
		out.push(`: omp-debug-elided chars=${Math.max(0, elided)}`);
		if (tailSlice.length > 0) out.push(`…${tailSlice}`);
	} else if (elided > 0) {
		out.push(`: omp-debug-elided chars=${elided}`);
	}
	out.push(...tail);
	return out;
}

// Trim pipeline for one SSE event:
//   1. fits → return `raw` **by reference** (ownership contract at
//      `RawSseDebugBuffer.recordEvent` below).
//   2. over budget → compact tool schemas inside `data:` JSON payloads;
//      if that alone fits, the payload stays parseable JSON.
//   3. still over → head+tail trim (middle elided).
// Any trimmed result ends with the `: omp-debug-truncated` marker carrying
// the original size.
function trimRawLines(raw: string[]): TrimResult {
	const originalChars = countLines(raw);
	if (originalChars <= MAX_RAW_SSE_EVENT_CHARS) {
		return { raw, truncated: false, originalChars, chars: originalChars + 1 };
	}

	const budget = MAX_RAW_SSE_EVENT_CHARS - TRIM_MARKER_RESERVE;
	let lines = compactToolLines(raw) ?? raw;
	const compactedChars = lines === raw ? originalChars : countLines(lines);
	if (compactedChars > budget) {
		lines = headTailTrim(lines, budget, compactedChars);
	} else if (lines === raw) {
		lines = raw.slice();
	}
	lines.push(`: omp-debug-truncated originalChars=${originalChars}`);
	return { raw: lines, truncated: true, originalChars, chars: countLines(lines) + 1 };
}

export function formatRawSseIsoTime(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

export function formatRawSseResponseComment(record: Extract<RawSseDebugRecord, { kind: "response" }>): string {
	const fields = [
		"omp-response",
		`ts=${formatRawSseIsoTime(record.timestamp)}`,
		`status=${record.status}`,
		record.provider ? `provider=${record.provider}` : undefined,
		record.model ? `model=${record.model}` : undefined,
		record.api ? `api=${record.api}` : undefined,
		record.requestId ? `requestId=${record.requestId}` : undefined,
		record.transport ? `transport=${record.transport}` : undefined,
	].filter((field): field is string => field !== undefined);
	return `: ${fields.join(" ")}`;
}

export function rawSseRecordLines(record: RawSseDebugRecord): string[] {
	if (record.kind === "response") return [formatRawSseResponseComment(record)];
	return record.raw;
}

function rawRecordText(record: RawSseDebugRecord): string {
	return `${rawSseRecordLines(record).join("\n")}\n`;
}

function metadataTransport(response: ProviderResponseMetadata): string | undefined {
	const value = response.metadata?.lastTransport;
	return typeof value === "string" ? value : undefined;
}

export class RawSseDebugBuffer {
	#records: RawSseDebugRecord[] = [];
	// Parallel to `#records`: `#recordChars[i]` is the precomputed char count
	// for `#records[i]`. Kept in lockstep by `#append` (push both) and
	// `#enforceLimits` (advance `#head` to evict, then `slice` both together
	// when compacting). See the comment above the class for why this is a
	// sidecar array instead of a per-record property.
	#recordChars: number[] = [];
	// Head-index ring over `#records`/`#recordChars`: index of the oldest live
	// record. Eviction advances `#head` (amortized O(1)) rather than an O(n)
	// front `shift()`; the dead `[0, #head)` prefix is reclaimed lazily by
	// `#enforceLimits`. Live count is `#records.length - #head`; the live
	// records are `#records[#head ..]`.
	#head = 0;
	#totalChars = 0;
	#droppedRecords = 0;
	#droppedChars = 0;
	#totalEvents = 0;
	#lastUpdatedAt: number | undefined;
	#nextSequence = 1;
	#listeners = new Set<() => void>();
	#emitScheduled = false;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	recordResponse(response: ProviderResponseMetadata, model?: Model): void {
		const record: RawSseDebugRecord = {
			kind: "response",
			sequence: this.#nextSequence++,
			timestamp: Date.now(),
			provider: model?.provider,
			model: model?.id,
			api: model?.api,
			status: response.status,
			requestId: response.requestId,
			transport: metadataTransport(response),
		};
		this.#append(record, formatRawSseResponseComment(record).length + 1);
	}

	// Ownership contract for `event.raw`:
	//   The caller (`notifyRawSseEvent` in `packages/ai/src/utils/sse-debug.ts`)
	//   hands us a freshly-allocated `string[]` per event and never retains,
	//   mutates, or re-dispatches it.
	//   That lets `trimRawLines` keep the array by reference instead of
	//   cloning on every chunk — a measurable savings on the streaming hot
	//   path. If a future observer-chain mutates the array, restore the
	//   `raw.slice()` defensive copy inside `trimRawLines`.
	recordEvent(event: RawSseEvent, model?: Model): void {
		const trimmed = trimRawLines(event.raw);
		this.#totalEvents += 1;
		this.#append(
			{
				kind: "event",
				sequence: this.#nextSequence++,
				timestamp: Date.now(),
				provider: model?.provider,
				model: model?.id,
				api: model?.api,
				event: event.event,
				raw: trimmed.raw,
				truncated: trimmed.truncated,
				originalChars: trimmed.originalChars,
			},
			trimmed.chars,
		);
	}

	snapshot(): RawSseDebugSnapshot {
		return {
			records: this.#records.slice(this.#head),
			droppedRecords: this.#droppedRecords,
			droppedChars: this.#droppedChars,
			totalEvents: this.#totalEvents,
			lastUpdatedAt: this.#lastUpdatedAt,
		};
	}

	toRawText(): string {
		// Reads the live window directly: `rawRecordText` only computes a string
		// from each record, so no caller-visible mutation is possible. With a
		// non-empty dead prefix we map a slice past `#head`; `#head === 0` (the
		// common case) maps `#records` in place with no extra copy.
		const live = this.#head === 0 ? this.#records : this.#records.slice(this.#head);
		const body = live.map(rawRecordText).join("\n");
		if (this.#droppedRecords === 0) return body;
		const dropped = `: omp-debug-dropped records=${this.#droppedRecords} chars=${this.#droppedChars}\n\n`;
		return body.length > 0 ? `${dropped}${body}` : dropped;
	}

	/**
	 * Drop every retained record and reset accounting. Called from
	 * {@link AgentSession} teardown so a disposed (e.g. parked subagent) session
	 * stops pinning captured wire frames — each trimmed record holds a
	 * `slice()` of its parent SSE frame, which under JSC keeps the whole
	 * multi-MB frame alive. Notifies subscribers so a live debug viewer redraws
	 * empty.
	 */
	clear(): void {
		this.#records = [];
		this.#recordChars = [];
		this.#head = 0;
		this.#totalChars = 0;
		this.#droppedRecords = 0;
		this.#droppedChars = 0;
		this.#totalEvents = 0;
		this.#lastUpdatedAt = undefined;
		this.#emit();
	}

	#append(record: RawSseDebugRecord, chars: number): void {
		this.#records.push(record);
		this.#recordChars.push(chars);
		this.#totalChars += chars;
		this.#lastUpdatedAt = record.timestamp;
		this.#enforceLimits();
		this.#emit();
	}

	#enforceLimits(): void {
		while (this.#records.length - this.#head > MAX_RAW_SSE_EVENTS || this.#totalChars > MAX_RAW_SSE_CHARS) {
			if (this.#records.length - this.#head === 0) break;
			const chars = this.#recordChars[this.#head] ?? 0;
			this.#head += 1;
			this.#totalChars = Math.max(0, this.#totalChars - chars);
			this.#droppedRecords += 1;
			this.#droppedChars += chars;
		}
		// Reclaim the consumed `[0, #head)` prefix once it grows large: one O(n)
		// memmove amortized over many O(1) evictions, bounding the backing arrays
		// to ~2x the live window. `#head >= MAX_RAW_SSE_EVENTS` covers the
		// full-record-count steady state; `#head > liveCount` covers a small live
		// window held by a few large records under the char budget.
		const liveCount = this.#records.length - this.#head;
		if (this.#head >= MAX_RAW_SSE_EVENTS || this.#head > liveCount) {
			this.#records = this.#records.slice(this.#head);
			this.#recordChars = this.#recordChars.slice(this.#head);
			this.#head = 0;
		}
	}

	#emit(): void {
		const count = this.#listeners.size;
		if (count === 0) return;
		// With a single listener (the common case — RawSse debug viewer is the
		// only subscriber), keep eager emit so per-event semantics are
		// preserved. With multiple listeners, coalesce bursts of events into
		// one microtask-deferred fan-out to avoid N×M listener invocations
		// during a streaming response.
		if (count === 1) {
			this.#fanOut();
			return;
		}
		if (this.#emitScheduled) return;
		this.#emitScheduled = true;
		queueMicrotask(() => {
			this.#emitScheduled = false;
			this.#fanOut();
		});
	}

	#fanOut(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// Debug viewers must not be able to break stream capture.
			}
		}
	}
}

const globalFallbackBuffer = new RawSseDebugBuffer();
const kRawSseDebugBuffer = Symbol("debug.rawSseBuffer");
type OwnerWithBuffer = object & { rawSseDebugBuffer?: unknown; [kRawSseDebugBuffer]?: RawSseDebugBuffer };

export function resolveRawSseDebugBuffer(owner?: object): RawSseDebugBuffer {
	if (!owner) return globalFallbackBuffer;

	const tagged = owner as OwnerWithBuffer;
	const declared = tagged.rawSseDebugBuffer;
	if (declared instanceof RawSseDebugBuffer) return declared;

	const existing = tagged[kRawSseDebugBuffer];
	if (existing) return existing;

	const buffer = new RawSseDebugBuffer();
	try {
		tagged[kRawSseDebugBuffer] = buffer;
	} catch {
		// Non-extensible owner: caller gets a fresh buffer on each call.
	}
	return buffer;
}
