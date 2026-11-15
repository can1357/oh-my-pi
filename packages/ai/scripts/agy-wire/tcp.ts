export interface DynamicSpan {
	/** Absolute offset into the input passed to parsePcap. No spans are automatically excluded. */
	offset: number;
	length: number;
	reason: string;
}

export interface CaptureIssue {
	kind: "unsupported" | "truncated" | "malformed";
	message: string;
	offset: number;
	packetIndex?: number;
}

export interface PcapHeader {
	byteOrder: "little" | "big";
	timestampResolution: "microsecond" | "nanosecond";
	versionMajor: number;
	versionMinor: number;
	thisZone: number;
	sigFigs: number;
	snapLength: number;
	/** Includes the original link-type additional-information bits. */
	network: number;
	linkType: number;
}

export interface CaptureTimestamp {
	seconds: number;
	fraction: number;
	resolution: "microsecond" | "nanosecond";
	/** Exact timestamp, without floating-point precision loss. */
	nanoseconds: bigint;
}

export interface TcpTuple {
	ipVersion: 4 | 6;
	sourceAddress: string;
	destinationAddress: string;
	sourcePort: number;
	destinationPort: number;
}

export interface TcpOption {
	kind: number;
	offset: number;
	length: number;
	raw: Uint8Array;
	mss?: number;
	windowScale?: number;
	timestampValue?: number;
	timestampEcho?: number;
	sackBlocks?: { left: number; right: number }[];
}

export interface TcpPacket {
	packetIndex: number;
	timestamp: CaptureTimestamp;
	tuple: TcpTuple;
	/** Absolute offsets into the PCAP input. */
	ipOffset: number;
	offset: number;
	payloadOffset: number;
	ipRaw: Uint8Array;
	raw: Uint8Array;
	ipHeaderLength: number;
	headerLength: number;
	sequence: number;
	acknowledgment: number;
	flags: number;
	flagNames: string[];
	reserved: number;
	window: number;
	checksum: number;
	urgentPointer: number;
	ipChecksum: number | null;
	ipIdentification: number | null;
	ipFlowLabel: number | null;
	ttl: number;
	options: TcpOption[];
	optionPadding: Uint8Array;
	payload: Uint8Array;
	dynamicFields: DynamicSpan[];
	/** Packet-local capture issues, including snaplen truncation. */
	issues: CaptureIssue[];
}

export interface PcapPacket {
	index: number;
	offset: number;
	dataOffset: number;
	timestamp: CaptureTimestamp;
	capturedLength: number;
	originalLength: number;
	rawRecord: Uint8Array;
	data: Uint8Array;
	tcp: TcpPacket | null;
	issues: CaptureIssue[];
}

export interface PcapCapture {
	raw: Uint8Array;
	header: PcapHeader;
	packets: PcapPacket[];
	issues: CaptureIssue[];
	dynamicFields: DynamicSpan[];
}

export class PcapParseError extends Error {
	constructor(
		message: string,
		readonly offset: number,
		readonly kind: CaptureIssue["kind"] = "malformed",
	) {
		super(`PCAP at byte ${offset}: ${message}`);
		this.name = "PcapParseError";
	}
}

function requireBytes(bytes: Uint8Array, offset: number, length: number, end = bytes.length): void {
	if (offset < 0 || length < 0 || offset + length > end || end > bytes.length) {
		throw new PcapParseError(`truncated field: need ${length} bytes`, offset, "truncated");
	}
}

function address(bytes: Uint8Array, offset: number, version: 4 | 6): string {
	if (version === 4) return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
	const parts: string[] = [];
	for (let i = 0; i < 16; i += 2) parts.push((bytes[offset + i]! * 256 + bytes[offset + i + 1]!).toString(16));
	return parts.join(":");
}

