import * as nodeCrypto from "node:crypto";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "../utils";

export const PROMPT_CACHE_DEBUG_ENV = "PI_PROMPT_CACHE_DEBUG";
export const PROMPT_CACHE_DEBUG_FILE = "prompt-cache-debug.jsonl";

const JOURNAL_VERSION = 1;
const DEFAULT_MAX_RECORDS = 256;
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
	digest: string | null;
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

/** Context facts a caller can supply when they are not represented on the wire. */
export interface PromptCacheDiagnosticContextInput {
	nonMessageTokens?: number | null;
	messageLogDivergenceIndex?: number | null;
	compaction?: boolean | null;
	branch?: boolean | null;
	prune?: boolean | null;
	mutation?: PromptCacheMutation | null;
}

/** Provider-neutral request context derived from the final wire payload. */
export interface PromptCacheDiagnosticContext {
	/** Number of serialized system/tool tokens, excluding message segments. */
	nonMessageTokens: number | null;
	/** Index of the first message that diverged from the previous request. */
	messageLogDivergenceIndex: number | null;
	/** True when the wire request carries an Anthropic compaction operation. */
	compaction: boolean | null;
	/** Branch state is null unless a caller/provider supplies it. */
	branch: boolean | null;
	/** Prune state is null unless a caller/provider supplies it. */
	prune: boolean | null;
	mutation: PromptCacheMutation;
}

export interface PromptCacheDiagnosticRequestInfo {
	/** The final serialized request body, or null when no body was available. */
	body: string | Uint8Array | ArrayBuffer | null;
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
	/** Exact UTF-8 bytes of the serialized provider request body. */
	bytes: number | null;
	/** Explicitly heuristic serialized-byte token estimate. */
	tokenEstimate: number | null;
	stablePrefixDigest: string | null;
	stablePrefixBytes: number | null;
	stablePrefixTokenEstimate: number | null;
	segments: PromptCacheDiagnosticSegment[];
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
function estimateTokens(bytes: number | null): number | null {
	if (bytes === null) return null;
	if (bytes === 0) return 0;
	return Math.ceil(bytes / 4);
}

function markerTtl(value: unknown): "5m" | "1h" | null {
	if (!isRecord(value)) return null;
	return value.ttl === "1h" ? "1h" : value.ttl === "5m" ? "5m" : null;
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
	try {
		const value: unknown = JSON.parse(text.slice(span.start, span.end));
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
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

function parseBody(body: Uint8Array): { text: string; root: JsonSpan; parsed: Record<string, unknown> } | null {
	const text = TEXT_DECODER.decode(body);
	const root = parseJsonSpan(text, 0);
	if (root === null || text[root.start] !== "{") return null;
	try {
		const parsed: unknown = JSON.parse(text.slice(root.start, root.end));
		return isRecord(parsed) ? { text, root, parsed } : null;
	} catch {
		return null;
	}
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
	compaction: boolean | null;
}

const SEGMENT_FIELDS: ReadonlyArray<readonly [string, PromptCacheSegmentKind]> = [
	["tools", "tool"],
	["system", "system"],
	["messages", "message"],
];

function bodyHasCompaction(value: unknown): boolean {
	if (!isRecord(value) || !Array.isArray(value.messages)) return false;
	for (const message of value.messages) {
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		if (
			message.content.some(
				block => isRecord(block) && (block.type === "compaction" || block.type === "compaction_summary"),
			)
		) {
			return true;
		}
	}
	return false;
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
			compaction: null,
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
			compaction: null,
		};
	}

	const { text, root, parsed } = parsedBody;
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
		raw: Uint8Array;
		markers: MarkerSpan[];
	}
	const analyzedSegments: AnalyzedSegment[] = [];
	const segments: PromptCacheDiagnosticSegment[] = [];
	const markers: PromptCacheDiagnosticMarker[] = [];
	let nonMessageBytes = 0;
	for (const segment of values) {
		const raw = TEXT_ENCODER.encode(text.slice(segment.span.start, segment.span.end));
		const segmentRecord: PromptCacheDiagnosticSegment = {
			kind: segment.kind,
			index: segment.index,
			bytes: raw.byteLength,
			tokenEstimate: estimateTokens(raw.byteLength),
			digest: digestBytes(key, raw),
		};
		segments.push(segmentRecord);
		if (segment.kind !== "message") nonMessageBytes += raw.byteLength;
		const markerSpans: MarkerSpan[] = [];
		collectMarkerSpans(text, segment.span, segment.kind, markerSpans);
		analyzedSegments.push({ value: segment, raw, markers: markerSpans });
		for (let ordinal = 0; ordinal < markerSpans.length; ordinal++) {
			const marker = markerSpans[ordinal]!;
			let ttl: "5m" | "1h" | null = null;
			try {
				ttl = markerTtl(JSON.parse(text.slice(marker.value.start, marker.value.end)));
			} catch {
				ttl = null;
			}
			markers.push({
				kind: segment.kind,
				segmentIndex: segment.index,
				ordinal,
				location: marker.location,
				type: marker.type,
				byteOffset: utf8Bytes(text.slice(0, marker.keyStart)),
				ttl,
			});
		}
	}
	// Anthropic's JSON field order is not its cache-prefix order; keep message
	// segments after the stable head when selecting the semantic final marker.
	let lastMarkerSegmentPosition = -1;
	let lastMarker: MarkerSpan | undefined;
	for (let position = 0; position < analyzedSegments.length; position++) {
		const marker = analyzedSegments[position]!.markers.at(-1);
		if (marker !== undefined) {
			lastMarkerSegmentPosition = position;
			lastMarker = marker;
		}
	}
	const stablePrefixHmac = lastMarker === undefined ? null : nodeCrypto.createHmac("sha256", key);
	let stablePrefixBytes = 0;
	let stablePrefixDigest: string | null = null;
	if (lastMarker !== undefined && stablePrefixHmac !== null) {
		for (let position = 0; position < analyzedSegments.length; position++) {
			const analyzed = analyzedSegments[position]!;
			let prefix: Uint8Array | null = null;
			if (position < lastMarkerSegmentPosition) {
				prefix = analyzed.raw;
			} else if (position === lastMarkerSegmentPosition) {
				prefix = TEXT_ENCODER.encode(text.slice(analyzed.value.span.start, lastMarker.containerEnd));
			}
			if (prefix === null) break;
			stablePrefixBytes += prefix.byteLength;
			stablePrefixHmac.update(TEXT_ENCODER.encode(`${analyzed.value.kind}:${analyzed.value.index}\u0000`));
			stablePrefixHmac.update(prefix);
			if (position === lastMarkerSegmentPosition) break;
		}
		stablePrefixDigest = stablePrefixHmac.digest("hex").slice(0, MAX_DIGEST_LENGTH);
	}
	return {
		segments,
		markers,
		stablePrefixBytes: stablePrefixDigest === null ? null : stablePrefixBytes,
		stablePrefixTokenEstimate: stablePrefixDigest === null ? null : estimateTokens(stablePrefixBytes),
		stablePrefixDigest,
		nonMessageTokens: estimateTokens(nonMessageBytes),
		compaction: bodyHasCompaction(parsed),
	};
}

