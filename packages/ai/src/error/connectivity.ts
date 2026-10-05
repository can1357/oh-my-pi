import { isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils";
import { status } from "./flags";

const CONNECTION_CODE_PATTERN =
	/\b(?:ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b/i;
const CONNECTION_MESSAGE_PATTERN =
	/\b(?:fetch failed|failed to fetch|network error|network is (?:unreachable|down)|connection error|connection (?:refused|reset|closed|lost)|socket hang up|getaddrinfo|unable to connect|could not connect|cannot connect)\b|stream closed with error code\s+nghttp2_(?:internal_error|refused_stream)/i;
const CONFIGURATION_CODE_PATTERN =
	/\b(?:CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|ERR_TLS_CERT_ALTNAME_INVALID|ERR_INVALID_URL|ERR_INVALID_PROTOCOL|UND_ERR_INVALID_ARG)\b/i;
const CONFIGURATION_MESSAGE_PATTERN =
	/connection configuration error|certificate (?:has expired|verify failed|verification failed)|self[- ]signed certificate|unable to verify (?:the )?(?:first|leaf) certificate|hostname.*does not match.*certificate|(?:invalid|malformed) url|url is invalid|failed to parse url|unsupported (?:url )?protocol/i;

/**
 * A failed provider connection, not an HTTP rejection or a general timeout.
 * This cannot prove the whole internet is offline (a bad endpoint looks the
 * same), so callers should offer a cancellable wait for the provider connection.
 */
export function isConnectivityError(error: unknown): boolean {
	return classifyConnectionError(error) === "network";
}

/** Preserve terminal URL/certificate evidence through SDK error flattening. */
export function isConnectionConfigurationError(error: unknown): boolean {
	return classifyConnectionError(error) === "configuration";
}

function classifyConnectionError(error: unknown): "network" | "configuration" | undefined {
	const seen = new Set<object>();
	let link: unknown = error;
	let connectionFailure = false;
	for (let depth = 0; depth < 8 && link !== undefined && link !== null; depth++) {
		// An HTTP rejection anywhere in the cause chain owns the failure, even
		// when its body mentions a connection error. Keep existing HTTP policy.
		const httpStatus = status(typeof link === "string" ? { message: link } : link);
		if (httpStatus !== undefined && httpStatus >= 300) return undefined;
		if (typeof link === "string") {
			if (CONFIGURATION_MESSAGE_PATTERN.test(link)) return "configuration";
			connectionFailure ||= matchesConnectionMessage(link);
			break;
		}
		if (typeof link !== "object" || seen.has(link)) break;
		seen.add(link);
		const record = link as Record<string, unknown>;
		if (record.name === "AbortError") return undefined;
		if (
			(typeof record.code === "string" && CONFIGURATION_CODE_PATTERN.test(record.code)) ||
			(typeof record.message === "string" && CONFIGURATION_MESSAGE_PATTERN.test(record.message))
		)
			return "configuration";
		if (typeof record.code === "string" && CONNECTION_CODE_PATTERN.test(record.code)) connectionFailure = true;
		if (typeof record.message === "string" && matchesConnectionMessage(record.message)) connectionFailure = true;
		link = record.cause;
	}
	return connectionFailure ? "network" : undefined;
}

function matchesConnectionMessage(message: string): boolean {
	return (
		CONNECTION_CODE_PATTERN.test(message) ||
		CONNECTION_MESSAGE_PATTERN.test(message) ||
		isUnexpectedSocketCloseMessage(message)
	);
}
