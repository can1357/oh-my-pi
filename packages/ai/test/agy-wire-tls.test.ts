import { describe, expect, it } from "bun:test";
import {
	extractClientHelloFromRecords,
	isGrease,
	ja3,
	ja4,
	parseClientHello,
	TlsParseError,
} from "../scripts/agy-wire/tls";

function u16(value: number): number[] {
	return [value >>> 8, value & 255];
}

function vector16(bytes: number[]): number[] {
	return [...u16(bytes.length), ...bytes];
}

function extension(type: number, data: number[]): number[] {
	return [...u16(type), ...vector16(data)];
}

function hello(
	options: {
		version?: number;
		ciphers?: number[];
		extensions?: number[][];
		sessionId?: number[];
		compression?: number[];
		omitExtensions?: boolean;
	} = {},
): Uint8Array {
	const session = options.sessionId ?? [0x71, 0x72];
	const compression = options.compression ?? [0];
	const body = [
		...u16(options.version ?? 0x0303),
		...Array.from({ length: 32 }, () => 0x42),
		session.length,
		...session,
		...vector16((options.ciphers ?? [0x1301]).flatMap(u16)),
		compression.length,
		...compression,
		...(options.omitExtensions ? [] : vector16((options.extensions ?? []).flat())),
	];
	return Uint8Array.from([1, body.length >>> 16, (body.length >>> 8) & 255, body.length & 255, ...body]);
}

function record(payload: Uint8Array, type = 22): Uint8Array {
	return Uint8Array.from([type, 3, 1, ...u16(payload.length), ...payload]);
}

