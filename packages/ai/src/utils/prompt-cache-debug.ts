import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { getReportsDir, logger } from "@oh-my-pi/pi-utils";

export const PROMPT_CACHE_DEBUG_ENV = "PI_PROMPT_CACHE_DEBUG";
export const PROMPT_CACHE_DEBUG_FILE = "prompt-cache-debug.jsonl";

const JOURNAL_VERSION = 1;
const DEFAULT_MAX_RECORDS = 256;
const MAX_BASELINE_COUNT = 32;
const STALE_JOURNAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const LONG_TTL_MS = 60 * 60 * 1000;
const MAX_DIGEST_LENGTH = 32;
const MAX_ENDPOINT_LENGTH = 256;
const MAX_REQUEST_ID_LENGTH = 128;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

type HmacKey = Uint8Array;

/** Reset explanations are ordered by evidence strength in {@link classifyReset}. */
export type PromptCacheResetCause =
	| "cache-key-change"
	| "retention-change"
	| "breakpoint-movement"
	| "prefix-mutation"
	| "message-rewrite-prune"
	| "compaction-branch-replay"
	| "ttl-expiry"
	| "provider-declared"
	| "unknown";

export type PromptCacheRequestOutcome = "success" | "error";
export type PromptCacheDiagnosticBodySource = "wire" | "prepared";
export type PromptCacheSegmentKind = "system" | "tool" | "message";
export type PromptCacheMutation =
	| "append"
	| "system-mutation"
	| "message-rewrite"
	| "breakpoint-movement"
	| "compaction"
	| "unknown";

/** Usage fields are null when the provider did not report that field. */
export interface PromptCacheDiagnosticUsage {
	input: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	output: number | null;
}

export interface PromptCacheDiagnosticSegment {
	kind: PromptCacheSegmentKind;
	index: number;
	/** Exact UTF-8 bytes occupied by this serialized JSON segment. */
	bytes: number;
	tokenEstimate: number | null;
	/** HMAC of the exact serialized segment bytes. */
	digest: string | null;
	/** HMAC of the marker-normalized segment, used for context comparisons. */
	semanticDigest: string | null;
}

export interface PromptCacheDiagnosticMarker {
	kind: PromptCacheSegmentKind;
	segmentIndex: number;
	ordinal: number;
	/** Array-index path within the segment; object/property names are omitted. */
	location: number[];
	type: string | null;
	/** Exact UTF-8 byte offset of the `cache_control` key in the request body. */
	byteOffset: number;
	ttl: "5m" | "1h" | null;
}

export type PromptCacheBodyCompaction = "present" | "absent" | "unknown";

/** Latest authoritative branch rewrite state from the caller's transcript. */
export interface PromptCacheDiagnosticBranchState {
	timestamp: number;
	fromId: string;
}

/** Latest authoritative compaction rewrite state from the caller's transcript. */
export interface PromptCacheDiagnosticCompactionState {
	timestamp: number;
}

/** Context facts a caller can supply when they are not represented on the wire. */
export interface PromptCacheDiagnosticContextInput {
	nonMessageTokens?: number | null;
	messageLogDivergenceIndex?: number | null;
	branchState?: PromptCacheDiagnosticBranchState | null;
	compactionState?: PromptCacheDiagnosticCompactionState | null;
	pruneState?: number | null;
	mutation?: PromptCacheMutation | null;
}

/** Provider-neutral request context derived from the captured body when available. */
export interface PromptCacheDiagnosticContext {
	/** Number of serialized system/tool tokens, excluding message segments. */
	nonMessageTokens: number | null;
	/** Index of the first message that diverged from the previous request. */
	messageLogDivergenceIndex: number | null;
	/** Whether an Anthropic compaction block is present in the captured body. */
	compaction: PromptCacheBodyCompaction;
	/** HMAC of the latest branch summary state, or null when unavailable. */
	branchStateDigest: string | null;
	/** HMAC of the latest compaction summary state, or null when unavailable. */
	compactionStateDigest: string | null;
	/** HMAC of the latest pruned-at timestamp, or null when unavailable. */
	pruneStateDigest: string | null;
	mutation: PromptCacheMutation;
}

export interface PromptCacheDiagnosticRequestInfo {
	/** Serialized request body captured from the wire or prepared before SDK serialization. */
	body: string | Uint8Array | ArrayBuffer | null;
	/** Whether body came from transport bytes or prepared SDK parameters. */
	bodySource?: PromptCacheDiagnosticBodySource;
	endpoint: string;
	provider: string;
	model: string;
	api: string;
	/** Raw affinity is accepted only transiently and is HMACed before recording. */
	cacheAffinity?: string | null;
	/** Logical session scope is HMACed and is never persisted in raw form. */
	sessionScope?: string | null;
	retention?: string | null;
	ttlMs?: number | null;
	/** Optional context facts unavailable in the serialized provider body. */
	context?: PromptCacheDiagnosticContextInput;
}

export interface PromptCacheDiagnosticRequest {
	digest: string | null;
	/** UTF-8 bytes of the captured body; exact transport bytes only when bodySource is "wire". */
	bytes: number | null;
	/** Explicitly heuristic serialized-byte token estimate. */
	tokenEstimate: number | null;
	/** HMAC of the marker-normalized stable system/tool prefix. */
	stablePrefixDigest: string | null;
	stablePrefixBytes: number | null;
	stablePrefixTokenEstimate: number | null;
	/** HMACs of semantic prefixes ending at each cache breakpoint. */
	cachePrefixDigests: string[];
	segments: PromptCacheDiagnosticSegment[];
	/** Total serialized segments, including any details omitted from retained records. */
	segmentCount: number;
	/** Number of segment details omitted after this record stopped being the tail. */
	omittedSegmentCount: number;
	firstSegmentDigest: string | null;
	lastSegmentDigest: string | null;
	markers: PromptCacheDiagnosticMarker[];
	/** Estimated token count through the last equal segment boundary. */
	previousLcpTokens: number | null;
	firstDivergentSegmentDigest: string | null;
}

export interface PromptCacheDiagnosticCache {
	scopeDigest: string | null;
	affinityDigest: string | null;
	retention: string | null;
	ttlMs: number | null;
	markers: PromptCacheDiagnosticMarker[];
}

export interface PromptCacheDiagnosticReset {
	observed: boolean;
	cause: PromptCacheResetCause | null;
	/** Estimated tokens after the previous request's equal segment prefix. */
	rewriteTokens: number | null;
	previousSequence: number | null;
	relevantSequences: number[];
}

export interface PromptCacheDiagnosticRecord {
	version: number;
	kind: "prompt-cache";
	sequence: number;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	outcome: PromptCacheRequestOutcome;
	provider: string;
	model: string;
	api: string;
	bodySource: PromptCacheDiagnosticBodySource;
	endpoint: string;
	status: number | null;
	requestId: string | null;
	errorCode: string | null;
	cache: PromptCacheDiagnosticCache;
	request: PromptCacheDiagnosticRequest;
	context: PromptCacheDiagnosticContext;
	usage: PromptCacheDiagnosticUsage;
	reset: PromptCacheDiagnosticReset;
}

export interface PromptCacheDebugSnapshot {
	enabled: boolean;
	records: PromptCacheDiagnosticRecord[];
	droppedRecords: number;
	droppedBytes: number;
	maxRecords: number;
	maxBytes: number;
}

export interface PromptCacheDebugView {
	enabled: boolean;
	recordCount: number;
	droppedRecords: number;
	resetCount: number;
	largestRewriteTokens: number | null;
	currentStablePrefixDigest: string | null;
	ageSinceLastCacheTouchMs: number | null;
	classification: PromptCacheResetCause | null;
	relevantSequences: number[];
}

export interface PromptCacheDebugJournalOptions {
	maxRecords?: number;
	maxBytes?: number;
	filePath?: string;
	now?: () => number;
}

export interface PromptCacheDiagnosticResponse {
	status: number;
	requestId?: string | null;
}

export interface PromptCacheDiagnosticFailure {
	status?: number | null;
	code?: string | null;
}

function finiteNonNegative(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return value;
}