function decodeTcp(bytes: Uint8Array, packet: PcapPacket, linkType: number): TcpPacket | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let ipOffset = packet.dataOffset;
	const captureEnd = ipOffset + packet.capturedLength;
	let etherType: number;
	if (linkType === 1) {
		requireBytes(bytes, ipOffset, 14, captureEnd);
		etherType = view.getUint16(ipOffset + 12);
		ipOffset += 14;
		while (etherType === 0x8100 || etherType === 0x88a8 || etherType === 0x9100) {
			requireBytes(bytes, ipOffset, 4, captureEnd);
			etherType = view.getUint16(ipOffset + 2);
			ipOffset += 4;
		}
	} else if (linkType === 113) {
		requireBytes(bytes, ipOffset, 16, captureEnd);
		if (view.getUint16(ipOffset + 4) > 8)
			throw new PcapParseError("Linux cooked v1 address length exceeds 8", ipOffset + 4);
		etherType = view.getUint16(ipOffset + 14);
		ipOffset += 16;
	} else if (linkType === 276) {
		requireBytes(bytes, ipOffset, 20, captureEnd);
		if (bytes[ipOffset + 11]! > 8)
			throw new PcapParseError("Linux cooked v2 address length exceeds 8", ipOffset + 11);
		etherType = view.getUint16(ipOffset);
		ipOffset += 20;
	} else if (linkType === 101 || linkType === 12 || linkType === 228 || linkType === 229) {
		requireBytes(bytes, ipOffset, 1, captureEnd);
		const version = bytes[ipOffset]! >>> 4;
		if ((linkType === 228 && version !== 4) || (linkType === 229 && version !== 6)) {
			throw new PcapParseError("raw IP version disagrees with link type", ipOffset);
		}
		etherType = version === 4 ? 0x0800 : version === 6 ? 0x86dd : 0;
	} else {
		throw new PcapParseError(`unsupported link type ${linkType}`, ipOffset, "unsupported");
	}
	if (etherType !== 0x0800 && etherType !== 0x86dd) {
		throw new PcapParseError(`non-IP EtherType 0x${etherType.toString(16)}`, ipOffset, "unsupported");
	}
	const ipVersion = etherType === 0x0800 ? 4 : 6;
	requireBytes(bytes, ipOffset, ipVersion === 4 ? 20 : 40, captureEnd);
	if (bytes[ipOffset]! >>> 4 !== ipVersion)
		throw new PcapParseError("IP version disagrees with link protocol", ipOffset);
	let ipHeaderLength: number;
	let ipEnd: number;
	let protocol: number;
	let sourceAddress: string;
	let destinationAddress: string;
	let ipChecksum: number | null = null;
	let ipIdentification: number | null = null;
	let ipFlowLabel: number | null = null;
	let ttl: number;
	const dynamicFields: DynamicSpan[] = [];
	if (ipVersion === 4) {
		ipHeaderLength = (bytes[ipOffset]! & 15) * 4;
		if (ipHeaderLength < 20) throw new PcapParseError("IPv4 IHL below 5", ipOffset);
		const totalLength = view.getUint16(ipOffset + 2);
		if (totalLength < ipHeaderLength) throw new PcapParseError("IPv4 total length below header length", ipOffset + 2);
		requireBytes(bytes, ipOffset, totalLength, captureEnd);
		ipEnd = ipOffset + totalLength;
		const fragment = view.getUint16(ipOffset + 6);
		if ((fragment & 0x8000) !== 0) throw new PcapParseError("IPv4 reserved fragment flag set", ipOffset + 6);
		if ((fragment & 0x3fff) !== 0)
			throw new PcapParseError("IPv4 fragmentation requires IP reassembly", ipOffset + 6, "unsupported");
		protocol = bytes[ipOffset + 9]!;
		sourceAddress = address(bytes, ipOffset + 12, 4);
		destinationAddress = address(bytes, ipOffset + 16, 4);
		ipChecksum = view.getUint16(ipOffset + 10);
		ipIdentification = view.getUint16(ipOffset + 4);
		ttl = bytes[ipOffset + 8]!;
		dynamicFields.push(
			{ offset: ipOffset + 4, length: 2, reason: "IPv4 identification" },
			{
				offset: ipOffset + 10,
				length: 2,
				reason: "IPv4 header checksum (not validated; capture offload may affect it)",
			},
			{ offset: ipOffset + 12, length: 8, reason: "IPv4 source and destination addresses" },
		);
	} else {
		const payloadLength = view.getUint16(ipOffset + 4);
		if (payloadLength === 0)
			throw new PcapParseError("IPv6 zero payload length / jumbogram unsupported", ipOffset + 4, "unsupported");
		requireBytes(bytes, ipOffset, 40 + payloadLength, captureEnd);
		ipEnd = ipOffset + 40 + payloadLength;
		ipHeaderLength = 40;
		protocol = bytes[ipOffset + 6]!;
		sourceAddress = address(bytes, ipOffset + 8, 6);
		destinationAddress = address(bytes, ipOffset + 24, 6);
		ipFlowLabel = view.getUint32(ipOffset) & 0xfffff;
		ttl = bytes[ipOffset + 7]!;
		dynamicFields.push(
			{
				offset: ipOffset + 1,
				length: 3,
				reason: "IPv6 flow label (shares first byte with traffic-class low nibble; not an automatic exclusion)",
			},
			{ offset: ipOffset + 8, length: 32, reason: "IPv6 source and destination addresses" },
		);
		while (protocol === 0 || protocol === 43 || protocol === 60 || protocol === 51 || protocol === 44) {
			const extensionOffset = ipOffset + ipHeaderLength;
			requireBytes(bytes, extensionOffset, 2, ipEnd);
			let extensionLength: number;
			if (protocol === 44) {
				extensionLength = 8;
				requireBytes(bytes, extensionOffset, extensionLength, ipEnd);
				const fragment = view.getUint16(extensionOffset + 2);
				if ((fragment & 6) !== 0 || bytes[extensionOffset + 1] !== 0)
					throw new PcapParseError("IPv6 fragment reserved bits set", extensionOffset + 1);
				if ((fragment & 0xfff9) !== 0)
					throw new PcapParseError("IPv6 fragmentation requires IP reassembly", extensionOffset, "unsupported");
				dynamicFields.push({
					offset: extensionOffset + 4,
					length: 4,
					reason: "IPv6 atomic fragment identification",
				});
			} else {
				extensionLength =
					protocol === 51 ? (bytes[extensionOffset + 1]! + 2) * 4 : (bytes[extensionOffset + 1]! + 1) * 8;
				if (protocol === 51 && extensionLength < 12)
					throw new PcapParseError("AH extension shorter than fixed header", extensionOffset);
				requireBytes(bytes, extensionOffset, extensionLength, ipEnd);
			}
			protocol = bytes[extensionOffset]!;
			ipHeaderLength += extensionLength;
		}
	}
	if (protocol !== 6)
		throw new PcapParseError(`non-TCP IP protocol ${protocol}`, ipOffset + ipHeaderLength, "unsupported");
	const offset = ipOffset + ipHeaderLength;
	requireBytes(bytes, offset, 20, ipEnd);
	const headerLength = (bytes[offset + 12]! >>> 4) * 4;
	if (headerLength < 20) throw new PcapParseError("TCP data offset below 5", offset + 12);
	requireBytes(bytes, offset, headerLength, ipEnd);
	const sourcePort = view.getUint16(offset);
	const destinationPort = view.getUint16(offset + 2);
	const flags = ((bytes[offset + 12]! & 1) << 8) | bytes[offset + 13]!;
	const flagLabels = ["FIN", "SYN", "RST", "PSH", "ACK", "URG", "ECE", "CWR", "NS"];
	const flagNames = flagLabels.filter((_, bit) => (flags & (1 << bit)) !== 0);
	const options: TcpOption[] = [];
	let cursor = offset + 20;
	const optionEnd = offset + headerLength;
	let optionPadding = bytes.subarray(optionEnd, optionEnd);
	while (cursor < optionEnd) {
		const kind = bytes[cursor]!;
		if (kind === 0 || kind === 1) {
			options.push({ kind, offset: cursor, length: 1, raw: bytes.subarray(cursor, cursor + 1) });
			cursor++;
			if (kind === 0) {
				optionPadding = bytes.subarray(cursor, optionEnd);
				break;
			}
			continue;
		}
		requireBytes(bytes, cursor, 2, optionEnd);
		const length = bytes[cursor + 1]!;
		if (length < 2) throw new PcapParseError("TCP option length below 2", cursor + 1);
		requireBytes(bytes, cursor, length, optionEnd);
		const option: TcpOption = { kind, length, offset: cursor, raw: bytes.subarray(cursor, cursor + length) };
		if (kind === 2) {
			if (length !== 4) throw new PcapParseError("MSS option length must be 4", cursor);
			option.mss = view.getUint16(cursor + 2);
		} else if (kind === 3) {
			if (length !== 3) throw new PcapParseError("window scale option length must be 3", cursor);
			option.windowScale = bytes[cursor + 2]!;
		} else if (kind === 4) {
			if (length !== 2) throw new PcapParseError("SACK-permitted option length must be 2", cursor);
		} else if (kind === 5) {
			if (length < 10 || (length - 2) % 8 !== 0) throw new PcapParseError("invalid SACK option length", cursor);
			option.sackBlocks = [];
			for (let at = cursor + 2; at < cursor + length; at += 8) {
				option.sackBlocks.push({ left: view.getUint32(at), right: view.getUint32(at + 4) });
			}
			dynamicFields.push({ offset: cursor + 2, length: length - 2, reason: "TCP SACK sequence ranges" });
		} else if (kind === 8) {
			if (length !== 10) throw new PcapParseError("timestamp option length must be 10", cursor);
			option.timestampValue = view.getUint32(cursor + 2);
			option.timestampEcho = view.getUint32(cursor + 6);
			dynamicFields.push({ offset: cursor + 2, length: 8, reason: "TCP timestamp and echoed timestamp" });
		}
		options.push(option);
		cursor += length;
	}
	dynamicFields.push(
		{ offset, length: 4, reason: "TCP source and destination ports" },
		{ offset: offset + 4, length: 8, reason: "TCP sequence and acknowledgment numbers" },
		{ offset: offset + 16, length: 2, reason: "TCP checksum (not validated; capture offload may affect it)" },
	);
	return {
		packetIndex: packet.index,
		timestamp: packet.timestamp,
		tuple: { ipVersion, sourceAddress, destinationAddress, sourcePort, destinationPort },
		ipOffset,
		offset,
		payloadOffset: optionEnd,
		ipRaw: bytes.subarray(ipOffset, ipEnd),
		raw: bytes.subarray(offset, ipEnd),
		ipHeaderLength,
		headerLength,
		sequence: view.getUint32(offset + 4),
		acknowledgment: view.getUint32(offset + 8),
		flags,
		flagNames,
		reserved: (bytes[offset + 12]! >>> 1) & 7,
		window: view.getUint16(offset + 14),
		checksum: view.getUint16(offset + 16),
		urgentPointer: view.getUint16(offset + 18),
		ipChecksum,
		ipIdentification,
		ipFlowLabel,
		ttl,
		options,
		optionPadding,
		payload: bytes.subarray(optionEnd, ipEnd),
		dynamicFields,
		issues: packet.issues,
	};
}

