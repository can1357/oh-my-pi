export interface Http2Setting {
	id: number;
	value: number;
	/** Offset of this six-byte setting in the supplied input. */
	offset: number;
}

export interface Http2Priority {
	streamId: number;
	exclusive: boolean;
	dependency: number;
	/** Decoded weight, in the range 1..256. */
	weight: number;
	offset: number;
	source: "PRIORITY" | "HEADERS";
}

export interface Http2Frame {
	offset: number;
	length: number;
	type: number;
	flags: number;
	streamId: number;
	reserved: boolean;
	/** Views into the original input, including otherwise ignored extension bytes. */
	raw: Uint8Array;
	payload: Uint8Array;
	settings?: Http2Setting[];
	windowIncrement?: number;
	priority?: Http2Priority;
	headerBlock?: Uint8Array;
	paddingLength?: number;
	errorCode?: number;
}

export interface AkamaiHttp2Fingerprint {
	/** No fingerprint is emitted without the initial request and decoded pseudo-header evidence. */
	value: string | null;
	unavailableReasons: string[];
	components: {
		settings: string;
		windowUpdate: string;
		priorities: string;
		pseudoHeaderOrder: string | null;
	};
}

export interface Http2Analysis {
	raw: Uint8Array;
	preface: Uint8Array;
	frames: Http2Frame[];
	/** First non-ACK SETTINGS, preserving duplicates and wire order. */
	settings: Http2Setting[];
	/** First connection WINDOW_UPDATE before the first request HEADERS; null if absent. */
	initialConnectionWindowUpdate: Http2Frame | null;
	/** All explicit PRIORITY and HEADERS priority fields, in wire order. */
	priorities: Http2Priority[];
	akamai: AkamaiHttp2Fingerprint;
}

export class Http2ParseError extends Error {
	constructor(
		message: string,
		readonly offset: number,
	) {
		super(`HTTP/2 at byte ${offset}: ${message}`);
		this.name = "Http2ParseError";
	}
}

const PREFACE = new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const PSEUDO_CODES: Readonly<Record<string, string>> = {
	":method": "m",
	":authority": "a",
	":scheme": "s",
	":path": "p",
};

/**
 * Parse a reassembled, plaintext client connection, not TLS records or individual TCP chunks.
 * Unknown frame types/flags and reserved bits are retained (HTTP/2 requires receivers to ignore them).
 * This is framing validation, not an HPACK decoder or a bidirectional stream-state validator.
 * pseudoHeaderOrder must be the actual decoded sequence from the FIRST request header block.
 */