function finiteInteger(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
	return value;
}

function positiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
	return Math.floor(value);
}

function utf8Bytes(value: string): number {
	return TEXT_ENCODER.encode(value).byteLength;
}

function utf8ByteOffsets(text: string, positions: readonly number[]): Map<number, number> {
	const wanted = new Set(positions);
	const offsets = new Map<number, number>();
	let byteOffset = 0;
	for (let index = 0; index <= text.length; index++) {
		if (wanted.has(index)) offsets.set(index, byteOffset);
		if (index === text.length) break;
		const code = text.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				byteOffset += 4;
				index++;
				continue;
			}
		}
		byteOffset += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
	}
	return offsets;
}

function bytesForBody(body: PromptCacheDiagnosticRequestInfo["body"]): Uint8Array | null {
	if (body === null) return null;
	if (typeof body === "string") return TEXT_ENCODER.encode(body);
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	return null;
}

function digest(key: HmacKey, value: string): string {
	return nodeCrypto.createHmac("sha256", key).update(value).digest("hex").slice(0, MAX_DIGEST_LENGTH);
}

function digestBytes(key: HmacKey, value: Uint8Array): string {
	return nodeCrypto.createHmac("sha256", key).update(value).digest("hex").slice(0, MAX_DIGEST_LENGTH);
}

const HMAC_BLOCK_SIZE = 64;

interface HmacPads {
	inner: Uint8Array;
	outer: Uint8Array;
}

function createHmacPads(key: HmacKey): HmacPads {
	const keyBlock = new Uint8Array(HMAC_BLOCK_SIZE);
	if (key.byteLength > HMAC_BLOCK_SIZE) {
		const hashedKey = nodeCrypto.createHash("sha256").update(key).digest();
		keyBlock.set(hashedKey);
	} else {
		keyBlock.set(key);
	}
	const inner = new Uint8Array(HMAC_BLOCK_SIZE);
	const outer = new Uint8Array(HMAC_BLOCK_SIZE);
	for (let index = 0; index < HMAC_BLOCK_SIZE; index++) {
		const value = keyBlock[index]!;
		inner[index] = value ^ 0x36;
		outer[index] = value ^ 0x5c;
	}
	return { inner, outer };
}

interface IncrementalHmac {
	update(value: string | Uint8Array): void;
	snapshotDigest(): string;
	digest(): string;
}

function createIncrementalHmac(pads: HmacPads): IncrementalHmac {
	const inner = nodeCrypto.createHash("sha256");
	inner.update(pads.inner);
	let complete = false;
	const digestFrom = (hash: nodeCrypto.Hash): string => {
		const innerDigest = hash.digest();
		return nodeCrypto
			.createHash("sha256")
			.update(pads.outer)
			.update(innerDigest)
			.digest("hex")
			.slice(0, MAX_DIGEST_LENGTH);
	};
	return {
		update(value: string | Uint8Array): void {
			if (!complete) inner.update(value);
		},
		snapshotDigest(): string {
			return digestFrom(inner.copy());
		},
		digest(): string {
			complete = true;
			return digestFrom(inner);
		},
	};
}

function stateTimestamp(value: unknown): number | null {
	return finiteInteger(value);
}

function branchStateDigest(key: HmacKey, state: PromptCacheDiagnosticBranchState | null | undefined): string | null {
	if (state === null || state === undefined || typeof state !== "object") return null;
	const timestamp = stateTimestamp(state.timestamp);
	if (timestamp === null || typeof state.fromId !== "string") return null;
	return digest(key, JSON.stringify(["branch", timestamp, state.fromId]));
}

function compactionStateDigest(
	key: HmacKey,
	state: PromptCacheDiagnosticCompactionState | null | undefined,
): string | null {
	if (state === null || state === undefined || typeof state !== "object") return null;
	const timestamp = stateTimestamp(state.timestamp);
	return timestamp === null ? null : digest(key, JSON.stringify(["compaction", timestamp]));
}

function pruneStateDigest(key: HmacKey, state: number | null | undefined): string | null {
	const timestamp = state === null || state === undefined ? null : stateTimestamp(state);
	return timestamp === null ? null : digest(key, JSON.stringify(["prune", timestamp]));
}

function estimateTokens(bytes: number | null): number | null {
	if (bytes === null) return null;
	if (bytes === 0) return 0;
	return Math.ceil(bytes / 4);
}

function markerTtl(text: string, value: JsonSpan): "5m" | "1h" | null {
	if (text[value.start] !== "{") return null;
	const ttlSpan = objectFieldSpans(text, value).get("ttl");
	const ttl = ttlSpan === undefined ? null : parseJsonString(text, ttlSpan);
	return ttl === "1h" ? "1h" : ttl === "5m" ? "5m" : null;
}

function safeEndpointIdentity(endpoint: string, key: HmacKey): string {
	try {
		const parsed = new URL(endpoint);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "unknown";
		if (!parsed.hostname) return "unknown";
		const host = parsed.hostname.toLowerCase();
		const port =
			parsed.port &&
			!(
				(parsed.protocol === "https:" && parsed.port === "443") ||
				(parsed.protocol === "http:" && parsed.port === "80")
			)
				? `:${parsed.port}`
				: "";
		const origin = `${parsed.protocol}//${host}${port}`;
		const pathDigest = digest(key, parsed.pathname || "/");
		return `${origin}/path-hmac-${pathDigest}`.slice(0, MAX_ENDPOINT_LENGTH);
	} catch {
		return "unknown";
	}
}

function safeRetention(value: string | null | undefined): string | null {
	return value === "auto" || value === "none" || value === "short" || value === "long" ? value : null;
}

function safeRequestId(value: string | null | undefined): string | null {
	if (!value) return null;
	const safe = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, MAX_REQUEST_ID_LENGTH);
	return safe.length > 0 ? safe : null;
}

function sanitizedErrorCode(code: string | null | undefined): string | null {
	if (!code) return null;
	const safe = code.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
	return safe.length > 0 ? safe : null;
}

function skipWhitespace(text: string, start: number): number {
	let index = start;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
		index++;
	}
	return index;
}

function scanStringEnd(text: string, start: number): number | null {
	if (text[start] !== '"') return null;
	let index = start + 1;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === '"') return index + 1;
		index++;
	}
	return null;
}

function scanJsonValueEnd(text: string, start: number): number | null {
	const valueStart = skipWhitespace(text, start);
	const char = text[valueStart];
	if (char === '"') return scanStringEnd(text, valueStart);
	if (char === "[") {
		let index = skipWhitespace(text, valueStart + 1);
		if (text[index] === "]") return index + 1;
		while (index < text.length) {
			const end = scanJsonValueEnd(text, index);
			if (end === null) return null;
			index = skipWhitespace(text, end);
			if (text[index] === "]") return index + 1;
			if (text[index] !== ",") return null;
			index = skipWhitespace(text, index + 1);
		}
		return null;
	}
	if (char === "{") {
		let index = skipWhitespace(text, valueStart + 1);
		if (text[index] === "}") return index + 1;
		while (index < text.length) {
			const keyEnd = scanStringEnd(text, index);
			if (keyEnd === null) return null;
			index = skipWhitespace(text, keyEnd);
			if (text[index] !== ":") return null;
			const valueEnd = scanJsonValueEnd(text, index + 1);
			if (valueEnd === null) return null;
			index = skipWhitespace(text, valueEnd);
			if (text[index] === "}") return index + 1;
			if (text[index] !== ",") return null;
			index = skipWhitespace(text, index + 1);
		}
		return null;
	}
	let primitiveEnd = valueStart;
	while (primitiveEnd < text.length) {
		const code = text.charCodeAt(primitiveEnd);
		if (
			code === 0x20 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0d ||
			text[primitiveEnd] === "," ||
			text[primitiveEnd] === "]" ||
			text[primitiveEnd] === "}"
		) {
			break;
		}
		primitiveEnd++;
	}
	return primitiveEnd;
}

interface JsonSpan {
	start: number;
	end: number;
}

