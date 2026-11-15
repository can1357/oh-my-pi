import { describe, expect, test } from "bun:test";
import { analyzeHttp2, Http2ParseError } from "../scripts/agy-wire/http2";
import { parsePcap, PcapParseError, reassembleTcpPayload, summarizeTcpClientFlows } from "../scripts/agy-wire/tcp";

const preface = new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

function join(...parts: Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
	let cursor = 0;
	for (const part of parts) {
		output.set(part, cursor);
		cursor += part.length;
	}
	return output;
}

function frame(type: number, flags: number, stream: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
	const bytes = new Uint8Array(9 + payload.length);
	const view = new DataView(bytes.buffer);
	bytes[0] = payload.length >>> 16;
	bytes[1] = payload.length >>> 8;
	bytes[2] = payload.length;
	bytes[3] = type;
	bytes[4] = flags;
	view.setUint32(5, stream);
	bytes.set(payload, 9);
	return bytes;
}

function setting(id: number, value: number): Uint8Array {
	const bytes = new Uint8Array(6);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, id);
	view.setUint32(2, value);
	return bytes;
}

function u32(value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value);
	return bytes;
}

const emptySettings = frame(4, 0, 0);
// The parser deliberately does not decode HPACK. This is a literal indexed :method GET field.
const firstHeaders = frame(1, 4, 1, new Uint8Array([0x82]));