/** Classic PCAP only. Structural truncation throws; undecodable packet records remain explicit issues. */
export function parsePcap(bytes: Uint8Array): PcapCapture {
	requireBytes(bytes, 0, 24);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const magic = view.getUint32(0);
	if (magic === 0x0a0d0d0a) throw new PcapParseError("PCAPNG unsupported; supply classic PCAP", 0, "unsupported");
	const little = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1;
	const nano = magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
	if (!little && magic !== 0xa1b2c3d4 && magic !== 0xa1b23c4d)
		throw new PcapParseError("unknown PCAP magic", 0, "unsupported");
	const header: PcapHeader = {
		byteOrder: little ? "little" : "big",
		timestampResolution: nano ? "nanosecond" : "microsecond",
		versionMajor: view.getUint16(4, little),
		versionMinor: view.getUint16(6, little),
		thisZone: view.getInt32(8, little),
		sigFigs: view.getUint32(12, little),
		snapLength: view.getUint32(16, little),
		network: view.getUint32(20, little),
		linkType: view.getUint32(20, little) & 0xffff,
	};
	if (header.versionMajor !== 2 || header.versionMinor !== 4)
		throw new PcapParseError(
			`unsupported PCAP version ${header.versionMajor}.${header.versionMinor}`,
			4,
			"unsupported",
		);
	if (header.snapLength === 0) throw new PcapParseError("snaplen must be nonzero", 16);
	const packets: PcapPacket[] = [];
	const issues: CaptureIssue[] = [];
	const dynamicFields: DynamicSpan[] = [];
	if (![1, 12, 101, 113, 228, 229, 276].includes(header.linkType)) {
		issues.push({ kind: "unsupported", message: `unsupported link type ${header.linkType}`, offset: 20 });
	}
	let offset = 24;
	while (offset < bytes.length) {
		requireBytes(bytes, offset, 16);
		const seconds = view.getUint32(offset, little);
		const fraction = view.getUint32(offset + 4, little);
		if (fraction >= (nano ? 1e9 : 1e6)) throw new PcapParseError("timestamp fraction out of range", offset + 4);
		const capturedLength = view.getUint32(offset + 8, little);
		const originalLength = view.getUint32(offset + 12, little);
		if (capturedLength > originalLength)
			throw new PcapParseError("captured length exceeds original length", offset + 8);
		if (capturedLength > header.snapLength) throw new PcapParseError("captured length exceeds snaplen", offset + 8);
		const dataOffset = offset + 16;
		requireBytes(bytes, dataOffset, capturedLength);
		const timestamp: CaptureTimestamp = {
			seconds,
			fraction,
			resolution: header.timestampResolution,
			nanoseconds: BigInt(seconds) * 1_000_000_000n + BigInt(fraction) * (nano ? 1n : 1000n),
		};
		const packet: PcapPacket = {
			index: packets.length,
			offset,
			dataOffset,
			timestamp,
			capturedLength,
			originalLength,
			rawRecord: bytes.subarray(offset, dataOffset + capturedLength),
			data: bytes.subarray(dataOffset, dataOffset + capturedLength),
			tcp: null,
			issues: [],
		};
		if (capturedLength < originalLength)
			packet.issues.push({
				kind: "truncated",
				message: `capture omitted ${originalLength - capturedLength} packet bytes`,
				offset: dataOffset + capturedLength,
				packetIndex: packet.index,
			});
		try {
			packet.tcp = decodeTcp(bytes, packet, header.linkType);
		} catch (error) {
			if (!(error instanceof PcapParseError)) throw error;
			packet.issues.push({
				kind: error.kind,
				message: error.message,
				offset: error.offset,
				packetIndex: packet.index,
			});
		}
		issues.push(...packet.issues);
		dynamicFields.push({ offset, length: 8, reason: "PCAP capture timestamp" });
		if (packet.tcp) dynamicFields.push(...packet.tcp.dynamicFields);
		packets.push(packet);
		offset = dataOffset + capturedLength;
	}
	return { raw: bytes, header, packets, issues, dynamicFields };
}

