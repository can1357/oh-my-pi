import { promisify } from "node:util";
import * as zlib from "node:zlib";
import {
	type RequestBodyEncoding,
	type RequestCompressionPolicy,
	resolveRequestCompression,
} from "@oh-my-pi/pi-catalog/compat/request-compression";
import { $flag, logger } from "@oh-my-pi/pi-utils";
import type { FetchImpl, Model } from "../types";

const gzip = promisify(zlib.gzip);

/** Bodies below one TCP segment gain nothing from compression; skip them. */
export const MIN_COMPRESSED_BODY_BYTES = 1024;

/**
 * zlib's default level: on multi-MB transcripts ~35% smaller than level 1 for
 * ~2x the CPU — a few ms per MB.
 */
const GZIP_LEVEL = 6;

/**
 * Measured on real 1–2 MB transcripts: smaller than gzip-6 at about a quarter
 * of its CPU; higher levels triple the cost for ~1pp.
 */
const ZSTD_LEVEL = 3;

/**
 * `<origin> <encoding>` pairs a host has rejected. Latched per host and
 * encoding so one host's rejection never disables compression elsewhere, and
 * the next request falls back to that host's next accepted encoding.
 */
const rejectedEncodings = new Set<string>();

/**
 * `<origin> <status>` pairs where a non-JSON refusal of a compressed body
 * recurred on the uncompressed resend: something in front of the host refuses
 * every request (a blocking proxy, an edge challenge), not the encoding. Later
 * refusals with that status skip the resend instead of doubling each attempt.
 */
const encodingUnrelatedRefusals = new Set<string>();

/** Why a failed compressed request may be an encoding rejection. */
type RejectionSuspect = "host" | "proxy";

type RequestHeaders = RequestInit["headers"];

function requestUrl(input: string | URL | Request): string | undefined {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return undefined;
}

function hasContentEncoding(headers: RequestHeaders): boolean {
	if (!headers) return false;
	if (headers instanceof Headers) return headers.has("content-encoding");
	if (Array.isArray(headers)) return headers.some(([name]) => name.toLowerCase() === "content-encoding");
	for (const name in headers) {
		if (name.toLowerCase() === "content-encoding") return true;
	}
	return false;
}

/** Adds `Content-Encoding`, preserving the caller's header container and casing. */
function withContentEncoding(headers: RequestHeaders, encoding: RequestBodyEncoding): RequestHeaders {
	if (headers instanceof Headers) {
		const copy = new Headers(headers);
		copy.set("Content-Encoding", encoding);
		return copy;
	}
	if (Array.isArray(headers)) return [...headers, ["Content-Encoding", encoding]];
	return { ...headers, "Content-Encoding": encoding };
}

/** Off the event loop: a synchronous codec stalls the TUI ~120ms on a 9MB body. */
function compress(body: string | ArrayBufferView, encoding: RequestBodyEncoding): Promise<Uint8Array> {
	const bytes = typeof body === "string" ? body : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return encoding === "zstd" ? Bun.zstdCompress(bytes, { level: ZSTD_LEVEL }) : gzip(bytes, { level: GZIP_LEVEL });
}

/** Reads a clone of {@link response}'s body; `undefined` when it cannot be read. */
async function bodyText(response: Response): Promise<string | undefined> {
	try {
		return await response.clone().text();
	} catch {
		return undefined;
	}
}

function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * `host`: a JSON 400/415 matching the host's rejection pattern (or any JSON
 * 400/415 when none is assigned). `proxy`: a 400/403/415 whose body is not JSON,
 * empty included — provider APIs answer errors in JSON, so the body is presumed
 * to come from a proxy or TLS-inspecting gateway that may refuse a compressed
 * upload the host itself decodes.
 */
async function suspectEncodingRejection(
	response: Response,
	policy: RequestCompressionPolicy,
): Promise<RejectionSuspect | undefined> {
	if (response.status !== 400 && response.status !== 403 && response.status !== 415) return undefined;
	const body = await bodyText(response);
	if (body === undefined) return undefined;
	if (!isJson(body)) return "proxy";
	if (response.status === 403) return undefined;
	return (policy.rejection?.test(body) ?? true) ? "host" : undefined;
}

/**
 * Compresses request bodies from {@link model} to its provider's own endpoint
 * when its catalog rules declare encodings the endpoint decodes
 * (`request-encodings` / `endpoint-hosts` KDL axes). Long sessions resend
 * multi-MB transcripts every turn, so upload time dominates time-to-first-token
 * on ordinary uplinks.
 *
 * Install it beneath any body rewriter or signer (e.g. the cch attestation
 * patch): those must see the uncompressed bytes. Other hosts, small bodies,
 * bodies that already carry `Content-Encoding`, and `PI_REQUEST_COMPRESSION=0`
 * pass through untouched. A possible rejection — the host's decode error, or a
 * non-JSON 400/403/415 from a proxy in front of it — is resent uncompressed
 * once; only when that resend succeeds is the encoding latched off for the
 * host, so a genuine 400 never disables compression. When a non-JSON refusal
 * recurs uncompressed with the same status and a non-JSON body, that status
 * stops being re-checked for the host.
 */
export function wrapFetchForRequestCompression(base: FetchImpl, model: Model): FetchImpl {
	const wrapped: FetchImpl = async (input, init) => {
		const body = init?.body;
		const url = requestUrl(input);
		if (
			url === undefined ||
			!(typeof body === "string" || ArrayBuffer.isView(body)) ||
			// UTF-16 length undercounts UTF-8 bytes — fine for a size floor.
			(typeof body === "string" ? body.length : body.byteLength) < MIN_COMPRESSED_BODY_BYTES ||
			hasContentEncoding(init?.headers) ||
			!$flag("PI_REQUEST_COMPRESSION", true)
		) {
			return base(input, init);
		}
		const policy = resolveRequestCompression(model, url);
		if (!policy) return base(input, init);
		const origin = new URL(url).origin;
		const encoding = policy.encodings.find(candidate => !rejectedEncodings.has(`${origin} ${candidate}`));
		if (!encoding) return base(input, init);

		let compressed: Uint8Array;
		try {
			compressed = await compress(body, encoding);
		} catch (error) {
			logger.debug("Request body compression failed; sending uncompressed", {
				origin,
				encoding,
				error: error instanceof Error ? error.message : String(error),
			});
			return base(input, init);
		}

		const response = await base(input, {
			...init,
			body: compressed,
			headers: withContentEncoding(init?.headers, encoding),
		});
		const suspect = await suspectEncodingRejection(response, policy);
		if (!suspect) return response;
		const refusal = `${origin} ${response.status}`;
		if (suspect === "proxy" && encodingUnrelatedRefusals.has(refusal)) return response;

		await response.body?.cancel().catch(() => {});
		const plain = await base(input, init);
		if (plain.ok) {
			rejectedEncodings.add(`${origin} ${encoding}`);
			logger.warn("Endpoint rejected compressed request body; disabling this encoding for the host", {
				origin,
				encoding,
				status: response.status,
			});
		} else if (suspect === "proxy" && plain.status === response.status) {
			// A JSON body means the resend reached the provider; its own error says
			// nothing about whether the proxy refuses every request.
			const plainBody = await bodyText(plain);
			if (plainBody !== undefined && !isJson(plainBody)) encodingUnrelatedRefusals.add(refusal);
		}
		return plain;
	};
	if (base.preconnect) wrapped.preconnect = base.preconnect;
	return wrapped;
}

/** Test hook: clears every per-host latch. */
export function resetRequestCompressionForTesting(): void {
	rejectedEncodings.clear();
	encodingUnrelatedRefusals.clear();
}
