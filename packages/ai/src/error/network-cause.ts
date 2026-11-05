/**
 * Local transport diagnosis for a rejected `fetch`.
 *
 * Bun and Node describe the same outage with different shapes — Bun throws a
 * `TypeError` carrying `code: "ETIMEOUT" | "FailedToOpenSocket" |
 * "ConnectionRefused"`, undici nests an `ENOTFOUND`/`ECONNREFUSED` errno under
 * `TypeError: fetch failed` (sometimes through an `AggregateError`), and
 * `fetchWithRetry` may already have flattened the chain into a message-only
 * `Error`. Both the code and the text are inspected so every one of those
 * shapes lands in the right bucket.
 */

/** Transport-level failure families that get their own user-visible wording. */
export type NetworkFailureKind = "offline" | "unreachable" | "refused" | "tls" | "reset";

/** Which half of the TLS chain failed, when the evidence names one. */
export type TlsFailurePhase = "handshake" | "certificate";

/** What {@link classifyNetworkCause} reports about a rejected `fetch`: the failure family plus the bits its sentence needs. */
export interface NetworkFailure {
	kind: NetworkFailureKind;
	/** `tls` only: handshake failure versus certificate verification. */
	tlsPhase?: TlsFailurePhase;
	/** Runtime error code when the chain exposed one (`ETIMEOUT`, `FailedToOpenSocket`, …). */
	code: string | undefined;
	/** Short parenthetical detail for the user-visible message. */
	detail: string | undefined;
	/** Host named by the error text, when it named one. */
	host: string | undefined;
}

const MAX_CAUSE_DEPTH = 8;
const MAX_AGGREGATE_BRANCH = 4;
const MAX_LINKS = 16;
const MAX_DETAIL_LENGTH = 120;
const UNKNOWN_HOST = "the API host";

const OFFLINE_CODE_PATTERN = /^(?:ETIMEOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/i;
const OFFLINE_TEXT_PATTERN = /\b(?:ETIMEOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/i;
const UNREACHABLE_CODE_PATTERN = /^(?:ENOTFOUND|FailedToOpenSocket)$/i;
const UNREACHABLE_TEXT_PATTERN = /\b(?:ENOTFOUND|FailedToOpenSocket|getaddrinfo)\b/i;
const REFUSED_CODE_PATTERN = /^(?:ECONNREFUSED|ConnectionRefused)$/i;
const REFUSED_TEXT_PATTERN = /\bECONNREFUSED\b|\bConnectionRefused\b|\bUnable to connect\b/i;
const RESET_CODE_PATTERN = /^(?:ECONNRESET|ECONNABORTED|EPIPE|ERR_STREAM_PREMATURE_CLOSE)$/i;
const RESET_TEXT_PATTERN =
	/\bECONNRESET\b|\bECONNABORTED\b|\bEPIPE\b|ERR_STREAM_PREMATURE_CLOSE|\bconnection reset by peer\b|\bwas reset by the network or proxy\b|\bsocket connection (?:was )?closed unexpectedly\b|\bsocket hang up\b|\bother side closed\b|\buse of closed network connection\b|\b(?:read|write) ECONNRESET\b|\bconnection lost mid-reply\b/i;
const TLS_CODE_PATTERN =
	/^(?:CERT_|SELF_SIGNED|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT)/i;
const TLS_TEXT_PATTERN =
	/unable to verify|certificate verif(?:y|ication)|self[- ]signed certificate|\bCERT_[A-Z_]+\b|\bSELF_SIGNED[A-Z_]*\b|\bUNABLE_TO_GET_ISSUER_CERT[A-Z_]*\b|\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b/i;
// A TLS handshake failure is a different sentence from certificate
// verification: the proxy/VPN answered, but not with a usable TLS endpoint
// (Bun's `EPROTO: The TLS handshake failed. Does the server speak TLS on this
// port?` is the shape seen when a SOCKS-only proxy port is configured as HTTP).
// It is only classified as TLS when the text carries that evidence — a bare
// `EPROTO` stays an unclassified transient transport failure instead of
// claiming a certificate conclusion.
const TLS_HANDSHAKE_TEXT_PATTERN =
	/tls handshake failed|ssl handshake|does the server speak tls on this port|\btls connection failed\b|wrong version number|\bssl routines\b|\bssl3_get\b|ssl3_read_bytes|\btlsv1(?:[._]|\b)|\btls record\b|bad record mac/i;
const GETADDRINFO_HOST_PATTERN = /\bgetaddrinfo\s+[A-Z_]+\s+([^\s,)]+)/i;
const CONNECT_HOST_PATTERN = /\b(?:connect|connection to)\s+[A-Z_]+\s+([^\s,)]+?)(?::\d+)?(?=[\s,)]|$)/i;
const BARE_HOST_PATTERN = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i;
const GETADDRINFO_DETAIL_PATTERN = /\bgetaddrinfo\s+[A-Z_]+/i;
const ERRNO_DETAIL_PATTERN = /\b(?:ETIMEOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|FailedToOpenSocket)\b/i;
const HOST_PATTERNS = [GETADDRINFO_HOST_PATTERN, CONNECT_HOST_PATTERN, BARE_HOST_PATTERN];

