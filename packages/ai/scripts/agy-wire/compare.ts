#!/usr/bin/env bun
import { analyzeHttp2, type Http2Analysis } from "./http2";
import { parsePcap, reassembleTcpPayload, summarizeTcpClientFlows, type TcpPacket } from "./tcp";
import {
	extractClientHelloFromRecords,
	ja3,
	ja4,
	parseClientHello,
	type DynamicSpan,
	type ParsedClientHello,
} from "./tls";

export type ComparisonState = "match" | "mismatch" | "unavailable";
export interface ByteComparison {
	state: ComparisonState;
	reference: { length: number; sha256: string } | null;
	candidate: { length: number; sha256: string } | null;
	/** Byte offset only: differing bytes can contain credentials and are never printed. */
	firstDifference: number | null;
}
export interface ComparisonScope {
	state: ComparisonState | "not-applicable";
	required: boolean;
	reasons: string[];
	evidence?: unknown;
}
export interface RequestExclusion {
	requestIndex: number;
	field: "body" | "header";
	/** Header VALUE bytes only; names and ordered positions cannot be excluded. */
	headerIndex?: number;
	reference: DynamicSpan[];
	candidate: DynamicSpan[];
}
export interface ExclusionFile {
	schemaVersion: 1;
	requests: RequestExclusion[];
}
export interface CompareOptions {
	referencePcap?: Uint8Array;
	candidatePcap?: Uint8Array;
	port?: number;
	scope?: "all" | "application-tls";
	exclusions?: unknown;
}
export interface RequestComparison {
	index: number;
	method: ByteComparison;
	path: ByteComparison;
	orderedHeaders: ByteComparison;
	body: ByteComparison;
	headers: { index: number; name: ByteComparison; value: ByteComparison; normalized: ComparisonState }[];
	normalized: ComparisonState;
}
export interface ComparisonReport {
	schemaVersion: 1;
	attestation: "unverified";
	claim: "Only the explicitly required observable normalized scopes are evaluated; not full protocol or identity equivalence";
	raw: {
		clientHello: ByteComparison;
		tlsRecords: ByteComparison;
		http2Plaintext: ByteComparison;
		http1Plaintext: ByteComparison;
		requests: RequestComparison[];
		pcap: ByteComparison;
	};
	scopes: Record<string, ComparisonScope>;
	exclusions: RequestExclusion[];
	state: ComparisonState;
	exitCode: 0 | 1 | 2;
}
interface CapturedRequest {
	headers: [string, string][];
	body: Uint8Array;
	method: string;
	path: string;
	streamId?: number;
	version?: string;
}
interface Capture {
	records: Uint8Array | null;
	plaintext: Uint8Array | null;
	requests: CapturedRequest[] | null;
	alpn: unknown;
	connectAuthority?: string;
	issues: string[];
}
const encoder = new TextEncoder();
const unavailable = (required: boolean, ...reasons: string[]): ComparisonScope => ({
	state: "unavailable",
	required,
	reasons,
});
const equalObject = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const stateOf = (equal: boolean): ComparisonState => (equal ? "match" : "mismatch");
function bytesDiff(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): ByteComparison {
	const describe = (bytes: Uint8Array | null | undefined) =>
		bytes == null
			? null
			: {
					length: bytes.length,
					sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
				};
	let firstDifference: number | null = null;
	if (a != null && b != null) {
		const length = Math.min(a.length, b.length);
		for (let index = 0; index < length; index++) {
			if (a[index] !== b[index]) {
				firstDifference = index;
				break;
			}
		}
		if (firstDifference === null && a.length !== b.length) firstDifference = length;
	}
	return {
		state: a == null || b == null ? "unavailable" : stateOf(firstDifference === null),
		reference: describe(a),
		candidate: describe(b),
		firstDifference,
	};
}
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message: string): never {
	throw new Error(message);
}
function hexBytes(value: unknown): Uint8Array {
	if (typeof value !== "string" || !/^(?:[\da-fA-F]{2})*$/.test(value)) fail("invalid hex byte evidence");
	return Buffer.from(value, "hex");
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.isWellFormed()) fail("missing or malformed string evidence");
	return value;
}
function readRequests(value: unknown): CapturedRequest[] {
	if (!Array.isArray(value) || value.length === 0) fail("no completed requests captured");
	return value.map(item => {
		if (!object(item) || !Array.isArray(item.headers) || item.headers.length === 0)
			fail("missing ordered request headers");
		const headers: [string, string][] = item.headers.map(pair => {
			if (!Array.isArray(pair) || pair.length !== 2) fail("malformed ordered header pair");
			return [text(pair[0]), text(pair[1])];
		});
		const pseudo = (name: string): string | undefined => {
			const matches = headers.filter(pair => pair[0] === name);
			if (matches.length > 1) fail("duplicate request pseudo-header");
			return matches[0]?.[1];
		};
		const method = text(item.method ?? pseudo(":method"));
		const path = text(item.path ?? pseudo(":path"));
		if (!method || !path) fail("empty request method or path");
		if (
			(pseudo(":method") !== undefined && method !== pseudo(":method")) ||
			(pseudo(":path") !== undefined && path !== pseudo(":path"))
		)
			fail("inconsistent request metadata");
		if (
			item.streamId !== undefined &&
			(typeof item.streamId !== "number" ||
				!Number.isSafeInteger(item.streamId) ||
				item.streamId < 1 ||
				item.streamId > 0x7fffffff ||
				item.streamId % 2 !== 1)
		)
			fail("invalid request stream ID");
		// HTTP/1 capture decodes header octets as Latin-1; reject values that cannot round-trip.
		if (
			item.version !== undefined &&
			headers.some(pair => pair.some(value => [...value].some(character => character.codePointAt(0)! > 255)))
		)
			fail("invalid Latin-1 HTTP/1 header evidence");
		return {
			headers,
			body: hexBytes(item.bodyHex),
			method,
			path,
			streamId: item.streamId as number | undefined,
			version: item.version === undefined ? undefined : text(item.version),
		};
	});
}
function readCapture(input: unknown): Capture {
	const capture: Capture = { records: null, plaintext: null, requests: null, alpn: null, issues: [] };
	if (!object(input) || input.schemaVersion !== 1) {
		capture.issues.push("capture schemaVersion 1 required");
		return capture;
	}
	capture.alpn = input.alpn;
	if (input.connectAuthority !== undefined) {
		if (typeof input.connectAuthority !== "string" || !/^[\x21-\x7e]+$/.test(input.connectAuthority))
			capture.issues.push("malformed CONNECT authority metadata");
		else capture.connectAuthority = input.connectAuthority;
	}
	if (input.error !== undefined) capture.issues.push("capture recorded an error (contents omitted)");
	if (input.incompleteRequests !== undefined && input.incompleteRequests !== false)
		capture.issues.push("capture contains incomplete requests");
	try {
		capture.records = hexBytes(input.clientRecordsHex);
	} catch {
		capture.issues.push("missing or malformed TLS records");
	}
	try {
		capture.plaintext = hexBytes(input.clientPlaintextHex);
	} catch {
		capture.issues.push("missing or malformed plaintext");
	}
	try {
		capture.requests = readRequests(input.requests);
	} catch {
		capture.issues.push("missing or malformed completed request evidence");
	}
	return capture;
}
function validSpans(value: unknown, bound: number): DynamicSpan[] {
	if (!Array.isArray(value)) fail("exclusion spans must be arrays");
	let end = 0;
	return value.map(span => {
		if (!object(span) || Object.keys(span).some(key => !["offset", "length", "reason"].includes(key)))
			fail("invalid exclusion span fields");
		const { offset, length, reason } = span;
		if (
			typeof offset !== "number" ||
			typeof length !== "number" ||
			!Number.isSafeInteger(offset) ||
			!Number.isSafeInteger(length) ||
			offset < end ||
			length <= 0 ||
			offset > bound - length
		)
			fail("exclusion out of bounds, unordered, or overlapping");
		if (typeof reason !== "string" || !reason.trim() || !reason.isWellFormed()) fail("exclusion reason required");
		end = offset + length;
		return { offset, length, reason };
	});
}
function normalized(a: Uint8Array, b: Uint8Array, left: DynamicSpan[], right: DynamicSpan[]): ComparisonState {
	validSpans(left, a.length);
	validSpans(right, b.length);
	if (a.length !== b.length || !equalObject(left, right)) return "mismatch";
	let spanIndex = 0;
	for (let index = 0; index < a.length; index++) {
		const span = left[spanIndex];
		if (span && index === span.offset) {
			index += span.length - 1;
			spanIndex++;
			continue;
		}
		if (a[index] !== b[index]) return "mismatch";
	}
	return "match";
}
function headerBytes(request: CapturedRequest, value: string): Uint8Array {
	return request.version === undefined ? encoder.encode(value) : Buffer.from(value, "latin1");
}
function requestBytes(request: CapturedRequest, field: "body" | "header", headerIndex?: number): Uint8Array {
	if (field === "body") return request.body;
	const pair = headerIndex === undefined ? undefined : request.headers[headerIndex];
	if (!pair) fail("exclusion references missing header");
	return headerBytes(request, pair[1]);
}
function parseExclusions(value: unknown, a: Capture, b: Capture): RequestExclusion[] {
	if (value === undefined) return [];
	if (
		!object(value) ||
		value.schemaVersion !== 1 ||
		!Array.isArray(value.requests) ||
		Object.keys(value).some(key => !["schemaVersion", "requests"].includes(key))
	)
		fail("invalid exclusions schema");
	const seen = new Set<string>();
	return value.requests.map(entry => {
		if (
			!object(entry) ||
			Object.keys(entry).some(
				key => !["requestIndex", "field", "headerIndex", "reference", "candidate"].includes(key),
			)
		)
			fail("invalid exclusion target fields");
		if (
			typeof entry.requestIndex !== "number" ||
			!Number.isSafeInteger(entry.requestIndex) ||
			entry.requestIndex < 0 ||
			(entry.field !== "body" && entry.field !== "header")
		)
			fail("invalid exclusion target");
		const requestIndex = Number(entry.requestIndex);
		const headerIndex = entry.headerIndex === undefined ? undefined : Number(entry.headerIndex);
		if (
			entry.field === "header"
				? typeof entry.headerIndex !== "number" || !Number.isSafeInteger(entry.headerIndex) || entry.headerIndex < 0
				: entry.headerIndex !== undefined
		)
			fail("invalid exclusion headerIndex");
		const key = `${requestIndex}:${entry.field}:${headerIndex}`;
		if (seen.has(key)) fail("duplicate exclusion target");
		seen.add(key);
		const left = a.requests?.[requestIndex],
			right = b.requests?.[requestIndex];
		if (!left || !right) fail("exclusion references missing request");
		const reference = validSpans(entry.reference, requestBytes(left, entry.field, headerIndex).length);
		const candidate = validSpans(entry.candidate, requestBytes(right, entry.field, headerIndex).length);
		if (reference.length === 0 || !equalObject(reference, candidate))
			fail("paired exclusions require identical nonempty offset/length/reason layouts");
		return {
			requestIndex,
			field: entry.field,
			...(headerIndex === undefined ? {} : { headerIndex }),
			reference,
			candidate,
		};
	});
}
/** Length-prefixed decoded ordered pairs, preserving UTF-8 H2 / Latin-1 HTTP1 octets; not HPACK. */
function orderedHeaderBytes(request: CapturedRequest | undefined): Uint8Array | null {
	if (!request) return null;
	const parts = request.headers.flatMap(pair => pair.map(value => headerBytes(request, value)));
	const result = new Uint8Array(parts.reduce((length, part) => length + 4 + part.length, 0));
	const view = new DataView(result.buffer);
	let offset = 0;
	for (const part of parts) {
		view.setUint32(offset, part.length);
		result.set(part, offset + 4);
		offset += 4 + part.length;
	}
	return result;
}
function compareRequests(a: Capture, b: Capture, exclusions: RequestExclusion[]): RequestComparison[] {
	const result: RequestComparison[] = [];
	for (let index = 0; index < Math.max(a.requests?.length ?? 0, b.requests?.length ?? 0); index++) {
		const left = a.requests?.[index],
			right = b.requests?.[index];
		const method = bytesDiff(left && encoder.encode(left.method), right && encoder.encode(right.method));
		const path = bytesDiff(left && encoder.encode(left.path), right && encoder.encode(right.path));
		const body = bytesDiff(left?.body, right?.body);
		const apply = (field: "body" | "header", headerIndex?: number): ComparisonState => {
			if (!left || !right || (field === "header" && (!left.headers[headerIndex!] || !right.headers[headerIndex!])))
				return "unavailable";
			const exclusion = exclusions.find(
				item => item.requestIndex === index && item.field === field && item.headerIndex === headerIndex,
			);
			return normalized(
				requestBytes(left, field, headerIndex),
				requestBytes(right, field, headerIndex),
				exclusion?.reference ?? [],
				exclusion?.candidate ?? [],
			);
		};
		const headers: RequestComparison["headers"] = [];
		for (
			let headerIndex = 0;
			headerIndex < Math.max(left?.headers.length ?? 0, right?.headers.length ?? 0);
			headerIndex++
		) {
			const l = left?.headers[headerIndex],
				r = right?.headers[headerIndex];
			headers.push({
				index: headerIndex,
				name: bytesDiff(l && headerBytes(left!, l[0]), r && headerBytes(right!, r[0])),
				value: bytesDiff(l && headerBytes(left!, l[1]), r && headerBytes(right!, r[1])),
				normalized: apply("header", headerIndex),
			});
		}
		const matches =
			method.state === "match" &&
			path.state === "match" &&
			apply("body") === "match" &&
			left?.version === right?.version &&
			left?.streamId === right?.streamId &&
			headers.every(header => header.name.state === "match" && header.normalized === "match");
		result.push({
			index,
			method,
			path,
			orderedHeaders: bytesDiff(orderedHeaderBytes(left), orderedHeaderBytes(right)),
			body,
			headers,
			normalized: left && right ? stateOf(matches) : "mismatch",
		});
	}
	return result;
}
function tlsHello(capture: Capture): ParsedClientHello {
	if (!capture.records?.length) fail("TLS records absent");
	// Extraction only examines records through ClientHello; validate ALL remaining envelopes as well.
	for (let offset = 0; offset < capture.records.length;) {
		if (capture.records.length - offset < 5) fail("truncated TLS record header");
		const size = capture.records[offset + 3]! * 256 + capture.records[offset + 4]!;
		if (size > 18432 || offset + 5 + size > capture.records.length) fail("truncated or oversized TLS record");
		if (
			![20, 21, 22, 23, 24].includes(capture.records[offset]!) ||
			capture.records[offset + 1] !== 3 ||
			capture.records[offset + 2]! > 3
		)
			fail("invalid TLS record envelope");
		offset += 5 + size;
	}
	return parseClientHello(extractClientHelloFromRecords(capture.records).handshake);
}
function http1Evidence(
	capture: Capture,
	exclusions: RequestExclusion[],
	side: "reference" | "candidate",
): DynamicSpan[] {
	if (
		(capture.alpn !== "http/1.1" && capture.alpn !== null) ||
		!capture.plaintext?.length ||
		!capture.requests?.length
	)
		fail("HTTP/1 evidence absent");
	const bytes = Buffer.from(capture.plaintext.buffer, capture.plaintext.byteOffset, capture.plaintext.byteLength);
	let offset = 0;
	let requestIndex = 0;
	const projected: DynamicSpan[] = [];
	while (offset < bytes.length) {
		const end = bytes.indexOf("\r\n\r\n", offset, "latin1");
		if (end < 0) fail("incomplete HTTP/1 headers");
		const rows = bytes.subarray(offset, end).toString("latin1").split("\r\n");
		const requestLine = rows.shift()!;
		const first = requestLine.split(" ");
		let rowOffset = offset + requestLine.length + 2;
		const headerValueOffsets: number[] = [];
		if (
			first.length !== 3 ||
			first[2] !== "HTTP/1.1" ||
			!/^[\x21-\x7e]+$/.test(first[0]!) ||
			!/^[\x21-\x7e]+$/.test(first[1]!)
		)
			fail("unsupported HTTP/1 request line");
		const headers = rows.map(row => {
			const colon = row.indexOf(":");
			if (
				colon < 1 ||
				!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.slice(0, colon)) ||
				/[\x00-\x08\x0a-\x1f\x7f]/.test(row.slice(colon + 1))
			)
				fail("invalid HTTP/1 header");
			const value = row.slice(colon + 1).replace(/^[ \t]+/, "");
			headerValueOffsets.push(rowOffset + row.length - value.length);
			rowOffset += row.length + 2;
			return [row.slice(0, colon), value];
		});
		const lengths = headers.filter(pair => pair[0]!.toLowerCase() === "content-length");
		const transfers = headers.filter(pair => pair[0]!.toLowerCase() === "transfer-encoding");
		if (lengths.length > 1 || transfers.length > 1 || (transfers.length && lengths.length))
			fail("ambiguous HTTP/1 framing");
		const request = capture.requests[requestIndex++];
		if (
			!request ||
			request.method !== first[0] ||
			request.path !== first[1] ||
			request.version !== first[2] ||
			!equalObject(request.headers, headers)
		)
			fail("HTTP/1 decoded headers disagree with plaintext");
		const bodySegments: { wireOffset: number; bodyOffset: number; length: number }[] = [];
		let cursor = end + 4;
		let bodyLength = 0;
		if (transfers.length) {
			if (transfers[0]![1]!.trim().toLowerCase() !== "chunked") fail("unsupported HTTP/1 transfer coding");
			while (true) {
				const sizeEnd = bytes.indexOf("\r\n", cursor, "latin1");
				if (sizeEnd < 0) fail("incomplete HTTP/1 chunk size");
				const line = bytes.subarray(cursor, sizeEnd).toString("latin1");
				const match =
					/^([0-9a-fA-F]+)((?:;[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t\x20\x21\x23-\x5b\x5d-\x7e]|\\[\t\x20-\x7e])*"))?)*)$/.exec(
						line,
					);
				if (!match) fail("malformed HTTP/1 chunk size or extensions");
				const size = Number.parseInt(match[1]!, 16);
				if (!Number.isSafeInteger(size)) fail("oversized HTTP/1 chunk");
				cursor = sizeEnd + 2;
				if (size === 0) {
					while (true) {
						const trailerEnd = bytes.indexOf("\r\n", cursor, "latin1");
						if (trailerEnd < 0) fail("incomplete HTTP/1 trailers");
						if (trailerEnd === cursor) {
							cursor += 2;
							break;
						}
						const trailer = bytes.subarray(cursor, trailerEnd).toString("latin1");
						const colon = trailer.indexOf(":");
						const name = trailer.slice(0, colon);
						if (
							colon < 1 ||
							!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
							/[\x00-\x08\x0a-\x1f\x7f]/.test(trailer.slice(colon + 1)) ||
							["content-length", "transfer-encoding", "host", "trailer"].includes(name.toLowerCase())
						)
							fail("malformed or forbidden HTTP/1 trailer");
						cursor = trailerEnd + 2;
					}
					break;
				}
				if (size > bytes.length - cursor - 2 || bytes[cursor + size] !== 13 || bytes[cursor + size + 1] !== 10)
					fail("incomplete HTTP/1 chunk data");
				bodySegments.push({ wireOffset: cursor, bodyOffset: bodyLength, length: size });
				bodyLength += size;
				cursor += size + 2;
			}
		} else {
			const lengthText = lengths[0]?.[1]?.trim() ?? "0";
			if (!/^\d+$/.test(lengthText)) fail("invalid HTTP/1 body length");
			bodyLength = Number(lengthText);
			if (!Number.isSafeInteger(bodyLength) || bodyLength > bytes.length - cursor) fail("incomplete HTTP/1 body");
			bodySegments.push({ wireOffset: cursor, bodyOffset: 0, length: bodyLength });
			cursor += bodyLength;
		}
		if (bodyLength !== request.body.length) fail("HTTP/1 decoded body length disagrees with plaintext");
		for (const segment of bodySegments) {
			if (
				bytesDiff(
					bytes.subarray(segment.wireOffset, segment.wireOffset + segment.length),
					request.body.subarray(segment.bodyOffset, segment.bodyOffset + segment.length),
				).state !== "match"
			)
				fail("HTTP/1 decoded body disagrees with plaintext");
		}
		for (const exclusion of exclusions)
			if (exclusion.requestIndex === requestIndex - 1) {
				for (const span of exclusion[side]) {
					if (exclusion.field === "header") {
						if (
							["content-length", "transfer-encoding"].includes(
								request.headers[exclusion.headerIndex!]![0].toLowerCase(),
							)
						)
							fail("HTTP/1 framing headers cannot be excluded");
						projected.push({
							offset: headerValueOffsets[exclusion.headerIndex!]! + span.offset,
							length: span.length,
							reason: span.reason,
						});
					} else
						for (const segment of bodySegments) {
							const start = Math.max(span.offset, segment.bodyOffset),
								stop = Math.min(span.offset + span.length, segment.bodyOffset + segment.length);
							if (start < stop)
								projected.push({
									offset: segment.wireOffset + start - segment.bodyOffset,
									length: stop - start,
									reason: span.reason,
								});
						}
				}
			}
		offset = cursor;
	}
	if (requestIndex !== capture.requests.length) fail("HTTP/1 request coverage disagrees with plaintext");
	return projected.sort((a, b) => a.offset - b.offset);
}
function h2Evidence(capture: Capture): { analysis: Http2Analysis; structure: unknown; hpack: Uint8Array } {
	if (capture.alpn !== "h2" || !capture.plaintext?.length || !capture.requests?.length)
		fail("HTTP/2 plaintext and completed decoded requests required");
	const preliminary = analyzeHttp2(capture.plaintext);
	const firstStream = preliminary.frames.find(frame => frame.type === 1)?.streamId;
	const firstRequest = capture.requests.find(request => request.streamId === firstStream);
	if (!firstRequest) fail("first HEADERS stream has no decoded request evidence");
	const pseudo = (request: CapturedRequest): string[] =>
		request.headers.filter(pair => pair[0].startsWith(":")).map(pair => pair[0]);
	const analysis = analyzeHttp2(capture.plaintext, pseudo(firstRequest));
	if (analysis.akamai.value === null) fail("decoded Akamai components unavailable");
	const streams = new Set<number>();
	for (const frame of analysis.frames)
		if (frame.type === 1) {
			if (streams.has(frame.streamId))
				fail("multiple HEADERS blocks per stream require trailer-aware capture evidence");
			streams.add(frame.streamId);
		}
	if (
		streams.size !== capture.requests.length ||
		new Set(capture.requests.map(request => request.streamId)).size !== streams.size
	)
		fail("request coverage does not match captured streams");
	for (const request of capture.requests) {
		if (request.streamId === undefined || !streams.has(request.streamId)) fail("decoded request stream missing");
		const frames = analysis.frames.filter(frame => frame.streamId === request.streamId);
		if (!frames.some(frame => (frame.type === 0 || frame.type === 1) && (frame.flags & 1) !== 0))
			fail("request END_STREAM not captured");
		let bodyOffset = 0;
		for (const frame of frames)
			if (frame.type === 0) {
				const start = (frame.flags & 8) !== 0 ? 1 : 0;
				const data = frame.payload.subarray(start, frame.payload.length - (frame.paddingLength ?? 0));
				if (bytesDiff(data, request.body.subarray(bodyOffset, bodyOffset + data.length)).state !== "match")
					fail("decoded request body disagrees with DATA frames");
				bodyOffset += data.length;
			}
		if (bodyOffset !== request.body.length) fail("decoded request body length disagrees with DATA frames");
	}
	const hpack = Buffer.concat(analysis.frames.flatMap(frame => (frame.headerBlock ? [frame.headerBlock] : [])));
	const structure = {
		// Preserve frame order, flags, lengths, stream IDs and all non-HEADERS/DATA payloads.
		frames: analysis.frames.map(frame => ({
			type: frame.type,
			flags: frame.flags,
			streamId: frame.streamId,
			reserved: frame.reserved,
			length: frame.length,
			paddingLength: frame.paddingLength,
			settings: frame.settings?.map(item => [item.id, item.value]),
			windowIncrement: frame.windowIncrement,
			priority: frame.priority && {
				streamId: frame.priority.streamId,
				exclusive: frame.priority.exclusive,
				dependency: frame.priority.dependency,
				weight: frame.priority.weight,
				source: frame.priority.source,
			},
			controlPayloadSha256: [0, 1, 9].includes(frame.type)
				? undefined
				: bytesDiff(frame.payload, frame.payload).reference!.sha256,
		})),
		pseudoHeaders: [...streams].map(streamId => ({
			streamId,
			order: pseudo(capture.requests!.find(request => request.streamId === streamId)!),
		})),
	};
	return { analysis, structure, hpack };
}
function tcpEvidence(
	bytes: Uint8Array,
	observed: Capture,
	port: number,
): { usable: boolean; evidence: unknown; normalized: unknown } {
	const capture = parsePcap(bytes);
	const flows = summarizeTcpClientFlows(capture, port);
	// A single capture JSON describes one connection; a PCAP may include updater/control connections.
	// Select by unique exact bytes bound to this capture, never by a fingerprint or first-flow ordering.
	const candidates = flows.map(flow => {
		const reassembly = reassembleTcpPayload(flow.packets);
		let tlsBytes = reassembly.bytes;
		let connectPrefix: Uint8Array | null = null;
		let prefixValid = observed.connectAuthority === undefined;
		if (observed.connectAuthority !== undefined && reassembly.bytes) {
			const payload = Buffer.from(reassembly.bytes.buffer, reassembly.bytes.byteOffset, reassembly.bytes.byteLength);
			const end = payload.indexOf("\r\n\r\n");
			if (end >= 0 && end + 4 <= 65536) {
				const rows = payload.subarray(0, end).toString("latin1").split("\r\n");
				const first = rows.shift()!.split(" ");
				prefixValid =
					first.length === 3 &&
					first[0] === "CONNECT" &&
					first[1] === observed.connectAuthority &&
					first[2] === "HTTP/1.1" &&
					rows.every(row => {
						const colon = row.indexOf(":");
						return (
							colon > 0 &&
							/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.slice(0, colon)) &&
							!/[\x00-\x08\x0a-\x1f\x7f]/.test(row.slice(colon + 1))
						);
					});
				if (prefixValid) {
					connectPrefix = payload.subarray(0, end + 4);
					tlsBytes = payload.subarray(end + 4);
				}
			}
		}
		const payloadBinding = bytesDiff(tlsBytes, observed.records);
		return {
			flow,
			reassembly,
			connectPrefix,
			payloadBinding,
			matches: prefixValid && payloadBinding.state === "match",
		};
	});
	const matching = candidates.filter(candidate => candidate.matches);
	const diagnostics = candidates.map(candidate => ({
		tuple: candidate.flow.tuple,
		packetCount: candidate.flow.packets.length,
		synCount: candidate.flow.synPackets.length,
		reassembly: candidate.reassembly.status,
		gapCount: candidate.reassembly.gaps.length,
		overlapCount: candidate.reassembly.overlaps.length,
		issueCounts: { flow: candidate.flow.issues.length, reassembly: candidate.reassembly.issues.length },
		payloadBinding: candidate.payloadBinding,
		matches: candidate.matches,
	}));
	const selected = matching.length === 1 ? matching[0] : candidates.length === 1 ? candidates[0] : undefined;
	if (!selected || matching.length > 1) {
		return {
			usable: false,
			normalized: null,
			evidence: {
				selection: "unavailable",
				matchingFlowCount: matching.length,
				destinationPortFlowCount: flows.length,
				reason:
					matching.length > 1
						? "multiple flows have identical captured TLS bytes; selection ambiguous"
						: "no unique flow bound to captured TLS bytes",
				flows: diagnostics,
				captureIssueCount: capture.issues.length,
			},
		};
	}
	const { flow, reassembly, payloadBinding, connectPrefix } = selected;
	const option = (packet: TcpPacket) =>
		packet.options.map(item => {
			const raw = item.raw.slice();
			for (const span of packet.dynamicFields) {
				const start = Math.max(span.offset, item.offset),
					end = Math.min(span.offset + span.length, item.offset + item.length);
				if (start < end) raw.fill(0, start - item.offset, end - item.offset);
			}
			return { kind: item.kind, length: item.length, normalizedHex: Buffer.from(raw).toString("hex") };
		});
	const packets = flow.packets.map(packet => ({
		flags: packet.flags,
		reserved: packet.reserved,
		window: packet.window,
		ttl: packet.ttl,
		ipVersion: packet.tuple.ipVersion,
		ipHeaderLength: packet.ipHeaderLength,
		headerLength: packet.headerLength,
		urgentPointer: packet.urgentPointer,
		sequenceFromSyn: reassembly.baseSequence === null ? null : (packet.sequence - reassembly.baseSequence) | 0,
		payloadLength: packet.payload.length,
		options: option(packet),
		optionPaddingHex: Buffer.from(packet.optionPadding).toString("hex"),
	}));
	const overlapEvidence = reassembly.overlaps.map(({ start, end, identical, firstConflictOffset }) => ({
		start,
		end,
		identical,
		firstConflictOffset,
	}));
	const selectedPacketIndexes = new Set(flow.packets.map(packet => packet.packetIndex));
	const evidence = {
		selection: selected.matches ? "unique-exact-captured-TLS-bytes" : "single-flow-unbound",
		selectedTuple: flow.tuple,
		omittedUnrelatedFlowCount: Math.max(0, flows.length - 1),
		matchingFlowCount: matching.length,
		flows: diagnostics,
		unselectedPacketCount: capture.packets.filter(packet => !selectedPacketIndexes.has(packet.index)).length,
		connectPrefix: connectPrefix ? bytesDiff(connectPrefix, connectPrefix).reference : null,
		packetCount: flow.packets.length,
		syn: flow.synPackets.map(packet => ({ window: packet.window, ttl: packet.ttl, options: option(packet) })),
		packets,
		gaps: reassembly.gaps,
		overlaps: overlapEvidence,
		reassembly: reassembly.status,
		finObserved: reassembly.finObserved,
		rstObserved: reassembly.rstObserved,
		payloadBinding,
		issueCounts: { capture: capture.issues.length, flow: flow.issues.length, reassembly: reassembly.issues.length },
		dynamicFields: capture.dynamicFields,
	};
	return {
		usable:
			selected.matches &&
			capture.issues.length === 0 &&
			flow.issues.length === 0 &&
			reassembly.status === "complete" &&
			reassembly.origin === "syn",
		evidence,
		normalized: {
			packets,
			gaps: reassembly.gaps,
			overlaps: overlapEvidence,
			finObserved: reassembly.finObserved,
			rstObserved: reassembly.rstObserved,
		},
	};
}