function parseJsonSpan(text: string, start: number): JsonSpan | null {
	const valueStart = skipWhitespace(text, start);
	const end = scanJsonValueEnd(text, valueStart);
	return end === null ? null : { start: valueStart, end };
}

function parseJsonString(text: string, span: JsonSpan): string | null {
	if (text[span.start] !== '"' || text[span.end - 1] !== '"') return null;
	let value = "";
	for (let index = span.start + 1; index < span.end - 1; index++) {
		const char = text[index]!;
		if (char !== "\\") {
			if (text.charCodeAt(index) < 0x20) return null;
			value += char;
			continue;
		}
		const escape = text[++index];
		if (escape === undefined) return null;
		switch (escape) {
			case '"':
			case "\\":
			case "/":
				value += escape;
				break;
			case "b":
				value += "\b";
				break;
			case "f":
				value += "\f";
				break;
			case "n":
				value += "\n";
				break;
			case "r":
				value += "\r";
				break;
			case "t":
				value += "\t";
				break;
			case "u": {
				const hex = text.slice(index + 1, index + 5);
				if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return null;
				value += String.fromCharCode(Number.parseInt(hex, 16));
				index += 4;
				break;
			}
			default:
				return null;
		}
	}
	return value;
}

interface ObjectField {
	key: string | null;
	keyStart: number;
	value: JsonSpan;
}

function objectFieldEntries(text: string, object: JsonSpan): ObjectField[] {
	const fields: ObjectField[] = [];
	if (text[object.start] !== "{") return fields;
	let index = skipWhitespace(text, object.start + 1);
	while (index < object.end - 1 && text[index] !== "}") {
		const keyStart = index;
		const keyEnd = scanStringEnd(text, keyStart);
		if (keyEnd === null) break;
		const key = parseJsonString(text, { start: keyStart, end: keyEnd });
		index = skipWhitespace(text, keyEnd);
		if (text[index] !== ":") break;
		const value = parseJsonSpan(text, index + 1);
		if (value === null) break;
		fields.push({ key, keyStart, value });
		index = skipWhitespace(text, value.end);
		if (text[index] !== ",") break;
		index = skipWhitespace(text, index + 1);
	}
	return fields;
}

function objectFieldSpans(text: string, object: JsonSpan): Map<string, JsonSpan> {
	const fields = new Map<string, JsonSpan>();
	for (const field of objectFieldEntries(text, object)) {
		if (field.key !== null) fields.set(field.key, field.value);
	}
	return fields;
}

function arrayElementSpans(text: string, array: JsonSpan): JsonSpan[] {
	const elements: JsonSpan[] = [];
	if (text[array.start] !== "[") return elements;
	let index = skipWhitespace(text, array.start + 1);
	while (index < array.end - 1 && text[index] !== "]") {
		const element = parseJsonSpan(text, index);
		if (element === null) break;
		elements.push(element);
		index = skipWhitespace(text, element.end);
		if (text[index] !== ",") break;
		index = skipWhitespace(text, index + 1);
	}
	return elements;
}

interface MarkerSpan {
	keyStart: number;
	value: JsonSpan;
	containerEnd: number;
	location: number[];
	type: string | null;
}

function cacheControlType(text: string, value: JsonSpan): string | null {
	if (text[value.start] !== "{") return null;
	const typeSpan = objectFieldSpans(text, value).get("type");
	const type = typeSpan === undefined ? null : parseJsonString(text, typeSpan);
	return type === "ephemeral" ? type : null;
}

function collectDirectMarkerSpans(text: string, block: JsonSpan, output: MarkerSpan[], location: number[]): void {
	if (text[block.start] !== "{") return;
	for (const field of objectFieldEntries(text, block)) {
		if (field.key !== "cache_control") continue;
		output.push({
			keyStart: field.keyStart,
			value: field.value,
			containerEnd: block.end,
			location: [...location],
			type: cacheControlType(text, field.value),
		});
	}
}

function collectMarkerSpans(text: string, span: JsonSpan, kind: PromptCacheSegmentKind, output: MarkerSpan[]): void {
	if (kind !== "message") {
		collectDirectMarkerSpans(text, span, output, []);
		return;
	}
	if (text[span.start] !== "{") return;
	const content = objectFieldSpans(text, span).get("content");
	if (content === undefined || text[content.start] !== "[") return;
	const blocks = arrayElementSpans(text, content);
	for (let index = 0; index < blocks.length; index++) {
		collectDirectMarkerSpans(text, blocks[index]!, output, [index]);
	}
}

interface CachePrefixState {
	marker: MarkerSpan;
	digest: string | null;
}

type SemanticPrefixUpdate = (value: string | Uint8Array) => void;

function updateSemanticObject(text: string, object: JsonSpan, update: SemanticPrefixUpdate): void {
	const fields = objectFieldEntries(text, object);
	update("{");
	let emitted = false;
	for (const field of fields) {
		if (field.key === "cache_control") continue;
		if (emitted) update(",");
		update(text.slice(field.keyStart, field.value.end));
		emitted = true;
	}
	update("}");
}

function updateSemanticMessage(
	text: string,
	object: JsonSpan,
	markerStates: readonly CachePrefixState[],
	update: SemanticPrefixUpdate,
	finish: (state: CachePrefixState) => void,
): void {
	const fields = objectFieldEntries(text, object);
	update("{");
	let emitted = false;
	for (const field of fields) {
		const isContent = field.key === "content" && text[field.value.start] === "[";
		if (emitted) update(",");
		update(text.slice(field.keyStart, field.value.start));
		if (!isContent) {
			update(text.slice(field.value.start, field.value.end));
			emitted = true;
			continue;
		}
		update("[");
		const blocks = arrayElementSpans(text, field.value);
		let markerIndex = 0;
		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			if (blockIndex > 0) update(",");
			const block = blocks[blockIndex]!;
			updateSemanticObject(text, block, update);
			while (markerIndex < markerStates.length) {
				const state = markerStates[markerIndex]!;
				const location = state.marker.location;
				if (location.length !== 1 || location[0] !== blockIndex) break;
				finish(state);
				markerIndex++;
			}
		}
		update("]");
		emitted = true;
	}
	update("}");
}

function parseBody(body: Uint8Array): { text: string; root: JsonSpan } | null {
	const text = TEXT_DECODER.decode(body);
	const root = parseJsonSpan(text, 0);
	if (root === null || text[root.start] !== "{" || skipWhitespace(text, root.end) !== text.length) return null;
	return { text, root };
}

interface SegmentValue {
	kind: PromptCacheSegmentKind;
	index: number;
	span: JsonSpan;
}
interface BodyAnalysis {
	segments: PromptCacheDiagnosticSegment[];
	markers: PromptCacheDiagnosticMarker[];
	stablePrefixBytes: number | null;
	stablePrefixTokenEstimate: number | null;
	stablePrefixDigest: string | null;
	nonMessageTokens: number | null;
	cachePrefixDigests: string[];
	compaction: PromptCacheBodyCompaction;
}

const SEGMENT_FIELDS: ReadonlyArray<readonly [string, PromptCacheSegmentKind]> = [
	["tools", "tool"],
	["system", "system"],
	["messages", "message"],
];

function bodyHasCompaction(text: string, root: JsonSpan): "present" | "absent" {
	const messages = objectFieldSpans(text, root).get("messages");
	if (messages === undefined || text[messages.start] !== "[") return "absent";
	for (const message of arrayElementSpans(text, messages)) {
		if (text[message.start] !== "{") continue;
		const content = objectFieldSpans(text, message).get("content");
		if (content === undefined || text[content.start] !== "[") continue;
		for (const block of arrayElementSpans(text, content)) {
			if (text[block.start] !== "{") continue;
			const typeSpan = objectFieldSpans(text, block).get("type");
			const type = typeSpan === undefined ? null : parseJsonString(text, typeSpan);
			if (type === "compaction" || type === "compaction_summary") return "present";
		}
	}
	return "absent";
}