describe("AGY HTTP/2 capture parser", () => {
	test("preserves ordered SETTINGS, raw bytes, priorities and observed fingerprint components", () => {
		const input = join(
			preface,
			frame(4, 0, 0, join(setting(4, 65535), setting(1, 4096), setting(1, 8192))),
			frame(8, 0, 0, u32(15663105)),
			frame(2, 0, 3, join(u32(0x80000000), new Uint8Array([200]))),
			firstHeaders,
		);
		const parsed = analyzeHttp2(input, [":method", ":authority", ":scheme", ":path"]);
		expect(parsed.raw).toBe(input);
		expect(parsed.frames[0]!.raw.buffer).toBe(input.buffer);
		expect(parsed.settings.map(item => [item.id, item.value])).toEqual([
			[4, 65535],
			[1, 4096],
			[1, 8192],
		]);
		expect(parsed.initialConnectionWindowUpdate?.windowIncrement).toBe(15663105);
		expect(parsed.priorities[0]).toMatchObject({ streamId: 3, exclusive: true, dependency: 0, weight: 201 });
		expect(parsed.akamai.value).toBe("4:65535;1:4096;1:8192|15663105|3:1:0:201|m,a,s,p");
	});

	test("does not invent pseudo-header order or a missing request boundary", () => {
		expect(analyzeHttp2(join(preface, emptySettings, firstHeaders)).akamai.value).toBeNull();
		expect(analyzeHttp2(join(preface, emptySettings), [":method"]).akamai.value).toBeNull();
		expect(analyzeHttp2(join(preface, emptySettings, firstHeaders), []).akamai.value).toBeNull();
		expect(
			analyzeHttp2(join(preface, emptySettings, firstHeaders), [":method", ":protocol"]).akamai.value,
		).toBeNull();
		expect(() => analyzeHttp2(join(preface, emptySettings, firstHeaders), [":method", ":method"])).toThrow(
			"duplicate pseudo-header",
		);
	});

	test("retains HEADERS priority and padding without adding it to standalone PRIORITY fingerprint", () => {
		const headers = frame(1, 4 | 8 | 32, 1, join(new Uint8Array([2]), u32(0), new Uint8Array([255, 0x82, 0, 0])));
		const parsed = analyzeHttp2(join(preface, emptySettings, headers), [":method"]);
		expect(parsed.frames[1]!.headerBlock).toEqual(new Uint8Array([0x82]));
		expect(parsed.priorities[0]!.weight).toBe(256);
		expect(parsed.frames[1]!.paddingLength).toBe(2);
		expect(parsed.akamai.components.priorities).toBe("0");
	});

	test("accepts reassembled header continuations and rejects interrupted or incomplete blocks", () => {
		const headers = frame(1, 0, 1, new Uint8Array([0x82]));
		const continuation = frame(9, 4, 1);
		expect(analyzeHttp2(join(preface, emptySettings, headers, continuation), [":method"]).akamai.value).toBe(
			"|0|0|m",
		);
		expect(() => analyzeHttp2(join(preface, emptySettings, headers))).toThrow("missing END_HEADERS");
		expect(() => analyzeHttp2(join(preface, emptySettings, headers, frame(6, 0, 0, new Uint8Array(8))))).toThrow(
			"interrupted",
		);
		expect(() => analyzeHttp2(join(preface, emptySettings, continuation))).toThrow("unexpected CONTINUATION");
	});

	test("rejects truncated prefaces, headers and payloads including trailing fragments", () => {
		expect(() => analyzeHttp2(new Uint8Array())).toThrow(Http2ParseError);
		expect(() => analyzeHttp2(preface)).toThrow("missing initial SETTINGS");
		expect(() => analyzeHttp2(join(preface, emptySettings, new Uint8Array([0])))).toThrow("truncated frame header");
		const full = join(preface, emptySettings, firstHeaders);
		expect(() => analyzeHttp2(full.subarray(0, full.length - 1))).toThrow("truncated frame payload");
	});

	test("rejects malformed mandatory protocol fields", () => {
		const malformed = [
			frame(4, 1, 0, setting(1, 10)),
			frame(4, 0, 1),
			frame(4, 0, 0, new Uint8Array(1)),
			frame(4, 0, 0, setting(2, 2)),
			frame(4, 0, 0, setting(4, 0x80000000)),
			frame(4, 0, 0, setting(5, 10)),
			frame(8, 0, 0, u32(0)),
			frame(2, 0, 1, join(u32(1), new Uint8Array([0]))),
			frame(1, 4, 2),
			frame(0, 0, 0),
			frame(0, 8, 1, new Uint8Array([1])),
			frame(5, 4, 1),
			frame(6, 0, 0),
			frame(7, 0, 0),
			frame(3, 0, 1),
		];
		for (const invalid of malformed)
			expect(() => analyzeHttp2(join(preface, emptySettings, invalid))).toThrow(Http2ParseError);
		expect(() => analyzeHttp2(join(preface, frame(4, 1, 0)))).toThrow("first client frame");
	});

	test("preserves unknown extensions, ignored flags and reserved bits", () => {
		const extension = frame(42, 255, 0x80000000, new Uint8Array([1, 2]));
		const result = analyzeHttp2(join(preface, emptySettings, extension));
		expect(result.frames[1]).toMatchObject({ type: 42, flags: 255, streamId: 0, reserved: true });
		expect(result.frames[1]!.payload).toEqual(new Uint8Array([1, 2]));
	});
});

interface PacketFixture {
	sequence?: number;
	flags?: number;
	payload?: number[];
	options?: number[];
	ipv6?: boolean;
	destinationPort?: number;
}

function ipPacket(options: PacketFixture = {}): Uint8Array {
	const tcpOptions = options.options ?? [];
	if (tcpOptions.length % 4 !== 0) throw new Error("fixture options must be word aligned");
	const ipLength = options.ipv6 ? 40 : 20;
	const tcpLength = 20 + tcpOptions.length;
	const bytes = new Uint8Array(ipLength + tcpLength + (options.payload?.length ?? 0));
	const view = new DataView(bytes.buffer);
	if (options.ipv6) {
		bytes[0] = 0x60;
		view.setUint16(4, bytes.length - 40);
		bytes[6] = 6;
		bytes[7] = 64;
		bytes[23] = 1;
		bytes[39] = 2;
	} else {
		bytes[0] = 0x45;
		view.setUint16(2, bytes.length);
		view.setUint16(4, 123);
		bytes[8] = 64;
		bytes[9] = 6;
		view.setUint16(10, 0xabcd);
		bytes.set([127, 0, 0, 1, 127, 0, 0, 2], 12);
	}
	view.setUint16(ipLength, 50000);
	view.setUint16(ipLength + 2, options.destinationPort ?? 443);
	view.setUint32(ipLength + 4, options.sequence ?? 100);
	bytes[ipLength + 12] = (tcpLength / 4) << 4;
	bytes[ipLength + 13] = options.flags ?? 2;
	view.setUint16(ipLength + 14, 64240);
	view.setUint16(ipLength + 16, 0x1234);
	bytes.set(tcpOptions, ipLength + 20);
	bytes.set(options.payload ?? [], ipLength + tcpLength);
	return bytes;
}

