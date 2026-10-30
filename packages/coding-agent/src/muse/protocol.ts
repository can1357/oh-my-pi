/**
 * Parser for `muse exec --json` stdout.
 *
 * Exec 1.4.14-R7309.1 emits the experimental *raw-log* record envelope
 * (`schema_version`, `stream`, `sequence`, `payload_type`, `payload`, ...),
 * not the `{method, params}` view notification the stable export describes.
 * `payload` is explicitly unstable and the `payload_type` vocabulary is open,
 * so this parser reads only the fields it understands and never forwards raw
 * payloads to the model. A stdout line that is not a usable record envelope
 * (not JSON, failed envelope validation, or over the line cap) fails the run;
 * unknown payload types and unstable payload shapes are skipped with a
 * warning and never decide the run status.
 *
 * A successful run contains `task.lifecycle.failed` records (they come from
 * reminder/subagent tasks) and still terminates with `run.terminal.completed`;
 * task lifecycle is activity, never a run failure. Only a `run.terminal.*`
 * record decides the run status, and only the observed `"completed"` value is
 * treated as success. Other terminal values are surfaced as unverified failure
 * shapes, and EOF without any terminal record is `incomplete` even at exit 0.
 */
import { type } from "@oh-my-pi/omptype";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Hard cap for one JSONL line; a longer line fails the run instead of being buffered. */
export const MUSE_MAX_LINE_CHARS = 8 * 1024 * 1024;
/** Final answer cap. The terminal record repeats the whole answer. */
export const MUSE_MAX_ANSWER_BYTES = 256 * 1024;
/** Bounded delta transcript kept for diagnostics; it is never returned as the answer. */
export const MUSE_MAX_DELTA_BYTES = 64 * 1024;
/** One streamed delta preview; a captured echo delta can be several MB. */
export const MUSE_MAX_EVENT_DELTA_BYTES = 8 * 1024;
export const MUSE_MAX_STDERR_BYTES = 8 * 1024;
export const MUSE_MAX_USAGE_MODELS = 16;
export const MUSE_MAX_TASK_IDS = 256;
export const MUSE_MAX_SEEN_IDS = 4096;
export const MUSE_MAX_WARNINGS = 32;

export type MuseExecRunStatus = "completed" | "failed" | "incomplete" | "running";

export interface MuseExecTaskCounts {
	/** Distinct task ids observed in `task.lifecycle.*` / `task.stream.linked`. */
	total: number;
	/** `task.lifecycle.failed` count. Activity, not run failure. */
	failed: number;
	/** `task.lifecycle.cancelled` count. Activity, not run failure. */
	cancelled: number;
}

export interface MuseExecUsageModel {
	model: string;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cachedTokens: number;
}

export interface MuseExecUsage {
	calls: number;
	completedCalls: number;
	failedCalls: number;
	cancelledCalls: number;
	childrenIncluded: boolean;
	allowance: string | null;
	models: MuseExecUsageModel[];
}

export interface MuseExecOutcome {
	/** `completed` only for an observed `run.terminal.completed` record. */
	status: Exclude<MuseExecRunStatus, "running">;
	/** Sanitized raw terminal value (open vocabulary), or null when none arrived. */
	terminal: string | null;
	reason: string | null;
	answer: string;
	answerBytes: number;
	answerTruncated: boolean;
	/** Concatenated `run.output.delta` text, bounded. Diagnostics only. */
	deltaText: string;
	deltaBytes: number;
	deltaTruncated: boolean;
	deltaCount: number;
	usage: MuseExecUsage | null;
	tasks: MuseExecTaskCounts;
	/** JSONL records whose envelope was understood. */
	records: number;
	/** Records whose payload did not match the expected shape for a known type. */
	skippedLines: number;
	/** Understood records whose payload type this parser does not know. */
	unknownPayloads: number;
	/** Records repeated by envelope `id`. */
	duplicates: number;
	/** Sanitized, bounded diagnostic lines. */
	warnings: string[];
}

export type MuseExecStreamEvent =
	| { type: "delta"; text: string }
	| { type: "terminal"; terminal: string | null }
	| { type: "usage" }
	| { type: "task"; taskKind: string };

export interface MuseSanitizedText {
	text: string;
	bytes: number;
	truncated: boolean;
}

// Only the envelope this version emits is required. Extra members are ignored
// so a client-side schema change degrades to "unknown fields", not a parse stop.
const envelopeSchema = type({
	"id?": "string",
	payload_type: "string",
	payload: "object",
});

type MuseExecEnvelope = typeof envelopeSchema.infer;

const deltaPayloadSchema = type({ "text?": "string" });

const terminalPayloadSchema = type({
	"text?": "string",
	"terminal?": "string",
	"reason?": "string | null",
});

const usageModelSchema = type({
	"model?": "string | null",
	"calls?": "number",
	"input_tokens?": "number",
	"output_tokens?": "number",
	"reasoning_tokens?": "number",
	"cached_tokens?": "number",
});