function analyzeBody(body: Uint8Array | null, key: HmacKey): BodyAnalysis {
	if (body === null) {
		return {
			segments: [],
			markers: [],
			stablePrefixBytes: null,
			stablePrefixTokenEstimate: null,
			stablePrefixDigest: null,
			nonMessageTokens: null,
			cachePrefixDigests: [],
			compaction: "unknown",
		};
	}
	const parsedBody = parseBody(body);
	if (parsedBody === null) {
		return {
			segments: [],
			markers: [],
			stablePrefixBytes: null,
			stablePrefixTokenEstimate: null,
			stablePrefixDigest: null,
			nonMessageTokens: null,
			cachePrefixDigests: [],
			compaction: "unknown",
		};
	}

	const { text, root } = parsedBody;
	const fields = objectFieldSpans(text, root);
	const values: SegmentValue[] = [];
	for (const [field, kind] of SEGMENT_FIELDS) {
		const span = fields.get(field);
		if (span === undefined) continue;
		const elements = text[span.start] === "[" ? arrayElementSpans(text, span) : [span];
		for (let index = 0; index < elements.length; index++) values.push({ kind, index, span: elements[index] });
	}

	interface AnalyzedSegment {
		value: SegmentValue;
		markers: MarkerSpan[];
	}
	const analyzedSegments: AnalyzedSegment[] = [];
	for (const segment of values) {
		const markerSpans: MarkerSpan[] = [];
		collectMarkerSpans(text, segment.span, segment.kind, markerSpans);
		analyzedSegments.push({ value: segment, markers: markerSpans });
	}
	const offsetPositions: number[] = [];
	for (const analyzed of analyzedSegments) {
		offsetPositions.push(analyzed.value.span.start, analyzed.value.span.end);
		for (const marker of analyzed.markers) offsetPositions.push(marker.keyStart, marker.containerEnd);
	}
	const byteOffsets = utf8ByteOffsets(text, offsetPositions);
	const byteOffsetAt = (position: number): number => byteOffsets.get(position) ?? 0;
	const segments: PromptCacheDiagnosticSegment[] = [];
	const rawSegments: Uint8Array[] = [];
	const markers: PromptCacheDiagnosticMarker[] = [];
	let nonMessageBytes = 0;
	for (const analyzed of analyzedSegments) {
		const segment = analyzed.value;
		const raw = body.subarray(byteOffsetAt(segment.span.start), byteOffsetAt(segment.span.end));
		const rawDigest = digestBytes(key, raw);
		rawSegments.push(raw);
		segments.push({
			kind: segment.kind,
			index: segment.index,
			bytes: raw.byteLength,
			tokenEstimate: estimateTokens(raw.byteLength),
			digest: rawDigest,
			semanticDigest: rawDigest,
		});
		if (segment.kind !== "message") nonMessageBytes += raw.byteLength;
		for (let ordinal = 0; ordinal < analyzed.markers.length; ordinal++) {
			const marker = analyzed.markers[ordinal]!;
			markers.push({
				kind: segment.kind,
				segmentIndex: segment.index,
				ordinal,
				location: marker.location,
				type: marker.type,
				byteOffset: byteOffsetAt(marker.keyStart),
				ttl: markerTtl(text, marker.value),
			});
		}
	}
	const compaction = bodyHasCompaction(text, root);
	if (markers.length === 0) {
		return {
			segments,
			markers,
			stablePrefixBytes: null,
			stablePrefixTokenEstimate: null,
			stablePrefixDigest: null,
			cachePrefixDigests: [],
			nonMessageTokens: estimateTokens(nonMessageBytes),
			compaction,
		};
	}
	const hmacPads = createHmacPads(key);
	// Anthropic's JSON field order is not its cache-prefix order; keep message
	// segments after the stable head when selecting the semantic final marker.
	let lastMarkerSegmentPosition = -1;
	let lastMarker: MarkerSpan | undefined;
	for (let position = 0; position < analyzedSegments.length; position++) {
		const analyzed = analyzedSegments[position]!;
		if (analyzed.value.kind === "message") continue;
		const marker = analyzed.markers.at(-1);
		if (marker !== undefined) {
			lastMarkerSegmentPosition = position;
			lastMarker = marker;
		}
	}
	const stablePrefixHmac = lastMarker === undefined ? null : createIncrementalHmac(hmacPads);
	let stablePrefixBytes = 0;
	let stablePrefixDigest: string | null = null;
	if (lastMarker !== undefined && stablePrefixHmac !== null) {
		for (let position = 0; position < analyzedSegments.length; position++) {
			const analyzed = analyzedSegments[position]!;
			let prefix: Uint8Array | null = null;
			if (position < lastMarkerSegmentPosition) {
				prefix = rawSegments[position]!;
			} else if (position === lastMarkerSegmentPosition) {
				prefix = body.subarray(byteOffsetAt(analyzed.value.span.start), byteOffsetAt(lastMarker.containerEnd));
			}
			if (prefix === null) break;
			stablePrefixBytes += prefix.byteLength;
			stablePrefixHmac.update(`${analyzed.value.kind}:${analyzed.value.index}\u0000`);
			if (analyzed.markers.length === 0) {
				stablePrefixHmac.update(rawSegments[position]!);
			} else {
				const updateStablePrefix: SemanticPrefixUpdate = value => stablePrefixHmac.update(value);
				updateSemanticObject(text, analyzed.value.span, updateStablePrefix);
			}
			if (position === lastMarkerSegmentPosition) break;
		}
		stablePrefixDigest = stablePrefixHmac.digest();
	}
	const prefixHmac = createIncrementalHmac(hmacPads);
	const prefixStatesBySegment: CachePrefixState[][] = analyzedSegments.map(analyzed =>
		analyzed.markers.map(marker => ({ marker, digest: null })),
	);
	const prefixStates = prefixStatesBySegment.flat();
	const updatePrefix: SemanticPrefixUpdate = value => prefixHmac.update(value);
	const finishPrefix = (state: CachePrefixState): void => {
		if (state.digest === null) state.digest = prefixHmac.snapshotDigest();
	};
	for (let position = 0; position < analyzedSegments.length; position++) {
		const analyzed = analyzedSegments[position]!;
		const label = `${analyzed.value.kind}:${analyzed.value.index}\u0000`;
		const states = prefixStatesBySegment[position]!;
		updatePrefix(label);
		if (states.length === 0) {
			updatePrefix(rawSegments[position]!);
			continue;
		}
		const semanticHmac = createIncrementalHmac(hmacPads);
		const updateSegmentAndPrefix: SemanticPrefixUpdate = value => {
			semanticHmac.update(value);
			updatePrefix(value);
		};
		if (analyzed.value.kind === "message") {
			updateSemanticMessage(text, analyzed.value.span, states, updateSegmentAndPrefix, finishPrefix);
		} else {
			updateSemanticObject(text, analyzed.value.span, updateSegmentAndPrefix);
			for (const state of states) finishPrefix(state);
		}
		segments[position]!.semanticDigest = semanticHmac.digest();
	}
	const cachePrefixDigests = prefixStates
		.map(state => state.digest)
		.filter((value): value is string => value !== null);
	return {
		segments,
		markers,
		stablePrefixBytes: stablePrefixDigest === null ? null : stablePrefixBytes,
		stablePrefixTokenEstimate: stablePrefixDigest === null ? null : estimateTokens(stablePrefixBytes),
		stablePrefixDigest,
		cachePrefixDigests,
		nonMessageTokens: estimateTokens(nonMessageBytes),
		compaction,
	};
}

/** Compare exact serialized segment bytes for raw LCP accounting. */
function segmentsEqual(left: PromptCacheDiagnosticSegment, right: PromptCacheDiagnosticSegment): boolean {
	return (
		left.kind === right.kind && left.index === right.index && left.digest !== null && left.digest === right.digest
	);
}

/** Compare marker-normalized segments so rolling breakpoints do not look like rewrites. */
function semanticSegmentsEqual(left: PromptCacheDiagnosticSegment, right: PromptCacheDiagnosticSegment): boolean {
	return (
		left.kind === right.kind &&
		left.index === right.index &&
		left.semanticDigest !== null &&
		left.semanticDigest === right.semanticDigest
	);
}