export function analyzeHttp2(bytes: Uint8Array, pseudoHeaderOrder?: string[]): Http2Analysis {
	const fail = (message: string, offset: number): never => {
		throw new Http2ParseError(message, offset);
	};
	if (bytes.length < PREFACE.length) fail("truncated client connection preface", bytes.length);
	for (let i = 0; i < PREFACE.length; i++) {
		if (bytes[i] !== PREFACE[i]) fail("invalid client connection preface", i);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const frames: Http2Frame[] = [];
	const priorities: Http2Priority[] = [];
	let initialConnectionWindowUpdate: Http2Frame | null = null;
	let firstHeadersIndex = -1;
	let continuationStream = 0;
	let firstHeaderComplete = false;
	let offset = PREFACE.length;
	const parsePriority = (at: number, streamId: number, source: Http2Priority["source"]): Http2Priority => {
		const encoded = view.getUint32(at);
		const dependency = encoded & 0x7fffffff;
		if (dependency === streamId) fail("stream depends on itself", at);
		return {
			streamId,
			dependency,
			exclusive: (encoded & 0x80000000) !== 0,
			weight: bytes[at + 4]! + 1,
			offset: at,
			source,
		};
	};
	while (offset < bytes.length) {
		if (bytes.length - offset < 9) fail("truncated frame header", offset);
		const length = bytes[offset]! * 65536 + bytes[offset + 1]! * 256 + bytes[offset + 2]!;
		const type = bytes[offset + 3]!;
		const flags = bytes[offset + 4]!;
		const encodedStream = view.getUint32(offset + 5);
		const streamId = encodedStream & 0x7fffffff;
		const start = offset + 9;
		const end = start + length;
		if (end > bytes.length) fail(`truncated frame payload: need ${length}, have ${bytes.length - start}`, offset);
		if (frames.length === 0 && (type !== 4 || (flags & 1) !== 0))
			fail("first client frame must be non-ACK SETTINGS", offset);
		if (continuationStream !== 0 && (type !== 9 || streamId !== continuationStream)) {
			fail("header block interrupted before END_HEADERS", offset);
		}
		if ((type === 0 || type === 1 || type === 2 || type === 3 || type === 9) && streamId === 0) {
			fail("frame requires a nonzero stream", offset + 5);
		}
		if ((type === 4 || type === 6 || type === 7) && streamId !== 0)
			fail("frame requires connection stream zero", offset + 5);
		const frame: Http2Frame = {
			offset,
			length,
			type,
			flags,
			streamId,
			reserved: (encodedStream & 0x80000000) !== 0,
			raw: bytes.subarray(offset, end),
			payload: bytes.subarray(start, end),
		};
		switch (type) {
			case 0:
			case 1: {
				let cursor = start;
				let padding = 0;
				if ((flags & 8) !== 0) {
					if (length === 0) fail("missing padding length", start);
					padding = bytes[cursor++]!;
					frame.paddingLength = padding;
				}
				if (type === 1) {
					if ((streamId & 1) === 0) fail("client request HEADERS must use an odd stream ID", offset + 5);
					if ((flags & 32) !== 0) {
						if (end - cursor < 5) fail("truncated HEADERS priority", cursor);
						frame.priority = parsePriority(cursor, streamId, "HEADERS");
						priorities.push(frame.priority);
						cursor += 5;
					}
				}
				if (padding > end - cursor) fail("padding exceeds frame payload", cursor);
				if (type === 1) {
					frame.headerBlock = bytes.subarray(cursor, end - padding);
					if (firstHeadersIndex < 0) firstHeadersIndex = frames.length;
					if ((flags & 4) === 0) continuationStream = streamId;
					else if (firstHeadersIndex === frames.length) firstHeaderComplete = true;
				}
				break;
			}
			case 2:
				if (length !== 5) fail("PRIORITY length must be 5", offset);
				frame.priority = parsePriority(start, streamId, "PRIORITY");
				priorities.push(frame.priority);
				break;
			case 3:
				if (length !== 4) fail("RST_STREAM length must be 4", offset);
				frame.errorCode = view.getUint32(start);
				break;
			case 4: {
				if ((flags & 1) !== 0 && length !== 0) fail("SETTINGS ACK must be empty", offset);
				if (length % 6 !== 0) fail("SETTINGS length must be a multiple of 6", offset);
				frame.settings = [];
				for (let at = start; at < end; at += 6) {
					const id = view.getUint16(at);
					const value = view.getUint32(at + 2);
					if ((id === 2 || id === 8 || id === 9) && value > 1) fail(`boolean setting ${id} must be 0 or 1`, at);
					if (id === 4 && value > 0x7fffffff) fail("INITIAL_WINDOW_SIZE exceeds 2^31-1", at);
					if (id === 5 && (value < 16384 || value > 16777215)) fail("MAX_FRAME_SIZE is out of range", at);
					frame.settings.push({ id, value, offset: at });
				}
				break;
			}
			case 5:
				return fail("clients must not send PUSH_PROMISE", offset);
			case 6:
				if (length !== 8) fail("PING length must be 8", offset);
				break;
			case 7:
				if (length < 8) fail("GOAWAY length must be at least 8", offset);
				frame.errorCode = view.getUint32(start + 4);
				break;
			case 8:
				if (length !== 4) fail("WINDOW_UPDATE length must be 4", offset);
				frame.windowIncrement = view.getUint32(start) & 0x7fffffff;
				if (frame.windowIncrement === 0) fail("WINDOW_UPDATE increment must be nonzero", start);
				if (streamId === 0 && firstHeadersIndex < 0 && initialConnectionWindowUpdate === null)
					initialConnectionWindowUpdate = frame;
				break;
			case 9:
				if (continuationStream === 0) fail("unexpected CONTINUATION", offset);
				frame.headerBlock = frame.payload;
				if ((flags & 4) !== 0) {
					continuationStream = 0;
					if (!firstHeaderComplete) firstHeaderComplete = true;
				}
				break;
		}
		frames.push(frame);
		offset = end;
	}
	if (frames.length === 0) fail("missing initial SETTINGS frame", offset);
	if (continuationStream !== 0) fail("truncated header block: missing END_HEADERS", offset);
	const settings = frames[0]!.settings!;
	const unavailableReasons: string[] = [];
	if (!firstHeaderComplete)
		unavailableReasons.push("initial request HEADERS not captured; initial fingerprint boundary unknown");
	let pseudoCodes: string | null = null;
	if (pseudoHeaderOrder === undefined || pseudoHeaderOrder.length === 0) {
		unavailableReasons.push("decoded first-request pseudo-header sequence unavailable");
	} else {
		const seen = new Set<string>();
		const codes: string[] = [];
		for (const name of pseudoHeaderOrder) {
			if (!name.startsWith(":")) fail(`not a pseudo-header name: ${name}`, 0);
			if (seen.has(name)) fail(`duplicate pseudo-header: ${name}`, 0);
			seen.add(name);
			const code = PSEUDO_CODES[name];
			if (code === undefined) unavailableReasons.push(`Akamai notation unavailable for pseudo-header ${name}`);
			else codes.push(code);
		}
		if (codes.length === pseudoHeaderOrder.length) pseudoCodes = codes.join(",");
	}
	const initialPriorities = frames
		.slice(0, firstHeadersIndex < 0 ? frames.length : firstHeadersIndex)
		.filter(frame => frame.type === 2)
		.map(frame => frame.priority!);
	const components = {
		settings: settings.map(setting => `${setting.id}:${setting.value}`).join(";"),
		windowUpdate: String(initialConnectionWindowUpdate?.windowIncrement ?? 0),
		priorities:
			initialPriorities
				.map(
					priority =>
						`${priority.streamId}:${Number(priority.exclusive)}:${priority.dependency}:${priority.weight}`,
				)
				.join(",") || "0",
		pseudoHeaderOrder: pseudoCodes,
	};
	return {
		raw: bytes,
		preface: bytes.subarray(0, PREFACE.length),
		frames,
		settings,
		initialConnectionWindowUpdate,
		priorities,
		akamai: {
			value:
				unavailableReasons.length === 0
					? `${components.settings}|${components.windowUpdate}|${components.priorities}|${pseudoCodes}`
					: null,
			unavailableReasons,
			components,
		},
	};
}
