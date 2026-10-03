/**
 * Tern Surface Protocol framing: `ESC _ tsp ; <verb> [; k=v]* ; <body> ESC \`.
 *
 * Bodies are UTF-8 JSON (JSON escapes every control character, so a body can
 * never contain ESC or BEL) or base64 for blob chunks. A body larger than the
 * negotiated `apc` limit is split across messages with the same verb, tagged
 * `c=<chunk-id>`, with `m=1` on every chunk but the last; the receiver joins
 * the bodies byte-wise. Chunks split on code-point boundaries, so every chunk
 * is valid UTF-8 on its own and the joined bytes equal the original body.
 */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import {
	TSP_APC_ID,
	TSP_DEFAULT_APC_LIMIT,
	TSP_VERSION,
	type TspEvent,
	type TspReply,
	type TspVerb,
} from "@oh-my-pi/pi-wire";

const APC = "\x1b_";
const ST = "\x1b\\";
/** Every TSP message starts with this. */
export const TSP_PREFIX = `${APC}${TSP_APC_ID};`;

/** The terminal's hello reply. */
export type TspHello = Extract<TspReply, { r: "hello" }>;

/** A decoded terminal → program message. */
export type TspIncoming = { verb: "r"; reply: TspReply } | { verb: "e"; event: TspEvent };

/** Message parameters (`k=v`, ASCII, never containing `;`). */
export type TspParams = Readonly<Record<string, string | number>>;

let nextChunkId = 1;

/** UTF-8 byte length of one UTF-16 code unit sequence starting at `i`, and its unit count. */
function codePointBytes(text: string, i: number): { bytes: number; units: number } {
	const c = text.charCodeAt(i);
	if (c < 0x80) return { bytes: 1, units: 1 };
	if (c < 0x800) return { bytes: 2, units: 1 };
	if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
		const next = text.charCodeAt(i + 1);
		if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, units: 2 };
	}
	return { bytes: 3, units: 1 };
}

/** Split `body` into pieces of at most `limit` UTF-8 bytes, never inside a code point. */
export function splitUtf8(body: string, limit: number): string[] {
	const max = Math.max(4, Math.trunc(limit));
	const pieces: string[] = [];
	let start = 0;
	let bytes = 0;
	let i = 0;
	while (i < body.length) {
		const step = codePointBytes(body, i);
		if (bytes + step.bytes > max) {
			pieces.push(body.slice(start, i));
			start = i;
			bytes = 0;
		}
		bytes += step.bytes;
		i += step.units;
	}
	pieces.push(body.slice(start));
	return pieces;
}

function frame(verb: TspVerb, params: string, body: string): string {
	return `${TSP_PREFIX}${verb}${params};${body}${ST}`;
}

function encodeParams(params: TspParams | undefined): string {
	if (!params) return "";
	let out = "";
	for (const key in params) out += `;${key}=${params[key]}`;
	return out;
}

/**
 * Encode one logical message, chunked when `body` exceeds `limit` UTF-8 bytes.
 * Returns the complete byte string to write (all chunks, in order).
 */
export function encodeTspMessage(
	verb: TspVerb,
	body: string,
	params?: TspParams,
	limit: number = TSP_DEFAULT_APC_LIMIT,
): string {
	const base = encodeParams(params);
	// Fast path: ASCII-length bound first, exact byte count only near the limit.
	if (body.length * 3 <= limit || Buffer.byteLength(body, "utf8") <= limit) return frame(verb, base, body);
	const chunkId = (nextChunkId++).toString(36);
	const pieces = splitUtf8(body, limit);
	let out = "";
	for (let i = 0; i < pieces.length; i++) {
		const more = i < pieces.length - 1 ? ";m=1" : "";
		out += frame(verb, `${base};c=${chunkId}${more}`, pieces[i]!);
	}
	return out;
}

/** Encode a JSON message body. */
export function encodeTspJson(verb: TspVerb, value: unknown, params?: TspParams, limit?: number): string {
	return encodeTspMessage(verb, JSON.stringify(value), params, limit);
}

/**
 * The `hello` query; callers follow it with a DA1 sentinel. `features: ["edit"]`
 * tells the terminal that omp applies its `edit` events (TSP §8.5), so it may keep a
 * native selection in omp's editors; without it, every key stays omp's. `"undo"`
 * says omp applies `undo` events, so the terminal may turn ⌃Z in a field into one.
 */
export function encodeTspHelloQuery(version?: string): string {
	return encodeTspJson("q", { q: "hello", v: [TSP_VERSION], app: "omp", features: ["edit", "undo"], ver: version });
}