const usagePayloadSchema = type({
	"calls?": "number",
	"completed_calls?": "number",
	"failed_calls?": "number",
	"cancelled_calls?": "number",
	"children_included?": "boolean",
	"allowance?": "unknown",
	"models?": usageModelSchema.array(),
});

const taskEventSchema = type({
	"task_id?": "string",
	"task_kind?": "string",
	"kind?": "string",
	"reason?": "string | null",
});

const taskPayloadSchema = type({
	"task_id?": "string",
	"task_kind?": "string",
	"event?": "object",
});

/** Sanitize and truncate text on a UTF-8 byte boundary. */
export function sanitizeMuseText(value: string | null | undefined, maxBytes: number): MuseSanitizedText {
	if (typeof value !== "string") return { text: "", bytes: 0, truncated: false };
	const sanitized = sanitizeText(value);
	const bytes = Buffer.byteLength(sanitized, "utf8");
	if (bytes <= maxBytes) return { text: sanitized, bytes, truncated: false };
	let cut = Buffer.from(sanitized, "utf8").subarray(0, maxBytes).toString("utf8");
	// A cut through a multibyte sequence ends in U+FFFD; drop the partial char.
	if (cut.endsWith("\ufffd")) cut = cut.slice(0, -1);
	return {
		text: `${cut}\n[… truncated: ${bytes - maxBytes} bytes omitted]`,
		bytes,
		truncated: true,
	};
}

function finiteCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return Math.floor(value);
}

function parseUsage(payload: object): MuseExecUsage {
	const parsed = usagePayloadSchema.assert(payload);
	const models: MuseExecUsageModel[] = [];
	for (const raw of (parsed.models ?? []).slice(0, MUSE_MAX_USAGE_MODELS)) {
		models.push({
			model: sanitizeMuseText(raw.model, 200).text,
			calls: finiteCount(raw.calls),
			inputTokens: finiteCount(raw.input_tokens),
			outputTokens: finiteCount(raw.output_tokens),
			reasoningTokens: finiteCount(raw.reasoning_tokens),
			cachedTokens: finiteCount(raw.cached_tokens),
		});
	}
	const allowance = parsed.allowance;
	let allowanceText: string | null = null;
	if (typeof allowance === "string") allowanceText = sanitizeMuseText(allowance, 200).text;
	else if (allowance !== null && allowance !== undefined) {
		allowanceText = sanitizeMuseText(JSON.stringify(allowance), 200).text;
	}
	return {
		calls: finiteCount(parsed.calls),
		completedCalls: finiteCount(parsed.completed_calls),
		failedCalls: finiteCount(parsed.failed_calls),
		cancelledCalls: finiteCount(parsed.cancelled_calls),
		childrenIncluded: parsed.children_included === true,
		allowance: allowanceText,
		models,
	};
}

/** Incremental, bounded state machine over decoded stdout lines. */
export class MuseExecStreamParser {
	readonly #seenIds = new Set<string>();
	readonly #taskIds = new Set<string>();
	#answer: MuseSanitizedText = { text: "", bytes: 0, truncated: false };
	#delta = "";
	#deltaBytes = 0;
	#deltaTruncated = false;
	#deltaCount = 0;
	#terminal: string | null = null;
	#reason: string | null = null;
	#status: "completed" | "failed" | "incomplete" | "unterminated" = "unterminated";
	#usage: MuseExecUsage | null = null;
	#tasks: MuseExecTaskCounts = { total: 0, failed: 0, cancelled: 0 };
	#records = 0;
	#skippedLines = 0;
	#unknownPayloads = 0;
	#duplicates = 0;
	#warnings: string[] = [];

	#warn(message: string): void {
		if (this.#warnings.length >= MUSE_MAX_WARNINGS) return;
		this.#warnings.push(sanitizeMuseText(message, 400).text);
	}