/** Captures are evidence, not an attestation. No credential bytes or decoded header values enter the report. */
export function compareCaptures(
	reference: unknown,
	candidate: unknown,
	options: CompareOptions = {},
): ComparisonReport {
	const a = readCapture(reference),
		b = readCapture(candidate);
	const scopes: Record<string, ComparisonScope> = {};
	const errors = [...a.issues.map(issue => `reference: ${issue}`), ...b.issues.map(issue => `candidate: ${issue}`)];
	scopes.captureEvidence = errors.length
		? unavailable(true, ...errors)
		: { state: "match", required: true, reasons: [] };
	if (
		(options.scope !== undefined && options.scope !== "all" && options.scope !== "application-tls") ||
		(options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535))
	)
		scopes.options = unavailable(true, "invalid scope or port");
	let exclusions: RequestExclusion[] = [];
	try {
		exclusions = parseExclusions(options.exclusions, a, b);
		scopes.exclusions = { state: "match", required: true, reasons: [] };
	} catch {
		scopes.exclusions = unavailable(
			true,
			"invalid exclusions: require precise paired, bounded, nonoverlapping, identical offset/length/reason layouts and existing request targets",
		);
	}
	let leftHello: ParsedClientHello | undefined, rightHello: ParsedClientHello | undefined;
	try {
		leftHello = tlsHello(a);
	} catch {
		/* Raw TLS evidence remains available below. */
	}
	try {
		rightHello = tlsHello(b);
	} catch {
		/* Never expose parser input in an error. */
	}
	const requests = compareRequests(a, b, exclusions);
	const raw: ComparisonReport["raw"] = {
		clientHello: bytesDiff(leftHello?.raw, rightHello?.raw),
		tlsRecords: bytesDiff(a.records, b.records),
		http2Plaintext: bytesDiff(a.alpn === "h2" ? a.plaintext : null, b.alpn === "h2" ? b.plaintext : null),
		http1Plaintext: bytesDiff(
			a.alpn === "http/1.1" || a.alpn === null ? a.plaintext : null,
			b.alpn === "http/1.1" || b.alpn === null ? b.plaintext : null,
		),
		requests,
		pcap: bytesDiff(options.referencePcap, options.candidatePcap),
	};
	if (leftHello && rightHello) {
		scopes.clientHello = {
			state: normalized(leftHello.raw, rightHello.raw, leftHello.dynamicSpans, rightHello.dynamicSpans),
			required: true,
			reasons: [],
			evidence: {
				reference: { dynamicSpans: leftHello.dynamicSpans, ja3: ja3(leftHello), ja4: ja4(leftHello) },
				candidate: { dynamicSpans: rightHello.dynamicSpans, ja3: ja3(rightHello), ja4: ja4(rightHello) },
				spanLayoutsEqual: equalObject(leftHello.dynamicSpans, rightHello.dynamicSpans),
			},
		};
	} else
		scopes.clientHello = unavailable(true, "complete valid TLS record stream and ClientHello required on both sides");
	scopes.tlsRecordsRaw = {
		state: raw.tlsRecords.state,
		required: false,
		reasons: ["raw observation only; encrypted TLS records are not normalized"],
	};
	scopes.http2PlaintextRaw = {
		state: raw.http2Plaintext.state,
		required: false,
		reasons: [
			"raw plaintext equality is distinct from structural and decoded request equality; HPACK and framing differences remain significant observations",
		],
	};
	if (a.alpn === "h2" && b.alpn === "h2") {
		scopes.httpProtocol = { state: "match", required: true, reasons: ["both captures negotiated h2"] };
		try {
			const left = h2Evidence(a),
				right = h2Evidence(b);
			scopes.http2Structure = {
				state: stateOf(equalObject(left.structure, right.structure)),
				required: true,
				reasons: [],
				evidence: {
					reference: { akamai: left.analysis.akamai, structure: left.structure },
					candidate: { akamai: right.analysis.akamai, structure: right.structure },
				},
			};
			const hpack = bytesDiff(left.hpack, right.hpack);
			scopes.hpackRaw = {
				state: hpack.state,
				required: false,
				reasons: [
					"encoded HPACK bytes are not a normalized request comparison; no compressed-byte equality is implied",
				],
				evidence: hpack,
			};
		} catch {
			scopes.http2Structure = unavailable(
				true,
				"valid h2 plaintext, decoded pseudo-header sequence, complete stream coverage and consistent DATA evidence required; trailers are not represented by capture schema 1",
			);
			scopes.hpackRaw = unavailable(false, "complete HTTP/2 request evidence unavailable");
		}
	} else if ((a.alpn === "http/1.1" || a.alpn === null) && (b.alpn === "http/1.1" || b.alpn === null)) {
		try {
			const leftSpans = http1Evidence(a, exclusions, "reference"),
				rightSpans = http1Evidence(b, exclusions, "candidate");
			scopes.httpProtocol = {
				state: stateOf(a.alpn === b.alpn),
				required: true,
				reasons: ["HTTP/1.1 verified from plaintext; ALPN equality checked separately from request bytes"],
			};
			scopes.http1Plaintext = {
				state: normalized(a.plaintext!, b.plaintext!, leftSpans, rightSpans),
				required: true,
				reasons: [
					"strict HTTP/1.1 plaintext including whitespace, casing, framing and Content-Length; only explicit request exclusions projected into identical absolute byte spans",
				],
				evidence: { raw: raw.http1Plaintext, referenceSpans: leftSpans, candidateSpans: rightSpans },
			};
			scopes.http2Structure = {
				state: "not-applicable",
				required: false,
				reasons: ["observed HTTP/1.1, not HTTP/2; Akamai HTTP/2 fingerprint does not apply"],
			};
			scopes.hpackRaw = { state: "not-applicable", required: false, reasons: ["HTTP/1.1 does not use HPACK"] };
			scopes.http2PlaintextRaw = {
				state: "not-applicable",
				required: false,
				reasons: ["plaintext is HTTP/1.1; see http1Plaintext"],
			};
		} catch {
			scopes.httpProtocol = unavailable(
				true,
				"valid complete HTTP/1.1 plaintext consistent with decoded requests required",
			);
		}
	} else {
		scopes.httpProtocol = {
			state: a.alpn === "h2" || b.alpn === "h2" ? "mismatch" : "unavailable",
			required: true,
			reasons: ["negotiated protocols differ or are unsupported"],
		};
	}
	scopes.requests =
		a.requests && b.requests
			? {
					state: stateOf(
						a.requests.length === b.requests.length && requests.every(request => request.normalized === "match"),
					),
					required: true,
					reasons: [],
					evidence: {
						referenceCount: a.requests.length,
						candidateCount: b.requests.length,
						headerEncoding:
							"length-prefixed decoded pairs: UTF-8 for H2, Latin-1 for HTTP1; HPACK reported separately",
					},
				}
			: unavailable(true, "at least one completed request on each side required");
	const tcpRequired =
		options.scope !== "application-tls" || options.referencePcap !== undefined || options.candidatePcap !== undefined;
	if (!options.referencePcap || !options.candidatePcap)
		scopes.tcp = unavailable(
			tcpRequired,
			"both PCAP files required to observe transport; unavailable is not a transport match",
		);
	else {
		try {
			const port = options.port ?? 18443;
			const left = tcpEvidence(options.referencePcap, a, port),
				right = tcpEvidence(options.candidatePcap, b, port);
			scopes.tcp = {
				state:
					left.usable && right.usable ? stateOf(equalObject(left.normalized, right.normalized)) : "unavailable",
				required: true,
				reasons: [
					"compares observed client packet order, relative sequence positions, segmentation, SYN window/options/TTL, retransmissions and gaps, not encrypted payload equality",
					"PCAP timestamps, addresses/ports, absolute sequence/acknowledgment, IP IDs/flow labels, checksums and TCP timestamp/SACK values are dynamic or outside this scope; exact parser spans listed",
				],
				evidence: { reference: left.evidence, candidate: right.evidence },
			};
		} catch {
			scopes.tcp = unavailable(true, "malformed PCAP, invalid port or ambiguous/missing client flow");
		}
	}
	const required = Object.values(scopes).filter(scope => scope.required);
	const state: ComparisonState = required.some(scope => scope.state === "unavailable")
		? "unavailable"
		: required.some(scope => scope.state === "mismatch")
			? "mismatch"
			: "match";
	return {
		schemaVersion: 1,
		attestation: "unverified",
		claim: "Only the explicitly required observable normalized scopes are evaluated; not full protocol or identity equivalence",
		raw,
		scopes,
		exclusions,
		state,
		exitCode: state === "unavailable" ? 2 : state === "mismatch" ? 1 : 0,
	};
}