/** One decoded APC message: verb, parameters and raw body. */
export interface TspRawMessage {
	verb: string;
	params: Record<string, string>;
	body: string;
}

const PARAM_PATTERN = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$/;

/** Split a complete `ESC _ tsp;… ESC \` string into verb, parameters and body; null when it isn't one. */
export function splitTspMessage(sequence: string): TspRawMessage | null {
	if (!sequence.startsWith(TSP_PREFIX) || !sequence.endsWith(ST)) return null;
	const inner = sequence.slice(TSP_PREFIX.length, -ST.length);
	let semi = inner.indexOf(";");
	if (semi <= 0) return semi === -1 && inner.length > 0 ? { verb: inner, params: {}, body: "" } : null;
	const verb = inner.slice(0, semi);
	const params: Record<string, string> = {};
	let pos = semi + 1;
	// A segment is a parameter only when another `;` follows it; the body is the rest.
	for (;;) {
		semi = inner.indexOf(";", pos);
		if (semi === -1) break;
		const segment = inner.slice(pos, semi);
		if (!PARAM_PATTERN.test(segment)) break;
		const eq = segment.indexOf("=");
		params[segment.slice(0, eq)] = segment.slice(eq + 1);
		pos = semi + 1;
	}
	return { verb, params, body: inner.slice(pos) };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function decodeReply(value: Record<string, unknown>): TspReply | null {
	if (value.r === "hello") {
		if (typeof value.v !== "number" || typeof value.term !== "string" || !isStringArray(value.kinds)) return null;
		return value as TspHello;
	}
	if (value.r === "blobs") return isStringArray(value.have) ? (value as TspReply) : null;
	return null;
}

const EVENT_REQUIRED: Readonly<Record<string, Readonly<Record<string, "string" | "number" | "boolean" | "array">>>> = {
	ack: { s: "number" },
	resize: { cols: "number" },
	theme: { dark: "boolean" },
	motion: { reduce: "boolean" },
	visible: { visible: "boolean" },
	toggle: { id: "string", collapsed: "boolean" },
	select: { id: "string", item: "string" },
	activate: { id: "string", item: "string" },
	action: { id: "string", act: "string" },
	// `value` varies by control (boolean, number, string, string[], null): the handler checks it.
	change: { id: "string", item: "string" },
	edit: { id: "string", from: "number", to: "number", text: "string", cursor: "number", len: "number" },
	undo: { id: "string" },
	focus: { id: "string" },
	error: { msg: "string" },
	gone: { ids: "array" },
};

function decodeEvent(value: Record<string, unknown>): TspEvent | null {
	if (typeof value.ev !== "string") return null;
	const required = EVENT_REQUIRED[value.ev];
	if (!required) return null;
	for (const key in required) {
		const want = required[key];
		const got = value[key];
		if (want === "array" ? !isStringArray(got) : typeof got !== want) return null;
	}
	return value as TspEvent;
}

/**
 * Reassembles chunked terminal → program messages and decodes replies and
 * events. Unknown verbs, unknown events and unknown fields are tolerated
 * (ignored or passed through); malformed input yields null.
 */
export class TspReader {
	#chunks = new Map<string, string>();

	/** Feed one complete APC string. Returns the decoded message once complete, else null. */
	feed(sequence: string): TspIncoming | null {
		const raw = splitTspMessage(sequence);
		if (!raw) return null;
		let body = raw.body;
		const chunkId = raw.params.c;
		if (chunkId !== undefined) {
			const joined = (this.#chunks.get(chunkId) ?? "") + body;
			if (raw.params.m === "1") {
				this.#chunks.set(chunkId, joined);
				return null;
			}
			this.#chunks.delete(chunkId);
			body = joined;
		}
		return decodeTspBody(raw.verb, body);
	}
}

/** Decode an unchunked reply/event body. Null for malformed JSON, missing fields or program → terminal verbs. */
export function decodeTspBody(verb: string, body: string): TspIncoming | null {
	if (verb !== "r" && verb !== "e") return null;
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	if (verb === "r") {
		const reply = decodeReply(value);
		return reply ? { verb, reply } : null;
	}
	const event = decodeEvent(value);
	return event ? { verb, event } : null;
}

/** Decode one complete, unchunked terminal → program message. */
export function parseTspMessage(sequence: string): TspIncoming | null {
	const raw = splitTspMessage(sequence);
	return raw && raw.params.m !== "1" ? decodeTspBody(raw.verb, raw.body) : null;
}
