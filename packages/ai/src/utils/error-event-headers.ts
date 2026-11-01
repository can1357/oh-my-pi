import { getHeadersFromError } from "./retry-after";

/** The in-band headers a client takes from an error object: explicit retry waits only. */
const IN_BAND_WAIT_HEADERS = ["retry-after-ms", "retry-after"] as const;

/**
 * `error`, thrown for an in-band error object a stream carried, with that
 * object's structured `headers` member attached as `error.headers`, so
 * {@link getHeadersFromError} — and so `AIError.finalize`'s
 * `errorRetryAfterMs` — reads the failed attempt's retry wait from it.
 *
 * A relay that committed its `200` before its upstream failed cannot send real
 * headers any more; the omp auth gateway states the upstream's wait in the
 * error object instead (`{ "retry-after-ms": "9000" }`), the shape Codex error
 * events carry. Only that structured member is read, never the message text,
 * and from it only the explicit waits `retry-after-ms` and `Retry-After`:
 * a body's other "headers" (a window reset, a provider's slow-mode or usage
 * headers) reach no reader through here. A string, or a number written as a
 * string, is kept; anything else is dropped. The member gives the error no
 * HTTP status. An error that already carries headers keeps its own.
 */
export function withErrorEventHeaders<E extends Error>(error: E, errorObject: unknown): E {
	if (getHeadersFromError(error) !== undefined) return error;
	if (!errorObject || typeof errorObject !== "object") return error;
	const declared = Reflect.get(errorObject, "headers");
	if (!declared || typeof declared !== "object" || Array.isArray(declared)) return error;
	const headers = new Headers();
	for (const [name, value] of Object.entries(declared)) {
		const lower = name.toLowerCase();
		if (!(IN_BAND_WAIT_HEADERS as readonly string[]).includes(lower)) continue;
		const text =
			typeof value === "string"
				? value
				: typeof value === "number" && Number.isFinite(value)
					? String(value)
					: undefined;
		if (text === undefined) continue;
		try {
			headers.set(lower, text);
		} catch {
			// Not a valid header value; skip it.
		}
	}
	if (headers.keys().next().done) return error;
	return Object.assign(error, { headers });
}