export interface TcpClientFlow {
	key: string;
	tuple: TcpTuple;
	/** Original capture order, including ACK-only packets and retransmissions. */
	packets: TcpPacket[];
	synPackets: TcpPacket[];
	payloadPacketCount: number;
	payloadBytesOnWire: number;
	issues: string[];
}

function tupleKey(tuple: TcpTuple): string {
	return `${tuple.ipVersion}|${tuple.sourceAddress}|${tuple.sourcePort}|${tuple.destinationAddress}|${tuple.destinationPort}`;
}

/** A directed tuple is not proof of application identity; check capture.issues before interpreting flows. */
export function summarizeTcpClientFlows(capture: PcapCapture, destinationPort: number): TcpClientFlow[] {
	if (!Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535)
		throw new RangeError("destinationPort must be in 1..65535");
	const flows = new Map<string, TcpClientFlow>();
	for (const record of capture.packets) {
		const packet = record.tcp;
		if (!packet || packet.tuple.destinationPort !== destinationPort) continue;
		const key = tupleKey(packet.tuple);
		let flow = flows.get(key);
		if (!flow) {
			flow = {
				key,
				tuple: packet.tuple,
				packets: [],
				synPackets: [],
				payloadPacketCount: 0,
				payloadBytesOnWire: 0,
				issues: [],
			};
			flows.set(key, flow);
		}
		flow.packets.push(packet);
		if ((packet.flags & 2) !== 0 && (packet.flags & 16) === 0) flow.synPackets.push(packet);
		if (packet.payload.length > 0) flow.payloadPacketCount++;
		flow.payloadBytesOnWire += packet.payload.length;
		for (const issue of packet.issues) flow.issues.push(`packet ${packet.packetIndex}: ${issue.message}`);
	}
	for (const flow of flows.values()) {
		if (flow.synPackets.length === 0) flow.issues.push("client SYN unavailable; stream origin unverified");
		if (new Set(flow.synPackets.map(packet => packet.sequence)).size > 1)
			flow.issues.push(
				"tuple reused with differing initial sequence numbers; select one connection before reassembly",
			);
	}
	return [...flows.values()];
}