	/**
	 * Parse one stdout line. Returns a sanitized stream event for callers that
	 * stream progress, or undefined for lines with no externally useful event.
	 * Throws `ToolError` when the line is not a usable record envelope.
	 */
	pushLine(line: string): MuseExecStreamEvent | undefined {
		if (line.trim().length === 0) return undefined;
		if (line.length > MUSE_MAX_LINE_CHARS) {
			throw new ToolError(`Muse exec emitted a stdout line over ${MUSE_MAX_LINE_CHARS} characters.`);
		}
		let record: MuseExecEnvelope;
		try {
			record = envelopeSchema.assert(JSON.parse(line));
		} catch {
			throw new ToolError("Muse exec emitted a stdout line that is not a JSONL record envelope.");
		}
		const id = record.id;
		if (id) {
			if (this.#seenIds.has(id)) {
				this.#duplicates++;
				return undefined;
			}
			if (this.#seenIds.size >= MUSE_MAX_SEEN_IDS) this.#seenIds.clear();
			this.#seenIds.add(id);
		}
		this.#records++;
		try {
			return this.#consume(record.payload_type, record.payload);
		} catch {
			// A future payload shape for a known type must not end the run: skip it
			// and let the terminal record decide. The vocabulary is unstable.
			this.#skippedLines++;
			this.#warn(`Skipped ${record.payload_type}: payload fields did not match the expected shape`);
			return undefined;
		}
	}

	#consume(payloadType: string, payload: object): MuseExecStreamEvent | undefined {
		if (payloadType === "run.output.delta") {
			const rawDelta = deltaPayloadSchema.assert(payload).text;
			const event = sanitizeMuseText(rawDelta, MUSE_MAX_EVENT_DELTA_BYTES);
			const text = rawDelta === undefined ? "" : sanitizeText(rawDelta);
			this.#deltaCount++;
			const bytes = Buffer.byteLength(text, "utf8");
			if (!this.#deltaTruncated) {
				const remaining = MUSE_MAX_DELTA_BYTES - this.#deltaBytes;
				if (bytes <= remaining) {
					this.#delta += text;
					this.#deltaBytes += bytes;
				} else {
					const head = Buffer.from(text, "utf8").subarray(0, Math.max(0, remaining)).toString("utf8");
					this.#delta += head.endsWith("\ufffd") ? head.slice(0, -1) : head;
					this.#deltaTruncated = true;
				}
			}
			return { type: "delta", text: event.text };
		}

		if (payloadType.startsWith("run.terminal.") || payloadType === "run.terminal") {
			const terminalPayload = terminalPayloadSchema.assert(payload);
			this.#terminal = sanitizeMuseText(terminalPayload.terminal, 200).text || null;
			this.#reason = sanitizeMuseText(terminalPayload.reason, 2000).text || null;
			this.#answer = sanitizeMuseText(terminalPayload.text, MUSE_MAX_ANSWER_BYTES);
			// Only the observed value is trusted as success. The terminal value
			// set is not defined; anything else is surfaced, never assumed benign.
			this.#status = this.#terminal === "completed" ? "completed" : "failed";
			return { type: "terminal", terminal: this.#terminal };
		}

		if (payloadType === "run.usage") {
			this.#usage = parseUsage(payload);
			return { type: "usage" };
		}

		if (payloadType.startsWith("task.lifecycle.") || payloadType === "task.stream.linked") {
			const taskPayload = taskPayloadSchema.assert(payload);
			const event = taskPayload.event === undefined ? undefined : taskEventSchema.assert(taskPayload.event);
			const taskId = taskPayload.task_id ?? event?.task_id;
			if (taskId && !this.#taskIds.has(taskId)) {
				if (this.#taskIds.size >= MUSE_MAX_TASK_IDS) this.#taskIds.clear();
				this.#taskIds.add(taskId);
				this.#tasks.total++;
			}
			if (payloadType === "task.lifecycle.failed") {
				this.#tasks.failed++;
				this.#warn(
					`task.lifecycle.failed for ${sanitizeMuseText(event?.task_kind ?? payloadType, 120).text}; task activity, not a run failure`,
				);
			} else if (payloadType === "task.lifecycle.cancelled") {
				this.#tasks.cancelled++;
			}
			const taskKind = event?.task_kind ?? taskPayload.task_kind ?? payloadType;
			return { type: "task", taskKind: sanitizeMuseText(taskKind, 120).text };
		}

		// runtime.command.accepted, session.run.linked, turn.input.user, and
		// run.lifecycle.started are intentionally ignored: they carry the
		// prompt or internal stream ids, neither of which belongs in results.
		if (
			payloadType === "runtime.command.accepted" ||
			payloadType === "session.run.linked" ||
			payloadType === "turn.input.user" ||
			payloadType === "run.lifecycle.started"
		) {
			return undefined;
		}

		this.#unknownPayloads++;
		return undefined;
	}

	/** Snapshot the result; a missing terminal record is `incomplete`. */
	finish(): MuseExecOutcome {
		const status = this.#status === "unterminated" ? "incomplete" : this.#status;
		const warnings = [...this.#warnings];
		if (status === "incomplete") {
			warnings.push("Stream ended without a run.terminal.* record");
		}
		return {
			status,
			terminal: this.#terminal,
			reason: this.#reason,
			answer: this.#answer.text,
			answerBytes: this.#answer.bytes,
			answerTruncated: this.#answer.truncated,
			deltaText: this.#delta,
			deltaBytes: this.#deltaBytes,
			deltaTruncated: this.#deltaTruncated,
			deltaCount: this.#deltaCount,
			usage: this.#usage,
			tasks: { ...this.#tasks },
			records: this.#records,
			skippedLines: this.#skippedLines,
			unknownPayloads: this.#unknownPayloads,
			duplicates: this.#duplicates,
			warnings,
		};
	}
}
