import type { AssistantMessage } from "../types";

/** Classification of one Responses SSE event for commit / failover. */
export type CommitClass = "metadata" | "output" | "terminal-success" | "terminal-retryable" | "terminal-failure";

export type StreamCommitState = "probing" | "committed" | "terminated";

const DEFAULT_MAX_PRELUDE_BYTES = 4 * 1024 * 1024;
const STREAM_PRELUDE_MAX_BYTES = 4 * 1024 * 1024;

/** Downstream SSE observer is used for Responses; upstream onSseEvent must not also feed the gate. */
export function commitGateObservesDownstreamSse(formatLabel: string): boolean {
	return formatLabel === "openai-responses";
}

const METADATA_EVENTS: Record<string, true> = {
	"response.created": true,
	"response.in_progress": true,
	"response.queued": true,
	"response.output_item.added": true,
	"response.content_part.added": true,
	start: true,
	text_start: true,
	thinking_start: true,
	toolcall_start: true,
	message_start: true,
	heartbeat: true,
	ping: true,
};

/**
 * Prelude gate for Responses SSE. Metadata events stay in `probing`; the first
 * output (or unknown) event, or a 4 MiB prelude cap, commits the stream so a
 * later retryable terminal cannot uncommit. There is no time cap.
 */
export class StreamCommitGate {
	#state: StreamCommitState = "probing";
	#bytes = 0;
	#maxPreludeBytes: number;
	#prelude: Uint8Array[] = [];
	#preludeBytes = 0;

	constructor(maxPreludeBytes: number = DEFAULT_MAX_PRELUDE_BYTES) {
		this.#maxPreludeBytes = maxPreludeBytes;
	}

	get state(): StreamCommitState {
		return this.#state;
	}

	/** Reset to probing for the next fallback attempt (clears prelude). */
	reset(): void {
		this.#state = "probing";
		this.#bytes = 0;
		this.#prelude = [];
		this.#preludeBytes = 0;
	}