interface Link {
	value: unknown;
	depth: number;
}

function kindOf(code: string | undefined, message: string | undefined): NetworkFailureKind | undefined {
	// TLS first: a certificate failure usually also reads as a failed connect.
	if (code !== undefined && TLS_CODE_PATTERN.test(code)) return "tls";
	if (message !== undefined && TLS_TEXT_PATTERN.test(message)) return "tls";
	if (message !== undefined && TLS_HANDSHAKE_TEXT_PATTERN.test(message)) return "tls";
	if (code !== undefined && REFUSED_CODE_PATTERN.test(code)) return "refused";
	if (message !== undefined && REFUSED_TEXT_PATTERN.test(message)) return "refused";
	// Reset before offline/unreachable: a proxy can also surface a reset as
	// "unable to connect" once its tunnel is already dead.
	if (code !== undefined && RESET_CODE_PATTERN.test(code)) return "reset";
	if (message !== undefined && RESET_TEXT_PATTERN.test(message)) return "reset";
	// Offline before unreachable: `getaddrinfo ETIMEOUT` matches both text patterns.
	if (code !== undefined && OFFLINE_CODE_PATTERN.test(code)) return "offline";
	if (message !== undefined && OFFLINE_TEXT_PATTERN.test(message)) return "offline";
	if (code !== undefined && UNREACHABLE_CODE_PATTERN.test(code)) return "unreachable";
	if (message !== undefined && UNREACHABLE_TEXT_PATTERN.test(message)) return "unreachable";
	return undefined;
}

/**
 * Which TLS failure the evidence names. `EPROTO` alone says the TLS layer
 * rejected the peer, not whether a certificate was evaluated, so it only
 * refines the phrasing when handshake text is present; otherwise `undefined`
 * falls back to the certificate wording the existing code used.
 */
function tlsPhaseOf(code: string | undefined, message: string | undefined): TlsFailurePhase | undefined {
	if (message !== undefined && TLS_HANDSHAKE_TEXT_PATTERN.test(message)) return "handshake";
	if (message !== undefined && TLS_TEXT_PATTERN.test(message)) return "certificate";
	if (code !== undefined && TLS_CODE_PATTERN.test(code)) return "certificate";
	return undefined;
}

/** First host named by any message seen so far, most specific pattern first. */
function hostFromTexts(texts: readonly string[]): string | undefined {
	for (const pattern of HOST_PATTERNS) {
		for (const text of texts) {
			const host = pattern.exec(text)?.[1];
			if (host) return host;
		}
	}
	return undefined;
}

function detailOf(
	kind: NetworkFailureKind,
	code: string | undefined,
	message: string | undefined,
	tlsPhase: TlsFailurePhase | undefined,
): string | undefined {
	// The refused and reset templates already carry their own wording.
	if (kind === "refused" || kind === "reset") return undefined;
	// The handshake sentence is fixed by the failure itself; a parenthetical
	// certificate/errno detail would read as a verification failure.
	if (kind === "tls" && tlsPhase === "handshake") return undefined;
	if (kind === "tls" && code !== undefined) return code;
	const pattern = kind === "tls" ? TLS_TEXT_PATTERN : GETADDRINFO_DETAIL_PATTERN;
	const matched = message === undefined ? undefined : pattern.exec(message)?.[0];
	if (matched !== undefined) return matched.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_LENGTH);
	if (kind === "tls") return undefined;
	// A DNS/route failure without a `getaddrinfo …` fragment still names its errno; keeping it in
	// the sentence is what keeps the rendered message matching TRANSIENT_TRANSPORT_PATTERN.
	return code ?? (message === undefined ? undefined : ERRNO_DETAIL_PATTERN.exec(message)?.[0]);
}