function segmentsEqual(left: PromptCacheDiagnosticSegment, right: PromptCacheDiagnosticSegment): boolean {
	return (
		left.kind === right.kind && left.index === right.index && left.digest !== null && left.digest === right.digest
	);
}

function segmentLcp(
	previous: PromptCacheDiagnosticRequest,
	current: PromptCacheDiagnosticRequest,
): { tokens: number | null; firstDivergentSegmentDigest: string | null; messageDivergenceIndex: number | null } {
	if (previous.digest === null || current.digest === null) {
		return { tokens: null, firstDivergentSegmentDigest: null, messageDivergenceIndex: null };
	}
	let tokens = 0;
	let firstDivergentSegmentDigest: string | null = null;
	let messageDivergenceIndex: number | null = null;
	const sharedLength = Math.min(previous.segments.length, current.segments.length);
	for (let index = 0; index < sharedLength; index++) {
		const previousSegment = previous.segments[index]!;
		const currentSegment = current.segments[index]!;
		if (segmentsEqual(previousSegment, currentSegment)) {
			tokens += currentSegment.tokenEstimate ?? 0;
			continue;
		}
		firstDivergentSegmentDigest = currentSegment.digest;
		if (currentSegment.kind === "message") messageDivergenceIndex = currentSegment.index;
		else if (previousSegment.kind === "message") messageDivergenceIndex = previousSegment.index;
		return { tokens, firstDivergentSegmentDigest, messageDivergenceIndex };
	}
	if (current.segments.length > previous.segments.length) {
		firstDivergentSegmentDigest = current.segments[sharedLength]?.digest ?? null;
	}
	if (current.segments.length < previous.segments.length) {
		const previousSegment = previous.segments[current.segments.length];
		if (previousSegment?.kind === "message") messageDivergenceIndex = previousSegment.index;
	}
	return { tokens, firstDivergentSegmentDigest, messageDivergenceIndex };
}