	classifyAndObserve(eventType: string, byteLength: number): StreamCommitState {
		if (this.#state === "terminated") return this.#state;

		if (this.#state === "probing") {
			const add = byteLength > 0 ? byteLength : 0;
			this.#bytes = Math.min(this.#bytes + add, this.#maxPreludeBytes);
			if (this.#bytes >= this.#maxPreludeBytes) {
				this.#state = "committed";
			}
		}

		const kind = classifyCommitEvent(eventType);
		if (this.#state === "committed") {
			// Post-commit, every terminal event ends the stream's failover
			// eligibility — including `response.failed` (retryable elsewhere),
			// whose failure must surface to the client instead of re-dispatching.
			if (kind === "terminal-success" || kind === "terminal-retryable" || kind === "terminal-failure") {
				this.#state = "terminated";
			}
			return this.#state;
		}

		if (kind === "output") {
			this.#state = "committed";
			return this.#state;
		}
		if (kind === "terminal-success" || kind === "terminal-retryable" || kind === "terminal-failure") {
			this.#state = "terminated";
			return this.#state;
		}
		return this.#state;
	}

	/** Raw bytes buffered while probing (held frames only). */
	get preludeByteLength(): number {
		return this.#preludeBytes;
	}

	/**
	 * Buffer a raw pre-commit chunk for a HOLDING consumer (one that has not
	 * forwarded it downstream yet). Bounded: returns false once the prelude
	 * cap is reached, forcing the hold to commit rather than grow unboundedly.
	 * The forwarding observation path must not double-buffer.
	 */
	bufferPrelude(chunk: Uint8Array): boolean {
		if (this.#state !== "probing") return false;
		if (this.#preludeBytes + chunk.byteLength > this.#maxPreludeBytes) return false;
		this.#prelude.push(chunk);
		this.#preludeBytes += chunk.byteLength;
		return true;
	}

	/**
	 * Discard and return the held prelude of a FAILED pre-commit attempt — the
	 * failover path drops these frames (they belong to the dead attempt) and
	 * the replacement attempt's stream starts from its own first byte, so the
	 * client observes exactly one response. Committed/terminated gates have no
	 * takeable prelude.
	 */
	takePrelude(): Uint8Array[] | undefined {
		if (this.#prelude.length === 0) return undefined;
		const out = this.#prelude;
		this.#prelude = [];
		this.#preludeBytes = 0;
		return out;
	}
}

/** Thrown/streamed when a held stream hits a pre-commit retryable terminal. */
export class PreludeAbortedError extends Error {
	readonly frames: Uint8Array[];
	constructor(frames: Uint8Array[], eventType: string) {
		super(`upstream stream ended before commit (${eventType})`);
		this.name = "PreludeAbortedError";
		this.frames = frames;
	}
}

export function classifyCommitEvent(eventType: string): CommitClass {
	if (!eventType) return "output";
	if (METADATA_EVENTS[eventType]) return "metadata";
	if (eventType === "response.completed") return "terminal-success";
	if (eventType === "response.failed") return "terminal-retryable";
	if (eventType === "response.incomplete") return "terminal-success";
	if (eventType === "response.error") return "terminal-failure";
	return "output";
}

function nextSseFrame(pending: string): { frame: string; rest: string } | undefined {
	const crlf = pending.indexOf("\r\n\r\n");
	const lf = pending.indexOf("\n\n");
	let index = -1;
	let delimLen = 0;
	if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
		index = crlf;
		delimLen = 4;
	} else if (lf >= 0) {
		index = lf;
		delimLen = 2;
	}
	if (index < 0) return undefined;
	return { frame: pending.slice(0, index), rest: pending.slice(index + delimLen) };
}

function eventTypeFromFrame(frame: string): string {
	let eventType = "";
	for (const line of frame.split(/\r?\n/)) {
		if (line.startsWith("event:")) eventType = line.slice(6).trim();
	}
	return eventType;
}

/**
 * HOLD path for seamless pre-commit failover: unlike {@link observeSseCommit},
 * pre-commit frames are buffered — never forwarded — so a dead attempt's
 * metadata never reaches the client. On commit, the held prelude flushes and
 * the live stream forwards unchanged. A pre-commit retryable/failure terminal
 * aborts with {@link PreludeAbortedError} carrying the drained frames, letting
 * the failover loop discard them and dispatch a replacement attempt the client
 * cannot distinguish from the first.
 */
export function holdSseUntilCommit(
	stream: ReadableStream<Uint8Array>,
	gate: StreamCommitGate,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let pending = "";
	let committed = false;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (committed) {
					controller.enqueue(chunk);
					return;
				}
				const buffered = gate.bufferPrelude(chunk);
				pending += decoder.decode(chunk, { stream: true });
				let next = nextSseFrame(pending);
				while (next) {
					const eventType = eventTypeFromFrame(next.frame);
					const state = gate.classifyAndObserve(eventType, next.frame.length);
					pending = next.rest;
					next = nextSseFrame(pending);
					if (state === "terminated" && !(classifyCommitEvent(eventType) === "terminal-success")) {
						throw new PreludeAbortedError(gate.takePrelude() ?? [], eventType);
					}
					if (state === "committed" || classifyCommitEvent(eventType) === "terminal-success") {
						committed = true;
						for (const held of gate.takePrelude() ?? []) controller.enqueue(held);
						if (!buffered) controller.enqueue(chunk);
						return;
					}
				}
				if (!buffered) {
					// Cap crossed: force commit observation and keep the rejected chunk.
					gate.classifyAndObserve("", chunk.byteLength);
					committed = true;
					for (const held of gate.takePrelude() ?? []) controller.enqueue(held);
					controller.enqueue(chunk);
				}
			},
			flush(controller) {
				if (committed) return;
				const held = gate.takePrelude() ?? [];
				if (held.length === 0) return;
				gate.classifyAndObserve("", 0);
				for (const chunk of held) controller.enqueue(chunk);
			},
		}),
	);
}

type SseRead = { done: boolean; value?: Uint8Array };

export type HeldSse =
	| { type: "forward"; stream: ReadableStream<Uint8Array> }
	| { type: "failed"; error: unknown; message?: AssistantMessage };