function segmentLcp(
	previous: PromptCacheDiagnosticRequest,
	current: PromptCacheDiagnosticRequest,
): { tokens: number | null; firstDivergentSegmentDigest: string | null } {
	if (previous.digest === null || current.digest === null) {
		return { tokens: null, firstDivergentSegmentDigest: null };
	}
	let tokens = 0;
	let firstDivergentSegmentDigest: string | null = null;
	const sharedLength = Math.min(previous.segments.length, current.segments.length);
	for (let index = 0; index < sharedLength; index++) {
		const previousSegment = previous.segments[index]!;
		const currentSegment = current.segments[index]!;
		if (segmentsEqual(previousSegment, currentSegment)) {
			tokens += currentSegment.tokenEstimate ?? 0;
			continue;
		}
		firstDivergentSegmentDigest = currentSegment.digest;
		return { tokens, firstDivergentSegmentDigest };
	}
	if (current.segments.length > previous.segments.length) {
		firstDivergentSegmentDigest = current.segments[sharedLength]?.digest ?? null;
	}
	return { tokens, firstDivergentSegmentDigest };
}

/** Find the first message change after ignoring only cache-control marker metadata. */
function semanticMessageDivergenceIndex(
	previous: PromptCacheDiagnosticRequest,
	current: PromptCacheDiagnosticRequest,
): number | null {
	const sharedLength = Math.min(previous.segments.length, current.segments.length);
	for (let index = 0; index < sharedLength; index++) {
		const previousSegment = previous.segments[index]!;
		const currentSegment = current.segments[index]!;
		if (previousSegment.kind !== "message" && currentSegment.kind !== "message") continue;
		if (semanticSegmentsEqual(previousSegment, currentSegment)) continue;
		return currentSegment.kind === "message" ? currentSegment.index : previousSegment.index;
	}
	for (let index = sharedLength; index < previous.segments.length; index++) {
		const previousSegment = previous.segments[index]!;
		if (previousSegment.kind === "message") return previousSegment.index;
	}
	return null;
}

function markerShapeEqual(left: PromptCacheDiagnosticMarker, right: PromptCacheDiagnosticMarker): boolean {
	return (
		left.kind === right.kind &&
		left.segmentIndex === right.segmentIndex &&
		left.ordinal === right.ordinal &&
		left.location.length === right.location.length &&
		left.location.every((value, index) => value === right.location[index]) &&
		left.type === right.type &&
		left.ttl === right.ttl
	);
}

function markersHaveSameShape(
	left: readonly PromptCacheDiagnosticMarker[],
	right: readonly PromptCacheDiagnosticMarker[],
): boolean {
	if (left.length !== right.length) return false;
	return left.every((marker, index) => markerShapeEqual(marker, right[index]!));
}

function headMarkersEqual(
	left: readonly PromptCacheDiagnosticMarker[],
	right: readonly PromptCacheDiagnosticMarker[],
): boolean {
	return markersHaveSameShape(
		left.filter(marker => marker.kind !== "message"),
		right.filter(marker => marker.kind !== "message"),
	);
}

function semanticPrefixEqual(previous: PromptCacheDiagnosticRequest, current: PromptCacheDiagnosticRequest): boolean {
	if (current.segments.length < previous.segments.length) return false;
	return previous.segments.every((segment, index) => {
		const currentSegment = current.segments[index];
		return currentSegment !== undefined && semanticSegmentsEqual(segment, currentSegment);
	});
}

function breakpointMovementObserved(
	previous: PromptCacheDiagnosticRequest,
	current: PromptCacheDiagnosticRequest,
): boolean {
	if (!headMarkersEqual(previous.markers, current.markers)) return true;
	const previousMessageMarkers = previous.markers.filter(marker => marker.kind === "message");
	const currentMessageMarkers = current.markers.filter(marker => marker.kind === "message");
	if (markersHaveSameShape(previousMessageMarkers, currentMessageMarkers)) return false;
	return current.segments.length <= previous.segments.length || !semanticPrefixEqual(previous, current);
}

function changedGenerationState(
	previous: PromptCacheDiagnosticRecord,
	current: Pick<PromptCacheDiagnosticContext, "branchStateDigest" | "compactionStateDigest" | "pruneStateDigest">,
): { branch: boolean; compaction: boolean; prune: boolean } {
	return {
		branch: current.branchStateDigest !== null && current.branchStateDigest !== previous.context.branchStateDigest,
		compaction:
			current.compactionStateDigest !== null &&
			current.compactionStateDigest !== previous.context.compactionStateDigest,
		prune: current.pruneStateDigest !== null && current.pruneStateDigest !== previous.context.pruneStateDigest,
	};
}

function semanticSegmentsThrough(
	previous: PromptCacheDiagnosticRequest,
	current: PromptCacheDiagnosticRequest,
	previousBoundaryPosition: number,
	currentBoundaryPosition: number,
): boolean {
	if (previousBoundaryPosition !== currentBoundaryPosition) return false;
	for (let index = 0; index <= previousBoundaryPosition; index++) {
		const previousSegment = previous.segments[index];
		const currentSegment = current.segments[index];
		if (
			previousSegment === undefined ||
			currentSegment === undefined ||
			!semanticSegmentsEqual(previousSegment, currentSegment)
		) {
			return false;
		}
	}
	return true;
}

function cacheablePrefixState(
	previous: PromptCacheDiagnosticRecord,
	current: PromptCacheDiagnosticRequest,
): { preserved: boolean; changed: boolean } {
	const previousFinalDigest = previous.request.cachePrefixDigests.at(-1);
	if (previousFinalDigest === undefined || current.cachePrefixDigests.length === 0) {
		return { preserved: false, changed: false };
	}
	if (current.cachePrefixDigests.includes(previousFinalDigest)) {
		return { preserved: true, changed: false };
	}
	const previousFinalMarker = previous.request.markers.at(-1);
	if (previousFinalMarker === undefined || previousFinalMarker.kind !== "message") {
		return { preserved: false, changed: true };
	}
	const previousBoundaryPosition = previous.request.segments.findIndex(
		segment => segment.kind === previousFinalMarker.kind && segment.index === previousFinalMarker.segmentIndex,
	);
	if (previousBoundaryPosition < 0) return { preserved: false, changed: true };
	const preserved = semanticSegmentsThrough(
		previous.request,
		current,
		previousBoundaryPosition,
		previousBoundaryPosition,
	);
	return { preserved, changed: !preserved };
}

function messageHistoryChangedBeforeCacheBoundary(
	previous: PromptCacheDiagnosticRecord,
	current: PromptCacheDiagnosticRequest,
	divergenceIndex: number | null,
): boolean {
	if (divergenceIndex === null) return false;
	const previousFinalMarker = previous.request.markers.filter(marker => marker.kind === "message").at(-1);
	const currentFinalMarker = current.markers.filter(marker => marker.kind === "message").at(-1);
	if (previousFinalMarker === undefined || currentFinalMarker === undefined) return false;
	return divergenceIndex < Math.min(previousFinalMarker.segmentIndex, currentFinalMarker.segmentIndex);
}

function mutationFor(
	previous: PromptCacheDiagnosticRecord,
	current: PromptCacheDiagnosticRequest,
	cache: PromptCacheDiagnosticCache,
	context: Omit<PromptCacheDiagnosticContext, "mutation">,
): PromptCacheMutation {
	const generation = changedGenerationState(previous, context);
	const compactionTransition = context.compaction === "present" && previous.context.compaction !== "present";
	if (compactionTransition || generation.compaction || generation.branch || generation.prune) return "compaction";
	if (breakpointMovementObserved(previous.request, current)) return "breakpoint-movement";
	if (context.messageLogDivergenceIndex !== null) return "message-rewrite";
	if (
		previous.request.stablePrefixDigest !== null &&
		current.stablePrefixDigest !== null &&
		previous.request.stablePrefixDigest !== current.stablePrefixDigest
	) {
		return "system-mutation";
	}
	if (previous.cache.retention !== cache.retention || previous.cache.ttlMs !== cache.ttlMs) return "unknown";
	if (semanticPrefixEqual(previous.request, current)) return "append";
	return "unknown";
}