export interface TcpPayloadChunk {
	packetIndex: number;
	/** Relative to baseSequence; sequence wrap is handled within a <2^31-byte stream. */
	start: number;
	end: number;
	payload: Uint8Array;
}

export interface TcpOverlap {
	start: number;
	end: number;
	packetIndex: number;
	previousPacketIndex: number;
	identical: boolean;
	firstConflictOffset: number | null;
}

export interface TcpReassembly {
	/** 'complete' means contiguous captured payload from SYN, not a proven complete TLS/application exchange. */
	status: "complete" | "incomplete" | "conflict" | "unavailable";
	bytes: Uint8Array | null;
	baseSequence: number | null;
	origin: "syn" | "first-payload" | "unavailable";
	chunks: TcpPayloadChunk[];
	gaps: { start: number; end: number }[];
	overlaps: TcpOverlap[];
	issues: string[];
	finObserved: boolean;
	rstObserved: boolean;
}

/**
 * Reassembles ONE directed TCP tuple. Never normalizes payload or hides duplicate segments.
 * Exact duplicate/partial retransmissions are recorded. Conflicts or gaps withhold bytes.
 * Without SYN, chunks remain inspectable but origin is unverified and bytes are withheld.
 * Sequence arithmetic is intentionally bounded to a half sequence space; larger captures need epochs.
 */