function linkPacket(ip: Uint8Array, linkType: number): Uint8Array {
	const etherType = ip[0]! >>> 4 === 6 ? 0x86dd : 0x0800;
	if (linkType === 101 || linkType === 228 || linkType === 229) return ip;
	const size = linkType === 1 ? 14 : linkType === 113 ? 16 : 20;
	const prefix = new Uint8Array(size);
	new DataView(prefix.buffer).setUint16(linkType === 1 ? 12 : linkType === 113 ? 14 : 0, etherType);
	return join(prefix, ip);
}

function pcap(packets: Uint8Array[], linkType = 101, little = true, nano = false): Uint8Array {
	const header = new Uint8Array(24);
	const view = new DataView(header.buffer);
	view.setUint32(0, nano ? 0xa1b23c4d : 0xa1b2c3d4, little);
	view.setUint16(4, 2, little);
	view.setUint16(6, 4, little);
	view.setUint32(16, 65535, little);
	view.setUint32(20, linkType, little);
	return join(
		header,
		...packets.map((packet, index) => {
			const record = new Uint8Array(16);
			const recordView = new DataView(record.buffer);
			recordView.setUint32(0, 1_700_000_000 + index, little);
			recordView.setUint32(4, 123, little);
			recordView.setUint32(8, packet.length, little);
			recordView.setUint32(12, packet.length, little);
			return join(record, packet);
		}),
	);
}

function clientPackets(fixtures: PacketFixture[]) {
	return summarizeTcpClientFlows(parsePcap(pcap(fixtures.map(ipPacket))), 443)[0]!.packets;
}

