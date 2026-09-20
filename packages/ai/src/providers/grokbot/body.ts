/** Bounded, credential-safe response-body helpers for Grok Bot transports. */

export const MAX_GROKBOT_RESPONSE_BODY_BYTES = 64 * 1024;

export interface BoundedResponseText {
	text: string;
	truncated: boolean;
}

/**
 * Read a small diagnostic/JSON body without allowing a remote peer to retain
 * an unbounded response. Overflow is cancelled rather than drained.
 */
export async function readBoundedGrokbotResponseText(
	response: Response,
	maxBytes = MAX_GROKBOT_RESPONSE_BODY_BYTES,
	signal?: AbortSignal,
): Promise<BoundedResponseText> {
	const reader = response.body?.locked ? undefined : response.body?.getReader();
	if (!reader) return { text: "", truncated: false };

	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let captured = 0;
	let completed = false;
	let truncated = false;
	const { promise: aborted, reject: rejectAborted } = Promise.withResolvers<never>();
	const onAbort = () => {
		void reader.cancel().catch(() => {});
		rejectAborted(signal?.reason);
	};
	if (signal?.aborted) {
		onAbort();
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}
	try {
		for (;;) {
			const result = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
			if (signal?.aborted) {
				throw signal.reason ?? new DOMException("Grok Bot response read aborted", "AbortError");
			}
			const { done, value } = result;
			if (done) {
				completed = true;
				chunks.push(decoder.decode());
				break;
			}
			if (!value) continue;
			const remaining = maxBytes - captured;
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			const count = Math.min(value.byteLength, remaining);
			chunks.push(decoder.decode(value.subarray(0, count), { stream: true }));
			captured += count;
			if (count < value.byteLength || captured >= maxBytes) {
				truncated = true;
				break;
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (!completed) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	return { text: chunks.join(""), truncated };
}

/** Redact exact credentials supplied to a remote Grok Bot endpoint. */
export function redactGrokbotSecrets(text: string, secrets: readonly (string | undefined)[]): string {
	let redacted = text;
	for (const secret of secrets) {
		if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
	}
	return redacted;
}