export function reassembleTcpPayload(packets: readonly TcpPacket[]): TcpReassembly {
	const result: TcpReassembly = {
		status: "unavailable",
		bytes: null,
		baseSequence: null,
		origin: "unavailable",
		chunks: [],
		gaps: [],
		overlaps: [],
		issues: [],
		finObserved: packets.some(packet => (packet.flags & 1) !== 0),
		rstObserved: packets.some(packet => (packet.flags & 4) !== 0),
	};
	if (packets.length === 0) {
		result.issues.push("no TCP packets supplied");
		return result;
	}
	const key = tupleKey(packets[0]!.tuple);
	if (packets.some(packet => tupleKey(packet.tuple) !== key)) {
		result.issues.push("multiple directed TCP tuples supplied");
		return result;
	}
	const syns = packets.filter(packet => (packet.flags & 2) !== 0);
	const initialSequences = new Set(syns.map(packet => packet.sequence));
	if (initialSequences.size > 1) {
		result.issues.push("multiple SYN sequence numbers; connection epochs are ambiguous");
		return result;
	}
	const firstPayload = packets.find(packet => packet.payload.length > 0);
	if (!firstPayload) {
		result.issues.push("no captured TCP payload");
		return result;
	}
	result.origin = syns.length > 0 ? "syn" : "first-payload";
	const base = syns.length > 0 ? (syns[0]!.sequence + 1) >>> 0 : firstPayload.sequence;
	result.baseSequence = base;
	if (result.origin !== "syn")
		result.issues.push("SYN unavailable; first captured payload is not proof of stream origin");
	for (const packet of packets) {
		for (const issue of packet.issues) result.issues.push(`packet ${packet.packetIndex}: ${issue.message}`);
		if (packet.payload.length === 0) continue;
		const sequence = (packet.sequence + ((packet.flags & 2) !== 0 ? 1 : 0)) >>> 0;
		const start = (sequence - base) | 0;
		const end = start + packet.payload.length;
		if (start < 0 || end >= 0x80000000)
			result.issues.push(`packet ${packet.packetIndex}: sequence outside supported stream half-space`);
		result.chunks.push({ packetIndex: packet.packetIndex, start, end, payload: packet.payload });
	}
	result.chunks.sort((a, b) => a.start - b.start || a.packetIndex - b.packetIndex);
	// Disjoint first-observed coverage retains provenance and avoids allocating by an attacker-controlled sequence gap.
	const coverage: TcpPayloadChunk[] = [];
	let coveredEnd = 0;
	let conflict = false;
	for (const chunk of result.chunks) {
		if (chunk.start < 0 || chunk.end >= 0x80000000) continue;
		if (chunk.start > coveredEnd) result.gaps.push({ start: coveredEnd, end: chunk.start });
		for (let index = coverage.length - 1; index >= 0; index--) {
			const previous = coverage[index]!;
			if (previous.end <= chunk.start) break;
			const start = Math.max(chunk.start, previous.start);
			const end = Math.min(chunk.end, previous.end);
			if (start >= end) continue;
			let firstConflictOffset: number | null = null;
			for (let at = start; at < end; at++) {
				if (chunk.payload[at - chunk.start] !== previous.payload[at - previous.start]) {
					firstConflictOffset = at;
					break;
				}
			}
			const identical = firstConflictOffset === null;
			if (!identical) conflict = true;
			result.overlaps.push({
				start,
				end,
				packetIndex: chunk.packetIndex,
				previousPacketIndex: previous.packetIndex,
				identical,
				firstConflictOffset,
			});
		}
		if (chunk.end > coveredEnd) {
			const start = Math.max(chunk.start, coveredEnd);
			coverage.push({
				packetIndex: chunk.packetIndex,
				start,
				end: chunk.end,
				payload: chunk.payload.subarray(start - chunk.start),
			});
			coveredEnd = chunk.end;
		}
	}
	const fins = packets.filter(packet => (packet.flags & 1) !== 0);
	for (const packet of fins) {
		const finOffset = (((packet.sequence + ((packet.flags & 2) !== 0 ? 1 : 0)) >>> 0) - base) | 0;
		const payloadEnd = finOffset + packet.payload.length;
		if (payloadEnd > coveredEnd && payloadEnd < 0x80000000) {
			if (!result.gaps.some(gap => gap.start === coveredEnd && gap.end === payloadEnd))
				result.gaps.push({ start: coveredEnd, end: payloadEnd });
		} else if (payloadEnd < coveredEnd)
			result.issues.push(`packet ${packet.packetIndex}: payload observed beyond FIN sequence`);
	}
	if (conflict) result.issues.push("conflicting overlapping TCP payload bytes");
	if (result.gaps.length > 0) result.issues.push("missing TCP sequence ranges");
	if (conflict) result.status = "conflict";
	else if (result.issues.length > 0) result.status = "incomplete";
	else {
		result.status = "complete";
		result.bytes = new Uint8Array(coveredEnd);
		for (const chunk of coverage) result.bytes.set(chunk.payload, chunk.start);
	}
	return result;
}