function markersEqual(
	left: readonly PromptCacheDiagnosticMarker[],
	right: readonly PromptCacheDiagnosticMarker[],
): boolean {
	if (left.length !== right.length) return false;
	return left.every((marker, index) => {
		const other = right[index]!;
		return (
			marker.kind === other.kind &&
			marker.segmentIndex === other.segmentIndex &&
			marker.ordinal === other.ordinal &&
			marker.location.length === other.location.length &&
			marker.location.every((value, pathIndex) => value === other.location[pathIndex]) &&
			marker.type === other.type &&
			marker.ttl === other.ttl
		);
	});
}

function mutationFor(
	previous: PromptCacheDiagnosticRequest,
	current: PromptCacheDiagnosticRequest,
	context: Omit<PromptCacheDiagnosticContext, "mutation">,
): PromptCacheMutation {
	if (!markersEqual(previous.markers, current.markers)) return "breakpoint-movement";
	if (context.compaction === true || context.branch === true || context.prune === true) return "compaction";
	if (context.messageLogDivergenceIndex !== null) return "message-rewrite";
	if (
		previous.stablePrefixDigest !== null &&
		current.stablePrefixDigest !== null &&
		previous.stablePrefixDigest !== current.stablePrefixDigest
	) {
		return "system-mutation";
	}
	if (
		current.segments.length >= previous.segments.length &&
		previous.segments.every((segment, index) => {
			const currentSegment = current.segments[index];
			return currentSegment !== undefined && segmentsEqual(segment, currentSegment);
		})
	) {
		return "append";
	}
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
	if (previousRead === null || currentRead === null || currentRead >= previousRead) {
		return {
			cause: null,
			observed: false,
			rewriteTokens: null,
			previousSequence: previous.sequence,
			relevantSequences: [previous.sequence, currentSequence],
		};
	}
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
	const historyChanged = context.messageLogDivergenceIndex !== null || context.mutation === "message-rewrite";
	let cause: PromptCacheResetCause = "unknown";
	const ttlEligible =
		previous.request.stablePrefixDigest !== null &&
		previous.request.stablePrefixDigest === current.stablePrefixDigest &&
		previous.cache.affinityDigest === cache.affinityDigest &&
		markersEqual(previous.cache.markers, cache.markers) &&
		cache.ttlMs !== null;
	let ttlExpired = false;
	if (ttlEligible) {
		const previousCompletedMs = Date.parse(previous.completedAt);
		ttlExpired = Number.isFinite(previousCompletedMs) && startedMs - previousCompletedMs > cache.ttlMs!;
	}
	if (affinityChanged) cause = "cache-key-change";
	else if (retentionChanged || ttlChanged) cause = "retention-change";
	else if (!markersEqual(previous.cache.markers, cache.markers)) cause = "breakpoint-movement";
	else if (context.compaction === true || context.branch === true) cause = "compaction-branch-replay";
	else if (context.prune === true || historyChanged) cause = "message-rewrite-prune";
	else if (prefixChanged) cause = "prefix-mutation";
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
	#recordBytes = 0;
	#droppedRecords = 0;
	#droppedBytes = 0;
	#nextSequence = 1;
	#writeChain: Promise<void> = Promise.resolve();

	constructor(options: PromptCacheDebugJournalOptions = {}) {
		this.#maxRecords = positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS);
		this.#maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
		this.#filePath = options.filePath;
		this.#now = options.now ?? Date.now;
	}

	get maxRecords(): number {
		return this.#maxRecords;
	}

	get maxBytes(): number {
		return this.#maxBytes;
	}

	get records(): readonly PromptCacheDiagnosticRecord[] {
		return this.#records;
	}

	get droppedRecords(): number {
		return this.#droppedRecords;
	}

	begin(info: PromptCacheDiagnosticRequestInfo): PromptCacheDiagnosticAttempt {
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
			segments: analysis.segments,
			markers: analysis.markers,
			previousLcpTokens: null,
			firstDivergentSegmentDigest: null,
		};
		const scopeDigest =
			typeof info.sessionScope === "string" && info.sessionScope.length > 0
				? digest(this.#key, info.sessionScope)
				: null;
		const endpointIdentity = safeEndpointIdentity(info.endpoint, this.#key);
		const previous =
			scopeDigest === null
				? null
				: ([...this.#records]
						.reverse()
						.find(
							record =>
								record.outcome === "success" &&
								record.cache.scopeDigest === scopeDigest &&
								record.provider === info.provider &&
								record.model === info.model &&
								record.api === info.api &&
								record.endpoint === endpointIdentity,
						) ?? null);
		let messageLogDivergenceIndex: number | null = null;
		if (previous) {
			const lcp = segmentLcp(previous.request, currentRequest);
			currentRequest.previousLcpTokens = lcp.tokens;
			currentRequest.firstDivergentSegmentDigest = lcp.firstDivergentSegmentDigest;
			messageLogDivergenceIndex = lcp.messageDivergenceIndex;
		}
		const suppliedContext = info.context;
		const contextWithoutMutation: Omit<PromptCacheDiagnosticContext, "mutation"> = {
			nonMessageTokens:
				suppliedContext?.nonMessageTokens !== undefined
					? finiteNonNegative(suppliedContext.nonMessageTokens)
					: analysis.nonMessageTokens,
			messageLogDivergenceIndex:
				suppliedContext?.messageLogDivergenceIndex !== undefined
					? finiteInteger(suppliedContext.messageLogDivergenceIndex)
					: messageLogDivergenceIndex,
			compaction: suppliedContext?.compaction !== undefined ? suppliedContext.compaction : analysis.compaction,
			branch: suppliedContext?.branch !== undefined ? suppliedContext.branch : null,
			prune: suppliedContext?.prune !== undefined ? suppliedContext.prune : null,
		};
		const inferredMutation = previous
			? mutationFor(previous.request, currentRequest, contextWithoutMutation)
			: "unknown";
		const context: PromptCacheDiagnosticContext = {
			...contextWithoutMutation,
			mutation: suppliedContext?.mutation ?? inferredMutation,
		};
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

	clear(): void {
		this.#records = [];
		this.#recordBytes = 0;
		this.#droppedRecords = 0;
		this.#droppedBytes = 0;
		this.#nextSequence = 1;
		this.#writeChain = this.#writeChain.catch(() => {}).then(() => this.#persist());
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

	async flush(): Promise<void> {
		await this.#writeChain;
	}

	#append(record: PromptCacheDiagnosticRecord): void {
		const serialized = JSON.stringify(record);
		const bytes = utf8Bytes(serialized) + 1;
		if (bytes > this.#maxBytes) {
			this.#droppedRecords++;
			this.#droppedBytes += bytes;
			return;
		}
		while (this.#records.length >= this.#maxRecords || this.#recordBytes + bytes > this.#maxBytes) {
			const removed = this.#records.shift();
			if (removed === undefined) break;
			const removedBytes = utf8Bytes(JSON.stringify(removed)) + 1;
			this.#recordBytes -= removedBytes;
			this.#droppedRecords++;
			this.#droppedBytes += removedBytes;
		}
		this.#records.push(record);
		this.#recordBytes += bytes;
		this.#writeChain = this.#writeChain.catch(() => {}).then(() => this.#persist());
	}

	async #persist(): Promise<void> {
		if (!this.#filePath) return;
		await Bun.write(this.#filePath, this.toJSONL());
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
		const attempt = begin({ body, endpoint });
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

let globalJournal: PromptCacheDebugJournal | undefined;

export function getPromptCacheDebugJournal(): PromptCacheDebugJournal | undefined {
	if (!isPromptCacheDebugEnabled()) return undefined;
	if (!globalJournal) {
		globalJournal = new PromptCacheDebugJournal({ filePath: path.resolve(PROMPT_CACHE_DEBUG_FILE) });
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

export function resetPromptCacheDebugJournalForTesting(): void {
	globalJournal = undefined;
}

export function createPromptCacheDiagnosticRequestForTesting(
	journal: PromptCacheDebugJournal,
	info: PromptCacheDiagnosticRequestInfo,
): PromptCacheDiagnosticAttempt {
	return journal.begin(info);
}