function concatSsePrelude(
	prelude: Uint8Array[],
	reader: { read(): Promise<SseRead>; cancel(reason?: unknown): Promise<void> },
	pending: Promise<SseRead> | undefined,
): ReadableStream<Uint8Array> {
	let pendingRead = pending;
	let preludeOffset = 0;
	return new ReadableStream({
		async pull(controller) {
			if (preludeOffset < prelude.length) {
				const chunk = prelude[preludeOffset];
				preludeOffset += 1;
				if (chunk) controller.enqueue(chunk);
				return;
			}
			const read = pendingRead ?? reader.read();
			pendingRead = undefined;
			const { done, value } = await read;
			if (done || value === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

function encodedChunkHasOutput(chunk: Uint8Array): boolean {
	const text = new TextDecoder().decode(chunk);
	if (text.includes("[DONE]")) return false;
	if (/(?:\"type\"\s*:\s*\"error\"|\"error\"\s*:)/.test(text)) return false;
	if (/\"type\"\s*:\s*\"(?:start|message_start)\"/.test(text)) return false;
	return !/\"role\"\s*:\s*\"assistant\"/.test(text) || /\"(?:content|tool_calls|reasoning_content)\"\s*:/.test(text);
}

/**
 * Gateway hold path with canonical-result awareness. It buffers encoded bytes
 * until the gate commits or the provider result settles, then either forwards
 * the complete prelude or returns the settled failure for conductor handling.
 */
export async function holdSseUntilCommitOutcome(
	sseStream: ReadableStream<Uint8Array>,
	gate: StreamCommitGate,
	settled: Promise<AssistantMessage>,
	commitOnFirstEncodedByte = false,
): Promise<HeldSse> {
	const reader = sseStream.getReader();
	const prelude: Uint8Array[] = [];
	let preludeBytes = 0;
	let pendingRead: Promise<SseRead> | undefined;
	let settleOutcome: { ok: true; message: AssistantMessage } | { ok: false; error: unknown } | undefined;
	const watchSettled = settled.then(
		message => {
			settleOutcome = { ok: true, message };
		},
		(error: unknown) => {
			settleOutcome = { ok: false, error };
		},
	);

	const forward = (): HeldSse => ({
		type: "forward",
		stream: concatSsePrelude(prelude, reader, pendingRead),
	});
	const failedFromOutcome = (): HeldSse => {
		if (!settleOutcome) return { type: "failed", error: "Upstream request failed" };
		if (!settleOutcome.ok) return { type: "failed", error: settleOutcome.error };
		return {
			type: "failed",
			error: settleOutcome.message.errorMessage ?? settleOutcome.message,
			message: settleOutcome.message,
		};
	};

	try {
		while (true) {
			if (gate.state === "committed") return forward();
			if (preludeBytes >= STREAM_PRELUDE_MAX_BYTES) {
				if (gate.state === "probing") gate.classifyAndObserve("", STREAM_PRELUDE_MAX_BYTES);
				return forward();
			}
			if (settleOutcome) {
				if (!settleOutcome.ok) return failedFromOutcome();
				const reason = settleOutcome.message.stopReason;
				if (reason === "error" || reason === "aborted") return failedFromOutcome();
				if (gate.state === "probing") gate.classifyAndObserve("", STREAM_PRELUDE_MAX_BYTES);
				return forward();
			}
			pendingRead ??= reader.read();
			const raced = await Promise.race([
				pendingRead.then(r => ({ source: "read" as const, r })),
				watchSettled.then(() => ({ source: "settled" as const })),
			]);
			if (raced.source === "settled") continue;
			pendingRead = undefined;
			const { done, value } = raced.r;
			if (done || value === undefined) {
				await watchSettled;
				continue;
			}
			prelude.push(value);
			preludeBytes += value.byteLength;
			if (commitOnFirstEncodedByte && gate.state === "probing") {
				// Give a same-turn canonical failure a chance to settle before the
				// provider's initial role/start frame commits the attempt.
				await Promise.resolve();
				if (settleOutcome) continue;
				if (encodedChunkHasOutput(value)) gate.classifyAndObserve("response.output_text.delta", value.byteLength);
			}
		}
	} catch (error) {
		return { type: "failed", error };
	}
}

/**
 * Observe encoded SSE bytes into a {@link StreamCommitGate} without altering the
 * downstream payload. Used by the gateway streaming path so a pre-commit
 * `response.failed` can be classified (Wave A does not failover yet).
 */
export function observeSseCommit(
	stream: ReadableStream<Uint8Array>,
	gate: StreamCommitGate,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let pending = "";
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				pending += decoder.decode(chunk, { stream: true });
				let next = nextSseFrame(pending);
				while (next) {
					gate.classifyAndObserve(eventTypeFromFrame(next.frame), next.frame.length);
					pending = next.rest;
					next = nextSseFrame(pending);
				}
				controller.enqueue(chunk);
			},
			flush() {
				if (pending.length === 0) return;
				gate.classifyAndObserve(eventTypeFromFrame(pending) || "heartbeat", pending.length);
			},
		}),
	);
}
