/**
 * TSP message framing: APC strings in both directions.
 *
 *     ESC _ tsp ; <verb> [; <key>=<value>]* ; <body> ESC \
 *
 * A body longer than the negotiated APC limit (in UTF-8 bytes) is split into
 * chunks that share a `c=<id>` parameter; every chunk but the last carries
 * `m=1`, and the message's own parameters ride on the first chunk only. A
 * chunk never splits a code point and never starts with a segment a reader
 * would take for a parameter (`x=1;…`).
 *
 * Decoding is tolerant: unknown fields survive, unknown verbs and events are
 * dropped, and a message missing a required field decodes to null.
 */
import { TSP_APC_ID, TSP_VERSION, type TspEvent, type TspQuery, type TspReply, type TspVerb } from "@oh-my-pi/pi-wire";

const APC_START = "\x1b_";
const ST = "\x1b\\";
const PREFIX = `${APC_START}${TSP_APC_ID};`;

/** A TSP message as it travels: verb, parameters and the still-encoded body. */
export interface RawTspMessage {
	readonly verb: string;
	readonly params: Readonly<Record<string, string>>;
	readonly body: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let nextChunkId = 0;

function isKeyByte(byte: number): boolean {
	return (
		(byte >= 0x30 && byte <= 0x39) ||
		(byte >= 0x41 && byte <= 0x5a) ||
		(byte >= 0x61 && byte <= 0x7a) ||
		byte === 0x5f
	);
}

/** Whether the bytes at `at` read as a `key=value;` parameter segment. */
function paramShapedAt(bytes: Uint8Array, at: number): boolean {
	let i = at;
	while (i < bytes.length && isKeyByte(bytes[i]!)) i++;
	if (i === at || bytes[i] !== 0x3d) return false;
	for (i++; i < bytes.length; i++) if (bytes[i] === 0x3b) return true;
	return false;
}

/** Whether a chunk may end before `at`: on a code point boundary, with no parameter-shaped remainder. */
function canCut(bytes: Uint8Array, at: number): boolean {
	return (bytes[at]! & 0xc0) !== 0x80 && !paramShapedAt(bytes, at);
}

function header(verb: string, params: Readonly<Record<string, string>> | undefined): string {
	let out = `${PREFIX}${verb};`;
	if (params) for (const key in params) out += `${key}=${params[key]};`;
	return out;
}

/**
 * Encode one message, chunked to `limit` body bytes. Parameter keys must be
 * `[A-Za-z0-9_]+` and values must not contain `;`.
 */
export function encodeTsp(
	verb: TspVerb | "t",
	body: string,
	params?: Readonly<Record<string, string>>,
	limit = Number.POSITIVE_INFINITY,
): string {
	// Every UTF-16 unit is at most 3 UTF-8 bytes: short bodies skip the byte count.
	if (body.length * 3 <= limit || Buffer.byteLength(body) <= limit) return `${header(verb, params)}${body}${ST}`;
	const bytes = encoder.encode(body);
	const id = (nextChunkId++).toString(36);
	const step = Math.max(1, Math.floor(limit));
	let out = "";
	let start = 0;
	let first = true;
	while (start < bytes.length) {
		let end = bytes.length;
		if (bytes.length - start > step) {
			end = start + step;
			while (end > start && !canCut(bytes, end)) end--;
			if (end === start) {
				// No cut fits under the limit: take the first one past it.
				end = start + step + 1;
				while (end < bytes.length && !canCut(bytes, end)) end++;
			}
		}
		const last = end >= bytes.length;
		const chunkParams: Record<string, string> = first && params ? { ...params, c: id } : { c: id };
		if (!last) chunkParams.m = "1";
		out += `${header(verb, chunkParams)}${decoder.decode(bytes.subarray(start, end))}${ST}`;
		first = false;
		start = end;
	}
	return out;
}

/** Encode `value` as a JSON-bodied message. */
export function encodeTspJson(verb: TspVerb | "t", value: unknown, limit?: number): string {
	return encodeTsp(verb, JSON.stringify(value), undefined, limit);
}

const PARAM = /^([A-Za-z0-9_]+)=([^;]*);/;

/** Split the text after `tsp;` into verb, parameters and body. */
export function splitTspPayload(payload: string): RawTspMessage | null {
	const semi = payload.indexOf(";");
	if (semi <= 0) return null;
	const verb = payload.slice(0, semi);
	let rest = payload.slice(semi + 1);
	const params: Record<string, string> = {};
	for (;;) {
		const match = PARAM.exec(rest);
		if (!match) break;
		params[match[1]!] = match[2]!;
		rest = rest.slice(match[0].length);
	}
	return { verb, params, body: rest };
}

/** Parse one complete `ESC _ tsp;… ESC \` string; null when it is not a TSP message. */
export function parseTspApc(sequence: string): RawTspMessage | null {
	if (!sequence.startsWith(PREFIX)) return null;
	const end = sequence.endsWith(ST) ? sequence.length - ST.length : sequence.length;
	return splitTspPayload(sequence.slice(PREFIX.length, end));
}

/** Joins chunked messages (`c=`/`m=1`) back into whole ones. */
export class TspChunkReader {
	readonly #pending = new Map<string, { verb: string; params: Readonly<Record<string, string>>; parts: string[] }>();