function classifyReset(
	previous: PromptCacheDiagnosticRecord | null,
	currentUsage: PromptCacheDiagnosticUsage,
	current: PromptCacheDiagnosticRequest,
	cache: PromptCacheDiagnosticCache,
	context: PromptCacheDiagnosticContext,
	startedMs: number,
	currentSequence: number,
	providerCause: PromptCacheResetCause | null,
): PromptCacheDiagnosticReset {
	if (!previous || previous.outcome !== "success") {
		return { cause: null, observed: false, rewriteTokens: null, previousSequence: null, relevantSequences: [] };
	}
	const previousRead = previous.usage.cacheRead;
	const currentRead = currentUsage.cacheRead;
	const rewriteTokens =
		current.tokenEstimate !== null && current.previousLcpTokens !== null
			? Math.max(0, current.tokenEstimate - current.previousLcpTokens)
			: null;
	const affinityChanged = previous.cache.affinityDigest !== cache.affinityDigest;
	const retentionChanged =
		previous.cache.retention !== null && cache.retention !== null && previous.cache.retention !== cache.retention;
	const ttlChanged = previous.cache.ttlMs !== null && cache.ttlMs !== null && previous.cache.ttlMs !== cache.ttlMs;
	const prefixChanged =
		previous.request.stablePrefixDigest !== null &&
		current.stablePrefixDigest !== null &&
		previous.request.stablePrefixDigest !== current.stablePrefixDigest;
	const generation = changedGenerationState(previous, context);
	const cacheablePrefix = cacheablePrefixState(previous, current);
	const ttlEligible =
		cacheablePrefix.preserved &&
		previous.cache.affinityDigest === cache.affinityDigest &&
		headMarkersEqual(previous.cache.markers, cache.markers) &&
		cache.ttlMs !== null;
	let ttlExpired = false;
	if (ttlEligible) {
		const previousStartedMs = Date.parse(previous.startedAt);
		ttlExpired = Number.isFinite(previousStartedMs) && startedMs - previousStartedMs > cache.ttlMs!;
	}
	const lowerRead = previousRead !== null && currentRead !== null && currentRead < previousRead;
	const equalZeroReadTtlWrite =
		previousRead === 0 &&
		currentRead === 0 &&
		currentUsage.cacheWrite !== null &&
		currentUsage.cacheWrite > 0 &&
		ttlExpired;
	if (!lowerRead && !equalZeroReadTtlWrite) {
		return {
			cause: null,
			observed: false,
			rewriteTokens: null,
			previousSequence: previous.sequence,
			relevantSequences: [previous.sequence, currentSequence],
		};
	}
	const compactionTransition = context.compaction === "present" && previous.context.compaction !== "present";
	const historyBeforeCacheBoundary =
		!cacheablePrefix.preserved &&
		messageHistoryChangedBeforeCacheBoundary(previous, current, context.messageLogDivergenceIndex);
	let cause: PromptCacheResetCause = "unknown";
	if (affinityChanged) cause = "cache-key-change";
	else if (retentionChanged || ttlChanged) cause = "retention-change";
	else if (breakpointMovementObserved(previous.request, current)) cause = "breakpoint-movement";
	else if (compactionTransition || generation.compaction || generation.branch) cause = "compaction-branch-replay";
	else if (prefixChanged) cause = "prefix-mutation";
	else if (generation.prune || historyBeforeCacheBoundary) cause = "message-rewrite-prune";
	else if (cacheablePrefix.changed) cause = "prefix-mutation";
	else if (ttlExpired) cause = "ttl-expiry";
	else if (providerCause !== null) cause = providerCause;
	return {
		cause,
		observed: true,
		rewriteTokens,
		previousSequence: previous.sequence,
		relevantSequences: [previous.sequence, currentSequence],
	};
}

function normalizeUsage(usage: PromptCacheDiagnosticUsage): PromptCacheDiagnosticUsage {
	return {
		input: finiteNonNegative(usage.input),
		cacheRead: finiteNonNegative(usage.cacheRead),
		cacheWrite: finiteNonNegative(usage.cacheWrite),
		output: finiteNonNegative(usage.output),
	};
}

function inferTtlMs(
	info: PromptCacheDiagnosticRequestInfo,
	markers: readonly PromptCacheDiagnosticMarker[],
): number | null {
	if (info.ttlMs !== undefined) return info.ttlMs === null ? null : finiteNonNegative(info.ttlMs);
	if (markers.some(marker => marker.ttl === "1h")) return LONG_TTL_MS;
	return markers.length > 0 ? DEFAULT_TTL_MS : null;
}

function inferRetention(
	info: PromptCacheDiagnosticRequestInfo,
	markers: readonly PromptCacheDiagnosticMarker[],
): string | null {
	if (info.retention !== undefined) return safeRetention(info.retention);
	if (markers.some(marker => marker.ttl === "1h")) return "long";
	return markers.length > 0 ? "short" : null;
}

function cloneRecord(record: PromptCacheDiagnosticRecord): PromptCacheDiagnosticRecord {
	return structuredClone(record);
}

function promptCacheBaselineKey(
	scopeDigest: string | null,
	provider: string,
	model: string,
	api: string,
	endpoint: string,
): string | null {
	return scopeDigest === null ? null : JSON.stringify([scopeDigest, provider, model, api, endpoint]);
}

export interface PromptCacheDiagnosticAttempt {
	readonly sequence: number;
	readonly request: PromptCacheDiagnosticRequest;
	observeResponse(response: PromptCacheDiagnosticResponse): void;
	complete(usage: PromptCacheDiagnosticUsage, providerCause?: PromptCacheResetCause | null): void;
	fail(failure?: PromptCacheDiagnosticFailure | null): void;
}

export class PromptCacheDebugJournal {
	readonly #key: HmacKey = nodeCrypto.randomBytes(32);
	readonly #maxRecords: number;
	readonly #maxBytes: number;
	readonly #filePath: string | undefined;
	readonly #now: () => number;
	#records: PromptCacheDiagnosticRecord[] = [];
	#baselines = new Map<string, PromptCacheDiagnosticRecord>();
	#recordBytes = 0;
	#droppedRecords = 0;
	#droppedBytes = 0;
	#nextSequence = 1;
	#writeChain: Promise<void> = Promise.resolve();
	#fileInitialized = false;
	#persistedThroughSequence = 0;
	#persistenceFailureLogged = false;

	constructor(options: PromptCacheDebugJournalOptions = {}) {
		this.#maxRecords = positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS);
		this.#maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
		this.#filePath = options.filePath;
		this.#now = options.now ?? Date.now;
	}

	get records(): readonly PromptCacheDiagnosticRecord[] {
		return this.#records;
	}

	get droppedRecords(): number {
		return this.#droppedRecords;
	}