/** bun compare.ts --reference ref.json --candidate candidate.json [--reference-pcap ref.pcap --candidate-pcap candidate.pcap] [--scope all|application-tls] [--port 18443] [--exclusions spans.json] [--out report.json] */
async function main(): Promise<void> {
	const args = new Map<string, string>();
	const allowed: Record<string, true> = {
		"--reference": true,
		"--candidate": true,
		"--reference-pcap": true,
		"--candidate-pcap": true,
		"--port": true,
		"--scope": true,
		"--exclusions": true,
		"--out": true,
	};
	let report: ComparisonReport;
	try {
		for (let index = 2; index < process.argv.length; index += 2) {
			const flag = process.argv[index]!,
				value = process.argv[index + 1];
			if (!Object.hasOwn(allowed, flag) || args.has(flag) || !value || value.startsWith("--"))
				fail("invalid CLI arguments");
			args.set(flag, value);
		}
		if (!args.has("--reference") || !args.has("--candidate")) fail("reference and candidate required");
		const portString = args.get("--port") ?? "18443";
		if (!/^\d+$/.test(portString) || Number(portString) < 1 || Number(portString) > 65535) fail("invalid port");
		const scope = args.get("--scope") ?? "all";
		if (scope !== "all" && scope !== "application-tls") fail("invalid scope");
		const loadPcap = async (flag: string): Promise<Uint8Array | undefined> =>
			args.has(flag) ? new Uint8Array(await Bun.file(args.get(flag)!).arrayBuffer()) : undefined;
		const [reference, candidate, referencePcap, candidatePcap, exclusions] = await Promise.all([
			Bun.file(args.get("--reference")!).json(),
			Bun.file(args.get("--candidate")!).json(),
			loadPcap("--reference-pcap"),
			loadPcap("--candidate-pcap"),
			args.has("--exclusions") ? Bun.file(args.get("--exclusions")!).json() : undefined,
		]);
		report = compareCaptures(reference, candidate, {
			referencePcap,
			candidatePcap,
			port: Number(portString),
			exclusions,
			scope,
		});
	} catch {
		report = compareCaptures(undefined, undefined);
		report.scopes.input = unavailable(
			true,
			"invalid arguments or unreadable/malformed input; require --reference capture.json --candidate capture.json; optional paired --reference-pcap/--candidate-pcap, --scope all|application-tls, --port 18443, --exclusions spans.json, --out report.json",
		);
	}
	const json = `${JSON.stringify(report, null, 2)}\n`;
	try {
		if (args.has("--out")) await Bun.write(args.get("--out")!, json);
	} catch {
		process.stderr.write("Cannot write comparison report\n");
		process.exitCode = 2;
		return;
	}
	process.stdout.write(json);
	process.exitCode = report.exitCode;
}
if (import.meta.main) await main();