	/** Feed one APC message; returns the whole message once its last chunk arrived, else null. */
	feed(message: RawTspMessage): RawTspMessage | null {
		const id = message.params.c;
		if (id === undefined) return message;
		let entry = this.#pending.get(id);
		if (!entry) {
			const { c: _c, m: _m, ...params } = message.params;
			entry = { verb: message.verb, params, parts: [] };
			this.#pending.set(id, entry);
		}
		entry.parts.push(message.body);
		if (message.params.m === "1") return null;
		this.#pending.delete(id);
		return { verb: entry.verb, params: entry.params, body: entry.parts.join("") };
	}

	/** Drop partial messages (a connection reset). */
	clear(): void {
		this.#pending.clear();
	}
}

type Json = Record<string, unknown>;

function parseObject(body: string): Json | null {
	try {
		const value: unknown = JSON.parse(body);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
	} catch {
		return null;
	}
}

const isString = (v: unknown): v is string => typeof v === "string";
const isId = (v: unknown): boolean => typeof v === "string" && v.length > 0;
const isNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const isBoolean = (v: unknown): boolean => typeof v === "boolean";
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every(isString);
/** A field whose presence would pick another shape (see `EVENT_SHAPES`). */
const absent = (v: unknown): boolean => v === undefined;
const optional =
	(check: (v: unknown) => boolean) =>
	(v: unknown): boolean =>
		v === undefined || check(v);

function isChangeValue(v: unknown): boolean {
	return v === null || isBoolean(v) || isNumber(v) || isString(v) || isStrings(v);
}

type Check = (v: unknown) => boolean;
type Shape = Readonly<Record<string, Check>>;
type EventShape<E> = E extends TspEvent ? Record<Exclude<keyof E, "ev">, Check> & Shape : never;

const UI = { sf: isId, id: isId };
const isCell: Check = v =>
	typeof v === "object" && v !== null && "w" in v && isNumber(v.w) && "h" in v && isNumber(v.h);
/** A `TspPicture`: the annotated image a terminal hands back. */
const isPicture: Check = v =>
	isCell(v) &&
	typeof v === "object" &&
	v !== null &&
	"mime" in v &&
	(v.mime === "image/png" || v.mime === "image/jpeg") &&
	"data" in v &&
	isString(v.data);

/**
 * Check each event before exposing it to typed listeners. Where the same tag has two
 * shapes, a present discriminator (`open`, `text`, `comment`) picks the downstream
 * route; a malformed one must not fall through to the other shape.
 */
const EVENT_SHAPES = {
	ack: [{ sf: isId, s: isNumber }],
	resize: [{ sf: optional(isId), cols: isNumber, cell: optional(isCell), visible: optional(isBoolean) }],
	theme: [{ dark: isBoolean }],
	motion: [{ reduce: isBoolean }],
	features: [{ features: isStrings }],
	visible: [{ sf: optional(isId), visible: isBoolean }],
	checkout: [{ sf: optional(isId), shown: isBoolean }],
	toggle: [
		{ ...UI, collapsed: isBoolean, key: optional(isString), open: absent },
		{ ...UI, open: isBoolean, item: optional(isString) },
	],
	select: [{ ...UI, item: isString }],
	activate: [{ ...UI, item: isString }],
	action: [
		{ ...UI, act: isString, value: optional(isString), mods: optional(isStrings), checked: optional(isBoolean) },
	],
	change: [
		{ ...UI, item: isString, value: isChangeValue, text: absent },
		{ ...UI, value: isPicture, item: absent, text: absent },
		{ ...UI, text: isString },
	],
	comment: [
		{ ...UI, quote: isString, at: isNumber, note: isString, comment: absent },
		{ ...UI, comment: isString, note: isString },
	],
	uncomment: [{ ...UI, comment: isString }],
	editing: [{ ...UI, on: isBoolean }],
	edit: [{ ...UI, from: isNumber, to: isNumber, text: isString, cursor: isNumber, len: isNumber }],
	undo: [UI],
	send: [{ ...UI, text: isString }],
	focus: [UI],
	error: [{ sf: optional(isId), s: optional(isNumber), op: optional(isNumber), msg: isString }],
	gone: [{ sf: optional(isId), ids: isStrings }],
} satisfies { [K in TspEvent["ev"]]: readonly EventShape<Extract<TspEvent, { ev: K }>>[] };

function matches(value: Json, shape: Shape): boolean {
	for (const field in shape) if (!shape[field]!(value[field])) return false;
	return true;
}

/** Decode an `e` body; null when malformed or an event this build does not know. */
export function decodeTspEvent(body: string): TspEvent | null {
	const value = parseObject(body);
	if (!value || typeof value.ev !== "string" || !Object.hasOwn(EVENT_SHAPES, value.ev)) return null;
	const shapes = EVENT_SHAPES[value.ev as keyof typeof EVENT_SHAPES];
	if (!shapes.some(shape => matches(value, shape))) return null;
	return value as unknown as TspEvent;
}

/** A `hello` reply. */
export type TspHelloReply = Extract<TspReply, { r: "hello" }>;

const REPLY_SHAPES: Readonly<Record<string, Shape>> = {
	hello: { v: isNumber, term: isString, kinds: isStrings, features: optional(isStrings) },
	blobs: { have: isStrings },
};

/** Decode an `r` body; null when malformed or unknown. */
export function decodeTspReply(body: string): TspReply | null {
	const value = parseObject(body);
	if (!value || typeof value.r !== "string") return null;
	const shape = REPLY_SHAPES[value.r];
	return shape && matches(value, shape) ? (value as unknown as TspReply) : null;
}

/** What the program advertises in its `hello` query. */
export interface TspHelloOptions {
	/** Program name. Default `omp`. */
	readonly app?: string;
	readonly ver?: string;
	/** Program features. Default `edit`, `undo`, `send`. */
	readonly features?: readonly string[];
}

/** The `hello` query as an APC string (the driver may send it with its startup probes). */
export function encodeHelloQuery(options: TspHelloOptions = {}): string {
	const query: TspQuery = {
		q: "hello",
		v: [TSP_VERSION],
		app: options.app ?? "omp",
		features: options.features ?? ["edit", "undo", "send"],
		...(options.ver === undefined ? {} : { ver: options.ver }),
	};
	return encodeTspJson("q", query);
}