/**
 * Walk an error's `cause`/`errors` graph (bounded depth, cycle-safe) and report
 * the outermost link that describes a local transport failure. Returns
 * `undefined` for anything else, including HTTP-level provider errors.
 */
export function classifyNetworkCause(err: unknown): NetworkFailure | undefined {
	const seen = new Set<object>();
	const queue: Link[] = [{ value: err, depth: 0 }];
	const texts: string[] = [];
	let links = 0;

	while (links < MAX_LINKS) {
		const link = queue.shift();
		if (link === undefined) break;
		links++;
		const { value, depth } = link;

		let code: string | undefined;
		let message: string | undefined;
		const isObject = typeof value === "object" && value !== null;
		if (typeof value === "string") {
			message = value;
		} else if (isObject) {
			if (seen.has(value)) continue;
			seen.add(value);
			if ("code" in value && typeof value.code === "string") code = value.code;
			if ("message" in value && typeof value.message === "string") message = value.message;
		} else {
			continue;
		}
		if (message !== undefined) texts.push(message);

		const kind = kindOf(code, message);
		if (kind !== undefined) {
			const tlsPhase = kind === "tls" ? tlsPhaseOf(code, message) : undefined;
			return {
				kind,
				...(tlsPhase === undefined ? {} : { tlsPhase }),
				code,
				detail: detailOf(kind, code, message, tlsPhase),
				host: hostFromTexts(texts),
			};
		}

		if (!isObject || depth >= MAX_CAUSE_DEPTH) continue;
		if ("cause" in value) queue.push({ value: value.cause, depth: depth + 1 });
		if ("errors" in value && Array.isArray(value.errors)) {
			for (const nested of value.errors.slice(0, MAX_AGGREGATE_BRANCH)) {
				queue.push({ value: nested, depth: depth + 1 });
			}
		}
	}
	return undefined;
}

/**
 * User-visible sentence for a network failure, or `undefined` when the error is
 * not one. `requestUrl` wins over any host parsed out of the error text.
 */
export function networkFailureMessage(err: unknown, requestUrl?: string): string | undefined {
	const failure = classifyNetworkCause(err);
	if (failure === undefined) return undefined;
	let urlHost: string | undefined;
	if (typeof requestUrl === "string" && requestUrl.length > 0) {
		try {
			const { host } = new URL(requestUrl);
			if (host.length > 0) urlHost = host;
		} catch {
			urlHost = undefined;
		}
	}
	const host = urlHost ?? failure.host ?? UNKNOWN_HOST;
	const detail = failure.detail === undefined ? "" : ` (${failure.detail})`;
	switch (failure.kind) {
		case "offline":
			return `No internet connection: couldn't reach ${host}${detail}. Check your network or proxy and try again.`;
		case "unreachable":
			return `Couldn't reach ${host}${detail}. Check the URL, your network, or proxy.`;
		case "refused":
			return `Couldn't connect to ${host} (connection refused). Check that the server is running and reachable.`;
		case "tls":
			return failure.tlsPhase === "handshake"
				? `TLS connection failed for ${host} during handshake. Check the proxy/VPN and whether the configured proxy speaks HTTP(S) rather than SOCKS.`
				: `TLS certificate verification failed for ${host}${detail}. If you're behind a TLS-inspecting proxy, its CA may need to be trusted.`;
		case "reset":
			return `Connection to ${host} was reset by the network or proxy while the response was streaming. Check the proxy/VPN and retry.`;
	}
}

/**
 * Re-describe a rejected `fetch` with {@link networkFailureMessage}, keeping the
 * original error as `cause`. Anything that is not a local transport failure is
 * returned untouched, so provider/HTTP errors keep their identity.
 */
export function networkFailureError(err: unknown, requestUrl?: string): unknown {
	const message = networkFailureMessage(err, requestUrl);
	return message === undefined ? err : new Error(message, { cause: err });
}
