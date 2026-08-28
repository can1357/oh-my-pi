/** Classification of one Responses SSE event for commit / failover. */
export type CommitClass = "metadata" | "output" | "terminal-success" | "terminal-retryable" | "terminal-failure";

export type StreamCommitState = "probing" | "committed" | "terminated";

const DEFAULT_MAX_PRELUDE_BYTES = 4 * 1024 * 1024;

/** Downstream SSE observer is used for Responses; upstream onSseEvent must not also feed the gate. */
export function commitGateObservesDownstreamSse(formatLabel: string): boolean {
	return formatLabel === "openai-responses";
}

const METADATA_EVENTS: Record<string, true> = {
	"response.created": true,
	"response.in_progress": true,
	"response.queued": true,
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

	constructor(maxPreludeBytes: number = DEFAULT_MAX_PRELUDE_BYTES) {
		this.#maxPreludeBytes = maxPreludeBytes;
	}

	get state(): StreamCommitState {
		return this.#state;
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
