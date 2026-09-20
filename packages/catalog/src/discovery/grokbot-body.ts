/** Bounded response-body helpers local to Grok Bot catalog discovery. */

/** Successful catalogs include every model variant; cap them without rejecting normal rosters. */
export const MAX_GROKBOT_CATALOG_JSON_BODY_BYTES = 512 * 1024;
export const MAX_GROKBOT_CREDENTIAL_JSON_BODY_BYTES = 64 * 1024;

/**
 * Read and parse a successful JSON response within a fixed allocation budget.
 * A response that overflows, errors, remains unread, or stalls until caller
 * cancellation is cancelled so discovery cannot retain or drain an unbounded body.
 */
export async function readBoundedGrokbotCatalogJson(
	response: Response,
	signal?: AbortSignal,
	maxBytes = MAX_GROKBOT_CATALOG_JSON_BODY_BYTES,
): Promise<unknown> {
	const reader = response.body?.locked ? undefined : response.body?.getReader();
	if (!reader) throw new Error("Grok Bot response has no readable JSON body");

	const bytes = new Uint8Array(maxBytes);
	let length = 0;
	let completed = false;
	let aborted: Promise<never> | undefined;
	let onAbort: (() => void) | undefined;
	if (signal) {
		const abort = Promise.withResolvers<never>();
		aborted = abort.promise;
		onAbort = () => {
			void reader.cancel().catch(() => {});
			abort.reject(signal.reason);
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}
	try {
		for (;;) {
			const result = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
			if (signal?.aborted) {
				throw signal.reason ?? new DOMException("Grok Bot response read aborted", "AbortError");
			}
			const { done, value } = result;
			if (done) {
				completed = true;
				break;
			}
			if (!value) continue;
			if (value.byteLength > bytes.byteLength - length) {
				throw new Error("Grok Bot JSON response exceeded the body limit");
			}
			bytes.set(value, length);
			length += value.byteLength;
		}
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		if (!completed) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
}

/** Release a response body that discovery deliberately does not inspect. */
export async function cancelGrokbotCatalogResponse(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => {});
}