function join(...parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

const sni = extension(0, vector16([0, ...vector16([101, 120, 97, 109, 112, 108, 101])]));
const groups = extension(10, vector16([0x0a, 0x0a, 0, 29, 0, 23]));
const points = extension(11, [1, 0]);
const versions = extension(43, [6, 0x2a, 0x2a, 3, 4, 3, 3]);
const signatures = extension(13, vector16([4, 3, 8, 4]));
const alpn = extension(16, vector16([2, 104, 50, 8, 104, 116, 116, 112, 47, 49, 46, 49]));
const keyShare = extension(51, vector16([0, 29, ...vector16([0xab, 0xcd, 0xef])]));

function detailedHello(): Uint8Array {
	return hello({
		ciphers: [0x0a0a, 0x1301, 0x1302],
		extensions: [sni, groups, points, versions, signatures, alpn, keyShare, extension(0x1a1a, [9])],
	});
}

describe("ClientHello parsing and explicit dynamic spans", () => {
	it("keeps raw order and GREASE while marking only random, session ID and key bytes", () => {
		const input = detailedHello();
		const original = input.slice();
		const parsed = parseClientHello(input);
		expect(parsed.raw).toBe(input);
		expect(input).toEqual(original);
		expect(parsed.protocolVersion).toBe(0x0303);
		expect(parsed.cipherSuites).toEqual([0x0a0a, 0x1301, 0x1302]);
		expect(parsed.extensions.map(value => value.type)).toEqual([0, 10, 11, 43, 13, 16, 51, 0x1a1a]);
		expect(parsed.extensions.at(-1)!.data).toEqual(Uint8Array.of(9));
		expect(parsed.supportedGroups).toEqual([0x0a0a, 29, 23]);
		expect(parsed.ecPointFormats).toEqual([0]);
		expect(parsed.supportedVersions).toEqual([0x2a2a, 0x0304, 0x0303]);
		expect(parsed.signatureAlgorithms).toEqual([0x0403, 0x0804]);
		expect(parsed.alpn).toEqual([Uint8Array.of(104, 50), new TextEncoder().encode("http/1.1")]);
		const keyOffset = parsed.extensions.find(value => value.type === 51)!.offset + 10;
		expect(parsed.dynamicSpans).toEqual([
			{ offset: 6, length: 32, reason: "ClientHello random" },
			{ offset: 39, length: 2, reason: "ClientHello session ID" },
			{ offset: keyOffset, length: 3, reason: "key_share key exchange (group 0x001d)" },
		]);
		expect(input.subarray(keyOffset - 4, keyOffset)).toEqual(Uint8Array.of(0, 29, 0, 3));
		expect(parsed.keyShares).toEqual([{ group: 29, keyExchange: Uint8Array.of(0xab, 0xcd, 0xef) }]);
		for (const bytes of [
			parsed.random,
			parsed.sessionId,
			parsed.extensions[0]!.data,
			parsed.keyShares[0]!.keyExchange,
		])
			expect(bytes.buffer).toBe(input.buffer);
	});

	it("interprets offsets relative to a supplied subarray rather than its underlying buffer", () => {
		const message = detailedHello();
		const backing = join(new Uint8Array(11), message, new Uint8Array(7));
		const parsed = parseClientHello(backing.subarray(11, 11 + message.length));
		expect(parsed.dynamicSpans[0]!.offset).toBe(6);
		expect(parsed.random.byteOffset).toBe(backing.byteOffset + 17);
	});

	it("accepts omitted legacy extensions, an empty session ID and an empty TLS 1.3 key-share list", () => {
		const legacy = parseClientHello(hello({ omitExtensions: true, sessionId: [] }));
		expect(legacy.extensions).toEqual([]);
		expect(legacy.dynamicSpans).toHaveLength(1);
		expect(parseClientHello(hello({ extensions: [extension(51, [0, 0])] })).keyShares).toEqual([]);
	});

	it("rejects every truncated handshake prefix rather than emitting partial evidence", () => {
		const bytes = detailedHello();
		for (let length = 0; length < bytes.length; length++)
			expect(() => parseClientHello(bytes.subarray(0, length))).toThrow(TlsParseError);
	});

	it("rejects trailing handshake bytes and record envelopes supplied to the handshake parser", () => {
		const bytes = detailedHello();
		expect(() => parseClientHello(join(bytes, Uint8Array.of(0)))).toThrow("Trailing bytes after ClientHello");
		expect(() => parseClientHello(record(bytes))).toThrow("Expected ClientHello");
	});

	it("rejects invalid fixed-field vectors", () => {
		expect(() => parseClientHello(hello({ sessionId: Array.from({ length: 33 }, () => 0) }))).toThrow("Session ID");
		expect(() => parseClientHello(hello({ ciphers: [] }))).toThrow("cipher_suites");
		expect(() => parseClientHello(hello({ compression: [] }))).toThrow("compression_methods");
		const oddCiphers = hello();
		oddCiphers[42] = 1;
		expect(() => parseClientHello(oddCiphers)).toThrow("cipher_suites");
	});

	it.each([
		["odd supported groups", extension(10, [0, 1, 29])],
		["empty point formats", extension(11, [0])],
		["odd signature algorithms", extension(13, [0, 1, 4])],
		["empty supported versions", extension(43, [0])],
		["nested version overrun", extension(43, [4, 3, 4])],
		["trailing extension data", extension(43, [2, 3, 4, 0])],
		["empty ALPN list", extension(16, [0, 0])],
		["empty ALPN protocol", extension(16, [0, 1, 0])],
		["ALPN entry overrun", extension(16, [0, 2, 2, 104])],
		["empty SNI list", extension(0, [0, 0])],
		["SNI entry overrun", extension(0, [0, 4, 0, 0, 2, 97])],
		["empty key exchange", extension(51, [0, 4, 0, 29, 0, 0])],
		["key exchange overrun", extension(51, [0, 5, 0, 29, 0, 2, 1])],
		["odd certificate signature algorithms", extension(50, [0, 1, 4])],
	] as [string, number[]][])("rejects %s inside an otherwise complete handshake", (_label, bytes) => {
		expect(() => parseClientHello(hello({ extensions: [bytes] }))).toThrow(TlsParseError);
	});

	it("rejects duplicate known and unknown extensions and repeated key-share groups", () => {
		expect(() => parseClientHello(hello({ extensions: [versions, versions] }))).toThrow("Duplicate extension");
		expect(() => parseClientHello(hello({ extensions: [extension(0xbeef, []), extension(0xbeef, [])] }))).toThrow(
			"Duplicate extension",
		);
		const entry = [0, 29, ...vector16([1])];
		expect(() => parseClientHello(hello({ extensions: [extension(51, vector16([...entry, ...entry]))] }))).toThrow(
			"Duplicate key_share",
		);
		const name = [0, ...vector16([97])];
		expect(() => parseClientHello(hello({ extensions: [extension(0, vector16([...name, ...name]))] }))).toThrow(
			"Duplicate server_name",
		);
	});

	it("validates PSK identity/binder framing and position without excluding ticket or binder bytes", () => {
		const identities = vector16([...vector16([7]), 0, 0, 0, 1]);
		const psk = extension(41, [...identities, ...vector16([32, ...Array.from({ length: 32 }, () => 8)])]);
		const parsed = parseClientHello(hello({ extensions: [versions, psk] }));
		expect(parsed.dynamicSpans).toHaveLength(2);
		expect(() => parseClientHello(hello({ extensions: [psk, versions] }))).toThrow("final extension");
		expect(() => parseClientHello(hello({ extensions: [extension(41, [...identities, 0, 0])] }))).toThrow(
			"count mismatch",
		);
		expect(() => parseClientHello(hello({ extensions: [extension(41, [...identities, 0, 2, 1, 7])] }))).toThrow(
			"shorter than 32",
		);
	});
});

describe("TLS record extraction", () => {
	it("reassembles every split point, including splits inside the four-byte handshake header", () => {
		const bytes = detailedHello();
		for (let split = 1; split < bytes.length; split++) {
			const wire = join(record(bytes.subarray(0, split)), record(bytes.subarray(split)));
			const extracted = extractClientHelloFromRecords(wire);
			expect(extracted.handshake).toEqual(bytes);
			expect(extracted.bytesConsumed).toBe(wire.length);
			for (const fragment of extracted.fragments) {
				expect(wire.subarray(fragment.inputOffset, fragment.inputOffset + fragment.length)).toEqual(
					bytes.subarray(fragment.handshakeOffset, fragment.handshakeOffset + fragment.length),
				);
				expect(fragment.recordVersion).toBe(0x0301);
			}
		}
	});

	it("skips complete earlier handshakes and boundary CCS, and stops at the first complete hello", () => {
		const bytes = detailedHello();
		const earlier = Uint8Array.of(0, 0, 0, 0, 2, 0, 0, 1, 9);
		const wire = join(
			record(earlier),
			record(Uint8Array.of(1), 20),
			record(join(bytes, Uint8Array.of(2))),
			Uint8Array.of(22),
		);
		const extracted = extractClientHelloFromRecords(wire);
		expect(extracted.handshake).toEqual(bytes);
		expect(extracted.bytesConsumed).toBe(wire.length - 1);
	});

	it("rejects all truncated record-stream prefixes and complete records containing a partial handshake", () => {
		const bytes = detailedHello();
		const wire = join(record(bytes.subarray(0, 2)), record(bytes.subarray(2)));
		for (let length = 0; length < wire.length; length++)
			expect(() => extractClientHelloFromRecords(wire.subarray(0, length))).toThrow(TlsParseError);
		expect(() => extractClientHelloFromRecords(record(bytes.subarray(0, bytes.length - 1)))).toThrow(
			"Truncated TLS handshake",
		);
	});

	it("rejects encrypted or interrupted input, invalid record framing and missing ClientHello", () => {
		expect(() => extractClientHelloFromRecords(record(Uint8Array.of(1), 23))).toThrow("Non-handshake");
		expect(() => extractClientHelloFromRecords(join(record(Uint8Array.of(1)), record(Uint8Array.of(1), 20)))).toThrow(
			"Non-handshake",
		);
		expect(() => extractClientHelloFromRecords(record(new Uint8Array()))).toThrow("Empty handshake record");
		expect(() => extractClientHelloFromRecords(record(new Uint8Array(16385)))).toThrow("exceeds 16384");
		expect(() => extractClientHelloFromRecords(record(Uint8Array.of(0, 0, 0, 0)))).toThrow("No ClientHello");
		const badVersion = record(detailedHello());
		badVersion[2] = 4;
		expect(() => extractClientHelloFromRecords(badVersion)).toThrow("record version");
		expect(() => extractClientHelloFromRecords(record(Uint8Array.of(1, 0, 0, 0)))).toThrow(TlsParseError);
	});
});

describe("published JA3 and JA4 algorithms", () => {
	// Salesforce README's two published raw/hash pairs, not captured AGY fingerprints.
	it("matches both Salesforce JA3 example vectors including omitted extensions", () => {
		const withExtensions = parseClientHello(
			hello({
				version: 769,
				ciphers: [47, 53, 5, 10, 49161, 49162, 49171, 49172, 50, 56, 19, 4],
				extensions: [sni, extension(10, vector16([23, 24, 25].flatMap(u16))), points],
			}),
		);
		expect(ja3(withExtensions)).toEqual({
			raw: "769,47-53-5-10-49161-49162-49171-49172-50-56-19-4,0-10-11,23-24-25,0",
			hash: "ada70206e40642a3e4461f35503241d5",
		});
		const without = parseClientHello(
			hello({ version: 769, ciphers: [4, 5, 10, 9, 100, 98, 3, 6, 19, 18, 99], omitExtensions: true }),
		);
		expect(ja3(without)).toEqual({
			raw: "769,4-5-10-9-100-98-3-6-19-18-99,,,",
			hash: "de350869b8c85de67a350c8d186f11e6",
		});
	});

	it("matches FoxIO's published JA4 cipher, extension and full fingerprint vectors", () => {
		const signatureBytes = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601].flatMap(u16);
		const parsed = parseClientHello(
			hello({
				ciphers: [
					0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d,
					0x002f, 0x0035,
				],
				extensions: [
					extension(27, []),
					sni,
					keyShare,
					alpn,
					extension(0x4469, []),
					extension(23, []),
					extension(45, [1, 1]),
					extension(13, vector16(signatureBytes)),
					extension(5, []),
					extension(35, []),
					extension(18, []),
					versions,
					extension(0xff01, [0]),
					points,
					groups,
					extension(21, []),
				],
			}),
		);
		const fingerprint = ja4(parsed);
		expect(fingerprint.hash).toBe("t13d1516h2_8daaf6152771_e5627efa2ab1");
		expect(fingerprint.cipherInput).toBe(
			"002f,0035,009c,009d,1301,1302,1303,c013,c014,c02b,c02c,c02f,c030,cca8,cca9",
		);
		expect(fingerprint.extensionInput).toBe(
			"0005,000a,000b,000d,0012,0015,0017,001b,0023,002b,002d,0033,4469,ff01_0403,0804,0401,0503,0805,0501,0806,0601",
		);
		expect(fingerprint.raw).toBe(`t13d1516h2_${fingerprint.cipherInput}_${fingerprint.extensionInput}`);
		expect(fingerprint.rawOriginal).toBe(
			"t13d1516h2_1301,1302,1303,c02b,c02f,c02c,c030,cca9,cca8,c013,c014,009c,009d,002f,0035_001b,0000,0033,0010,4469,0017,002d,000d,0005,0023,0012,002b,ff01,000b,000a,0015_0403,0804,0401,0503,0805,0501,0806,0601",
		);
		// The spec also publishes this extension-only hash without signature values.
		expect(ja4({ ...parsed, signatureAlgorithms: [] }).extensionHash).toBe("6d807ffa2a79");
	});

	it("filters precisely GREASE for fingerprints, without mutating raw evidence or removing SCSV", () => {
		for (let value = 0x0a0a; value <= 0xfafa; value += 0x1010) expect(isGrease(value)).toBe(true);
		for (const value of [0x0a1a, 0x1a0a, 0xffff, 0x10000, -1]) expect(isGrease(value)).toBe(false);
		const parsed = parseClientHello(
			hello({
				ciphers: [0x0a0a, 0x00ff, 0x5600, 0xfe00],
				extensions: [groups, extension(0x2a2a, [9]), extension(13, vector16([0x3a3a, 0x0403].flatMap(u16)))],
			}),
		);
		expect(ja3(parsed).raw).toBe("771,255-22016-65024,10-13,29-23,");
		expect(ja4(parsed).cipherInput).toBe("00ff,5600,fe00");
		expect(ja4(parsed).extensionInput).toBe("000a,000d_0403");
		expect(parsed.cipherSuites[0]).toBe(0x0a0a);
		expect(parsed.extensions[1]!.type).toBe(0x2a2a);
	});

	it.each([
		[[0xab], "ab"],
		[[0x20], "20"],
		[[0xab, 0xcd], "ad"],
		[[0x20, 0x61], "21"],
		[[0x30, 0xab], "3b"],
		[[0x61, 0x20], "60"],
		[[0x30, 0x31, 0xab, 0xcd], "3d"],
		[[0x30, 0xab, 0xcd, 0x31], "01"],
		[[0x68], "hh"],
	] as [number[], string][])("uses FoxIO ALPN byte rule for %j", (protocol, expected) => {
		const parsed = parseClientHello(hello({ extensions: [extension(16, vector16([protocol.length, ...protocol]))] }));
		expect(ja4(parsed).hash.split("_")[0]).toBe(`t12i0101${expected}`);
	});

	it("uses supported versions rather than legacy version, preserves unknown versions and identifies QUIC only when requested", () => {
		const onlyGrease = parseClientHello(hello({ extensions: [extension(43, [2, 0x1a, 0x1a])] }));
		expect(ja4(onlyGrease).hash.startsWith("t00")).toBe(true);
		const unknown = parseClientHello(hello({ extensions: [extension(43, [4, 3, 4, 3, 5])] }));
		expect(ja4(unknown).hash.startsWith("t00")).toBe(true);
		expect(ja4(parseClientHello(detailedHello()), "q").hash.startsWith("q13")).toBe(true);
	});

	it("sorts only JA4 cipher/extension inputs, preserving signature order and JA3 wire order", () => {
		const first = parseClientHello(hello({ ciphers: [0x1302, 0x1301], extensions: [groups, signatures, points] }));
		const reordered = parseClientHello(
			hello({ ciphers: [0x1301, 0x1302], extensions: [points, groups, signatures] }),
		);
		expect(ja4(first).hash).toBe(ja4(reordered).hash);
		expect(ja3(first).hash).not.toBe(ja3(reordered).hash);
		expect(ja4(first).rawOriginal).not.toBe(ja4(reordered).rawOriginal);
		const changedSignatures = parseClientHello(
			hello({ ciphers: [0x1302, 0x1301], extensions: [groups, extension(13, vector16([8, 4, 4, 3])), points] }),
		);
		expect(ja4(changedSignatures).extensionInput).toBe("000a,000b,000d_0804,0403");
		expect(ja4(changedSignatures).extensionHash).not.toBe(ja4(first).extensionHash);
	});

	it("emits zero cipher hashes when the wire cipher list contains only GREASE", () => {
		const parsed = parseClientHello(hello({ ciphers: [0x0a0a, 0x1a1a], omitExtensions: true }));
		expect(ja4(parsed).hash).toBe("t12i000000_000000000000_000000000000");
		expect(ja3(parsed).raw).toBe("771,,,,");
	});

	it("uses zero extension hashes for SNI/ALPN-only lists and caps count fields at 99", () => {
		const parsed = parseClientHello(hello({ extensions: [sni, alpn] }));
		expect(ja4(parsed).extensionHash).toBe("000000000000");
		expect(ja4(parsed).hash.startsWith("t12d0102h2_")).toBe(true);
		const many = parseClientHello(
			hello({
				ciphers: Array.from({ length: 101 }, (_, index) => index + 1),
				extensions: Array.from({ length: 100 }, (_, index) => extension(0x1000 + index, [])),
			}),
		);
		expect(ja4(many).hash.startsWith("t12i999900_")).toBe(true);
		const absent = parseClientHello(hello({ omitExtensions: true }));
		expect(ja4(absent).extensionInput).toBe("");
		expect(ja4(absent).extensionHash).toBe("000000000000");
	});
});