describe("AGY PCAP and TCP capture parser", () => {
	test("reads Ethernet, cooked v1/v2 and raw IPv4/IPv6 in both byte orders", () => {
		for (const linkType of [1, 113, 276, 101, 228, 229]) {
			for (const little of [true, false]) {
				const ipv6 = linkType === 229 || linkType === 276;
				const input = pcap([linkPacket(ipPacket({ ipv6 }), linkType)], linkType, little, true);
				const capture = parsePcap(input);
				expect(capture.issues).toEqual([]);
				expect(capture.header.byteOrder).toBe(little ? "little" : "big");
				expect(capture.packets[0]!.timestamp.nanoseconds).toBe(1_700_000_000_000_000_123n);
				expect(capture.packets[0]!.tcp).toMatchObject({ sequence: 100, flags: 2, window: 64240, checksum: 0x1234 });
				expect(capture.packets[0]!.tcp!.raw.buffer).toBe(input.buffer);
			}
		}
	});

	test("preserves SYN option order, timestamps, checksums and named dynamic spans", () => {
		const options = [2, 4, 5, 180, 4, 2, 8, 10, 0, 0, 0, 17, 0, 0, 0, 9, 1, 3, 3, 7];
		const capture = parsePcap(pcap([ipPacket({ options })]));
		const flow = summarizeTcpClientFlows(capture, 443)[0]!;
		const syn = flow.synPackets[0]!;
		expect(syn.options.map(option => option.kind)).toEqual([2, 4, 8, 1, 3]);
		expect(syn.options[0]!.mss).toBe(1460);
		expect(syn.options[2]).toMatchObject({ timestampValue: 17, timestampEcho: 9 });
		expect(syn.options[4]!.windowScale).toBe(7);
		expect(syn.ipChecksum).toBe(0xabcd);
		expect(capture.dynamicFields.some(span => span.reason === "TCP timestamp and echoed timestamp")).toBe(true);
		expect(summarizeTcpClientFlows(capture, 8443)).toEqual([]);
	});

	test("rejects structural truncation and retains packet-level unsupported and malformed reports", () => {
		const full = pcap([ipPacket()]);
		expect(() => parsePcap(full.subarray(0, 23))).toThrow(PcapParseError);
		expect(() => parsePcap(full.subarray(0, full.length - 1))).toThrow("truncated");
		expect(() => parsePcap(join(full, new Uint8Array([1])))).toThrow("truncated");
		expect(parsePcap(pcap([ipPacket()], 999)).issues[0]!.kind).toBe("unsupported");
		const badOption = parsePcap(pcap([ipPacket({ options: [2, 1, 0, 0] })]));
		expect(badOption.packets[0]!.tcp).toBeNull();
		expect(badOption.issues[0]!.message).toContain("option length below 2");
		const fragment = ipPacket();
		new DataView(fragment.buffer).setUint16(6, 0x2000);
		expect(parsePcap(pcap([fragment])).issues[0]!.message).toContain("fragmentation requires IP reassembly");
	});

	test("reports snaplen truncation even when the retained IP packet is parseable", () => {
		const capture = pcap([ipPacket()]);
		new DataView(capture.buffer).setUint32(36, 100, true);
		const parsed = parsePcap(capture);
		expect(parsed.packets[0]!.tcp).not.toBeNull();
		expect(parsed.issues[0]!.kind).toBe("truncated");
	});

	test("never treats empty captures or SYN-only captures as payload evidence", () => {
		expect(summarizeTcpClientFlows(parsePcap(pcap([])), 443)).toEqual([]);
		expect(reassembleTcpPayload([]).status).toBe("unavailable");
		expect(reassembleTcpPayload(clientPackets([{}])).status).toBe("unavailable");
	});

	test("reassembles out-of-order segments and records identical partial retransmissions", () => {
		const result = reassembleTcpPayload(
			clientPackets([
				{},
				{ sequence: 104, flags: 16, payload: [4, 5] },
				{ sequence: 101, flags: 16, payload: [1, 2, 3] },
				{ sequence: 103, flags: 16, payload: [3, 4] },
			]),
		);
		expect(result.status).toBe("complete");
		expect(result.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
		expect(result.chunks).toHaveLength(3);
		expect(result.overlaps).toHaveLength(2);
		expect(result.overlaps.every(overlap => overlap.identical)).toBe(true);
	});

	test("withholds reassembled bytes for gaps, conflict and missing origin evidence", () => {
		const gap = reassembleTcpPayload(clientPackets([{}, { sequence: 103, flags: 16, payload: [3] }]));
		expect(gap.status).toBe("incomplete");
		expect(gap.gaps).toEqual([{ start: 0, end: 2 }]);
		expect(gap.bytes).toBeNull();
		const conflict = reassembleTcpPayload(
			clientPackets([{}, { sequence: 101, flags: 16, payload: [1, 2] }, { sequence: 102, flags: 16, payload: [9] }]),
		);
		expect(conflict.status).toBe("conflict");
		expect(conflict.overlaps[0]!.firstConflictOffset).toBe(1);
		expect(conflict.bytes).toBeNull();
		const noSyn = reassembleTcpPayload(clientPackets([{ sequence: 101, flags: 16, payload: [1] }]));
		expect(noSyn.origin).toBe("first-payload");
		expect(noSyn.status).toBe("incomplete");
		expect(noSyn.bytes).toBeNull();
	});

	test("handles sequence wrap, SYN data and missing bytes before FIN", () => {
		const wrap = reassembleTcpPayload(
			clientPackets([
				{ sequence: 0xfffffffe, payload: [1] },
				{ sequence: 0, flags: 16, payload: [2, 3] },
			]),
		);
		expect(wrap.status).toBe("complete");
		expect(wrap.bytes).toEqual(new Uint8Array([1, 2, 3]));
		const missing = reassembleTcpPayload(
			clientPackets([{}, { sequence: 101, flags: 16, payload: [1] }, { sequence: 104, flags: 17 }]),
		);
		expect(missing.finObserved).toBe(true);
		expect(missing.gaps).toEqual([{ start: 1, end: 3 }]);
		expect(missing.status).toBe("incomplete");
	});

	test("rejects mixed directional tuples and reused connection sequence origins", () => {
		const packets = clientPackets([{}, { sequence: 101, flags: 16, payload: [1] }]);
		const other = { ...packets[1]!, tuple: { ...packets[1]!.tuple, sourcePort: 50001 } };
		expect(reassembleTcpPayload([packets[0]!, other]).issues[0]).toContain("multiple directed TCP tuples");
		const reused = reassembleTcpPayload(
			clientPackets([{}, { sequence: 200 }, { sequence: 101, flags: 16, payload: [1] }]),
		);
		expect(reused.status).toBe("unavailable");
		expect(reused.issues[0]).toContain("multiple SYN sequence");
	});
});

describe("AGY transport boundary regressions", () => {
	test("parses VLAN Ethernet and IPv6 extension headers without treating them as TCP", () => {
		const ipv4 = ipPacket();
		const ethernet = new Uint8Array(18);
		const ethernetView = new DataView(ethernet.buffer);
		ethernetView.setUint16(12, 0x8100);
		ethernetView.setUint16(14, 7);
		ethernetView.setUint16(16, 0x0800);
		expect(parsePcap(pcap([join(ethernet, ipv4)], 1)).packets[0]!.tcp?.sequence).toBe(100);

		const original = ipPacket({ ipv6: true });
		const header = original.slice(0, 40);
		header[6] = 0;
		new DataView(header.buffer).setUint16(4, original.length - 40 + 8);
		const extension = new Uint8Array([6, 0, 0, 0, 0, 0, 0, 0]);
		const capture = parsePcap(pcap([join(header, extension, original.subarray(40))]));
		expect(capture.issues).toEqual([]);
		expect(capture.packets[0]!.tcp?.ipHeaderLength).toBe(48);
		expect(capture.packets[0]!.tcp?.sequence).toBe(100);
	});

	test("rejects impossible PCAP counters, timestamp fractions and truncated IPv6 extensions", () => {
		const badCount = pcap([ipPacket()]);
		new DataView(badCount.buffer).setUint32(36, 1, true);
		expect(() => parsePcap(badCount)).toThrow("captured length exceeds original");
		const badTime = pcap([ipPacket()]);
		new DataView(badTime.buffer).setUint32(28, 1_000_000, true);
		expect(() => parsePcap(badTime)).toThrow("timestamp fraction out of range");
		const ipv6 = ipPacket({ ipv6: true });
		ipv6[6] = 60;
		ipv6[41] = 255;
		const unsupported = parsePcap(pcap([ipv6]));
		expect(unsupported.packets[0]!.tcp).toBeNull();
		expect(unsupported.issues[0]!.kind).toBe("truncated");
	});

	test("retains exact duplicate retransmissions and refuses sequence-space ambiguity", () => {
		const duplicate = reassembleTcpPayload(
			clientPackets([
				{},
				{ sequence: 101, flags: 16, payload: [1, 2] },
				{ sequence: 101, flags: 16, payload: [1, 2] },
			]),
		);
		expect(duplicate.status).toBe("complete");
		expect(duplicate.chunks).toHaveLength(2);
		expect(duplicate.overlaps).toEqual([
			{
				start: 0,
				end: 2,
				packetIndex: 2,
				previousPacketIndex: 1,
				identical: true,
				firstConflictOffset: null,
			},
		]);
		const ambiguous = reassembleTcpPayload(clientPackets([{}, { sequence: 0x80000065, flags: 16, payload: [1] }]));
		expect(ambiguous.status).toBe("incomplete");
		expect(ambiguous.bytes).toBeNull();
		expect(ambiguous.issues[0]).toContain("half-space");
	});
});