	begin(info: PromptCacheDiagnosticRequestInfo): PromptCacheDiagnosticAttempt {
		const bodySource: PromptCacheDiagnosticBodySource = info.bodySource === "prepared" ? "prepared" : "wire";
		const startedMs = this.#now();
		const body = bytesForBody(info.body);
		const analysis = analyzeBody(body, this.#key);
		const currentRequest: PromptCacheDiagnosticRequest = {
			digest: body === null ? null : digestBytes(this.#key, body),
			bytes: body?.byteLength ?? null,
			tokenEstimate: estimateTokens(body?.byteLength ?? null),
			stablePrefixDigest: analysis.stablePrefixDigest,
			stablePrefixBytes: analysis.stablePrefixBytes,
			stablePrefixTokenEstimate: analysis.stablePrefixTokenEstimate,
			cachePrefixDigests: analysis.cachePrefixDigests,
			segments: analysis.segments,
			segmentCount: analysis.segments.length,
			omittedSegmentCount: 0,
			firstSegmentDigest: analysis.segments[0]?.digest ?? null,
			lastSegmentDigest: analysis.segments.at(-1)?.digest ?? null,
			markers: analysis.markers,
			previousLcpTokens: null,
			firstDivergentSegmentDigest: null,
		};
		const scopeDigest =
			typeof info.sessionScope === "string" && info.sessionScope.length > 0
				? digest(this.#key, info.sessionScope)
				: null;
		const endpointIdentity = safeEndpointIdentity(info.endpoint, this.#key);
		const baseline = promptCacheBaselineKey(scopeDigest, info.provider, info.model, info.api, endpointIdentity);
		const previous = baseline === null ? null : (this.#baselines.get(baseline) ?? null);
		let messageLogDivergenceIndex: number | null = null;
		if (previous) {
			const lcp = segmentLcp(previous.request, currentRequest);
			currentRequest.previousLcpTokens = lcp.tokens;
			currentRequest.firstDivergentSegmentDigest = lcp.firstDivergentSegmentDigest;
			messageLogDivergenceIndex = semanticMessageDivergenceIndex(previous.request, currentRequest);
		}
		const suppliedContext = info.context;
		const cache: PromptCacheDiagnosticCache = {
			scopeDigest,
			affinityDigest:
				typeof info.cacheAffinity === "string" && info.cacheAffinity.length > 0
					? digest(this.#key, info.cacheAffinity)
					: null,
			retention: inferRetention(info, analysis.markers),
			ttlMs: inferTtlMs(info, analysis.markers),
			markers: analysis.markers,
		};
		const contextWithoutMutation: Omit<PromptCacheDiagnosticContext, "mutation"> = {
			nonMessageTokens:
				suppliedContext?.nonMessageTokens !== undefined
					? finiteNonNegative(suppliedContext.nonMessageTokens)
					: analysis.nonMessageTokens,
			messageLogDivergenceIndex:
				suppliedContext?.messageLogDivergenceIndex !== undefined
					? finiteInteger(suppliedContext.messageLogDivergenceIndex)
					: messageLogDivergenceIndex,
			compaction: analysis.compaction,
			branchStateDigest: branchStateDigest(this.#key, suppliedContext?.branchState),
			compactionStateDigest: compactionStateDigest(this.#key, suppliedContext?.compactionState),
			pruneStateDigest: pruneStateDigest(this.#key, suppliedContext?.pruneState),
		};
		const inferredMutation = previous
			? mutationFor(previous, currentRequest, cache, contextWithoutMutation)
			: "unknown";
		const context: PromptCacheDiagnosticContext = {
			...contextWithoutMutation,
			mutation: suppliedContext?.mutation ?? inferredMutation,
		};
		const sequence = this.#nextSequence++;
		let status: number | null = null;
		let requestId: string | null = null;
		let done = false;
		const finish = (
			outcome: PromptCacheRequestOutcome,
			usage: PromptCacheDiagnosticUsage,
			failure: PromptCacheDiagnosticFailure | null,
			providerCause: PromptCacheResetCause | null,
		): void => {
			if (done) return;
			done = true;
			const completedMs = this.#now();
			const normalizedUsage = normalizeUsage(usage);
			const reset = classifyReset(
				previous,
				normalizedUsage,
				currentRequest,
				cache,
				context,
				startedMs,
				sequence,
				providerCause,
			);
			const record: PromptCacheDiagnosticRecord = {
				version: JOURNAL_VERSION,
				kind: "prompt-cache",
				sequence,
				startedAt: new Date(startedMs).toISOString(),
				completedAt: new Date(completedMs).toISOString(),
				durationMs: Math.max(0, completedMs - startedMs),
				outcome,
				provider: info.provider,
				model: info.model,
				api: info.api,
				bodySource,
				endpoint: endpointIdentity,
				status: failure?.status ?? status,
				requestId,
				errorCode: sanitizedErrorCode(failure?.code),
				cache,
				request: currentRequest,
				context,
				usage: normalizedUsage,
				reset,
			};
			if (outcome === "success" && baseline !== null) {
				this.#baselines.delete(baseline);
				while (this.#baselines.size >= MAX_BASELINE_COUNT) {
					const oldest = this.#baselines.keys().next().value;
					if (oldest === undefined) break;
					this.#baselines.delete(oldest);
				}
				this.#baselines.set(baseline, {
					...record,
					request: { ...record.request, segments: [...record.request.segments] },
				});
			}
			this.#append(record);
		};
		return {
			sequence,
			request: currentRequest,
			observeResponse: (response: PromptCacheDiagnosticResponse): void => {
				status = Number.isInteger(response.status) && response.status >= 0 ? response.status : null;
				requestId = safeRequestId(response.requestId);
				if (response.status < 200 || response.status >= 300) {
					finish(
						"error",
						{ input: null, cacheRead: null, cacheWrite: null, output: null },
						{ status, code: `http-${response.status}` },
						null,
					);
				}
			},
			complete: (usage: PromptCacheDiagnosticUsage, providerCause: PromptCacheResetCause | null = null): void => {
				finish("success", usage, null, providerCause);
			},
			fail: (failure: PromptCacheDiagnosticFailure | null = null): void => {
				finish("error", { input: null, cacheRead: null, cacheWrite: null, output: null }, failure, null);
			},
		};
	}

	snapshot(): PromptCacheDebugSnapshot {
		return {
			enabled: true,
			records: this.#records.map(cloneRecord),
			droppedRecords: this.#droppedRecords,
			droppedBytes: this.#droppedBytes,
			maxRecords: this.#maxRecords,
			maxBytes: this.#maxBytes,
		};
	}

	toJSONL(): string {
		if (this.#records.length === 0) return "";
		return `${this.#records.map(record => JSON.stringify(record)).join("\n")}\n`;
	}

	#compactOldestDetailedRecord(): boolean {
		const candidate = this.#records.find(
			record => record.request.segments.length > 0 && record.request.omittedSegmentCount === 0,
		);
		if (candidate === undefined) return false;
		const beforeBytes = utf8Bytes(JSON.stringify(candidate)) + 1;
		const segmentCount = candidate.request.segmentCount;
		candidate.request = {
			...candidate.request,
			segments: [],
			omittedSegmentCount: segmentCount,
		};
		const afterBytes = utf8Bytes(JSON.stringify(candidate)) + 1;
		this.#recordBytes += afterBytes - beforeBytes;
		return true;
	}

	#append(record: PromptCacheDiagnosticRecord): void {
		const serialized = JSON.stringify(record);
		const bytes = utf8Bytes(serialized) + 1;
		if (bytes > this.#maxBytes) {
			this.#droppedRecords++;
			this.#droppedBytes += bytes;
			return;
		}
		let requiresRewrite = false;
		while (this.#records.length >= this.#maxRecords || this.#recordBytes + bytes > this.#maxBytes) {
			if (this.#records.length < this.#maxRecords && this.#compactOldestDetailedRecord()) {
				requiresRewrite = true;
				continue;
			}
			const removed = this.#records.shift();
			if (removed === undefined) break;
			const removedBytes = utf8Bytes(JSON.stringify(removed)) + 1;
			this.#recordBytes -= removedBytes;
			this.#droppedRecords++;
			this.#droppedBytes += removedBytes;
			requiresRewrite = true;
		}
		this.#records.push(record);
		this.#recordBytes += bytes;
		if (!this.#filePath) return;
		this.#writeChain = this.#writeChain
			.then(() => this.#persist(serialized, requiresRewrite, record.sequence))
			.catch(error => {
				this.#fileInitialized = false;
				this.#persistedThroughSequence = 0;
				if (this.#persistenceFailureLogged) return;
				this.#persistenceFailureLogged = true;
				logger.warn("prompt-cache diagnostic journal persistence failed", {
					error: error instanceof Error ? error.name : "unknown",
				});
			});
	}

	async flush(): Promise<void> {
		await this.#writeChain;
	}

	async #persist(serialized: string, rewrite: boolean, sequence: number): Promise<void> {
		if (!this.#filePath) return;
		const outOfOrder = sequence <= this.#persistedThroughSequence;
		if (rewrite || outOfOrder || !this.#fileInitialized) {
			await Bun.write(this.#filePath, this.toJSONL());
			this.#fileInitialized = true;
			let highestSequence = 0;
			for (const retained of this.#records) {
				if (retained.sequence > highestSequence) highestSequence = retained.sequence;
			}
			this.#persistedThroughSequence = highestSequence;
			return;
		}
		await fs.appendFile(this.#filePath, `${serialized}\n`);
		this.#persistedThroughSequence = Math.max(this.#persistedThroughSequence, sequence);
	}
}

export interface PromptCacheDiagnosticControllerOptions {
	journal?: PromptCacheDebugJournal;
	provider: string;
	model: string;
	api: string;
	endpoint: string;
	baseFetch?: FetchImpl;
	cacheAffinity?: string | null;
	sessionScope?: string | null;
	retention?: string | null;
	ttlMs?: number | null;
	context?: PromptCacheDiagnosticContextInput;
}

interface PromptCacheDiagnosticBeginInfo {
	body: PromptCacheDiagnosticRequestInfo["body"];
	bodySource?: PromptCacheDiagnosticBodySource;
	endpoint?: string;
}

export interface PromptCacheDiagnosticController {
	readonly fetch: FetchImpl;
	readonly enabled: true;
	complete(usage: PromptCacheDiagnosticUsage, providerCause?: PromptCacheResetCause | null): void;
	fail(failure?: PromptCacheDiagnosticFailure | null): void;
	begin(info: PromptCacheDiagnosticBeginInfo): PromptCacheDiagnosticAttempt;
}

function bodyInitBytes(body: RequestInit["body"] | undefined): string | Uint8Array | ArrayBuffer | null {
	if (body === null || body === undefined) return null;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return body;
	if (body instanceof URLSearchParams) return body.toString();
	return null;
}

async function requestBody(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<string | Uint8Array | ArrayBuffer | null> {
	const initBody = bodyInitBytes(init?.body);
	if (initBody !== null) return initBody;
	if (!(input instanceof Request) || init?.body !== undefined) return null;
	try {
		return new Uint8Array(await input.clone().arrayBuffer());
	} catch {
		return null;
	}
}

export function isPromptCacheDebugEnabled(): boolean {
	return Bun.env[PROMPT_CACHE_DEBUG_ENV] === "1";
}

export function createPromptCacheDiagnosticController(
	options: PromptCacheDiagnosticControllerOptions,
): PromptCacheDiagnosticController | undefined {
	if (!isPromptCacheDebugEnabled()) return undefined;
	const journal = options.journal ?? getPromptCacheDebugJournal();
	if (!journal) return undefined;
	const baseFetch = options.baseFetch ?? (globalThis.fetch as FetchImpl);
	let current: PromptCacheDiagnosticAttempt | null = null;
	const begin = (info: PromptCacheDiagnosticBeginInfo): PromptCacheDiagnosticAttempt => {
		current?.fail({ code: "superseded" });
		current = journal.begin({
			body: info.body,
			bodySource: info.bodySource ?? "wire",
			provider: options.provider,
			model: options.model,
			api: options.api,
			endpoint: info.endpoint ?? options.endpoint,
			cacheAffinity: options.cacheAffinity,
			sessionScope: options.sessionScope,
			retention: options.retention,
			ttlMs: options.ttlMs,
			context: options.context,
		});
		return current;
	};
	const diagnosticFetch: FetchImpl = async (input, init) => {
		const body = await requestBody(input, init);
		const endpoint = input instanceof Request ? input.url : String(input);
		const attempt = begin({ body, bodySource: "wire", endpoint });
		try {
			const response = await baseFetch(input, init);
			attempt.observeResponse({ status: response.status, requestId: response.headers.get("request-id") });
			return response;
		} catch (error) {
			attempt.fail({ code: error instanceof Error ? error.name : "fetch-error" });
			throw error;
		}
	};
	return {
		fetch: diagnosticFetch,
		enabled: true,
		begin,
		complete: (usage, providerCause = null): void => {
			current?.complete(usage, providerCause);
			current = null;
		},
		fail: (failure = null): void => {
			current?.fail(failure);
			current = null;
		},
	};
}

const pruneStalePromptCacheFiles = async (directory: string, currentPath: string, now: number): Promise<void> => {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const staleBefore = now - STALE_JOURNAL_MAX_AGE_MS;
		await Promise.all(
			entries.map(async entry => {
				if (!entry.isFile() || !entry.name.startsWith("prompt-cache-debug-") || !entry.name.endsWith(".jsonl")) {
					return;
				}
				const candidate = path.join(directory, entry.name);
				if (candidate === currentPath) return;
				try {
					const stats = await fs.stat(candidate);
					if (stats.mtimeMs > staleBefore) return;
					await fs.rm(candidate);
				} catch {
					// Best-effort cleanup: the journal must still initialize when the
					// reports directory is unavailable or a file races with pruning.
				}
			}),
		);
	} catch {
		return;
	}
};

let stalePruneStarted = false;

let globalJournal: PromptCacheDebugJournal | undefined;

export function getPromptCacheDebugJournal(): PromptCacheDebugJournal | undefined {
	if (!isPromptCacheDebugEnabled()) return undefined;
	if (!globalJournal) {
		const reportsDir = getReportsDir();
		const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
		const filePath = path.join(reportsDir, `prompt-cache-debug-${startedAt}-${process.pid}.jsonl`);
		globalJournal = new PromptCacheDebugJournal({ filePath });
		if (!stalePruneStarted) {
			stalePruneStarted = true;
			void pruneStalePromptCacheFiles(reportsDir, filePath, Date.now());
		}
	}
	return globalJournal;
}

export function getPromptCacheDebugSnapshot(): PromptCacheDebugSnapshot | undefined {
	return getPromptCacheDebugJournal()?.snapshot();
}

export function getPromptCacheDebugView(now = Date.now()): PromptCacheDebugView {
	const journal = getPromptCacheDebugJournal();
	if (!journal) {
		return {
			enabled: false,
			recordCount: 0,
			droppedRecords: 0,
			resetCount: 0,
			largestRewriteTokens: null,
			currentStablePrefixDigest: null,
			ageSinceLastCacheTouchMs: null,
			classification: null,
			relevantSequences: [],
		};
	}
	const records = journal.records;
	const resets = records.filter(record => record.reset.observed);
	const touched = records.filter(
		record =>
			record.outcome === "success" && ((record.usage.cacheRead ?? 0) > 0 || (record.usage.cacheWrite ?? 0) > 0),
	);
	const lastTouch = touched.at(-1);
	const lastTouchCompletedMs = lastTouch ? Date.parse(lastTouch.completedAt) : Number.NaN;
	const lastReset = resets.at(-1);
	const rewriteValues = resets
		.map(record => record.reset.rewriteTokens)
		.filter((value): value is number => value !== null);
	return {
		enabled: true,
		recordCount: records.length,
		droppedRecords: journal.droppedRecords,
		resetCount: resets.length,
		largestRewriteTokens: rewriteValues.length > 0 ? Math.max(...rewriteValues) : null,
		currentStablePrefixDigest: records.at(-1)?.request.stablePrefixDigest ?? null,
		ageSinceLastCacheTouchMs: Number.isFinite(lastTouchCompletedMs) ? Math.max(0, now - lastTouchCompletedMs) : null,
		classification: lastReset?.reset.cause ?? null,
		relevantSequences: lastReset?.reset.relevantSequences ?? [],
	};
}

export function formatPromptCacheDebugView(view = getPromptCacheDebugView()): string[] {
	if (!view.enabled) return ["Prompt-cache diagnostics: disabled (set PI_PROMPT_CACHE_DEBUG=1 before starting omp)."];
	return [
		`Prompt-cache diagnostics: ${view.recordCount} records (${view.droppedRecords} dropped)`,
		`Resets: ${view.resetCount}; largest rewrite: ${view.largestRewriteTokens === null ? "unknown" : `${view.largestRewriteTokens} estimated tokens`}`,
		`Stable-prefix digest: ${view.currentStablePrefixDigest ?? "none"}`,
		`Age since cache touch: ${view.ageSinceLastCacheTouchMs === null ? "unknown" : `${view.ageSinceLastCacheTouchMs} ms`}`,
		`Last classification: ${view.classification ?? "none"}`,
		`Relevant request sequences: ${view.relevantSequences.length > 0 ? view.relevantSequences.join(", ") : "none"}`,
	];
}
