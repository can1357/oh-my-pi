import { describe, expect, test } from "bun:test";
import { compareCaptures, type CompareOptions, type ExclusionFile } from "../scripts/agy-wire/compare";

const subset: CompareOptions = { scope: "application-tls" };
const encoder = new TextEncoder();
interface FixtureOptions {
	body?: string;
	token?: string;
	random?: number;
	sessionLength?: number;
	group?: number;
	key?: number;
	settingValue?: number;
	literalMethod?: boolean;
}
interface FixtureCapture {
	schemaVersion: number;
	alpn: string;
	clientRecordsHex: string;
	clientPlaintextHex: string;
	requests: {
		headers: string[][];
		bodyHex: string;
		streamId?: number;
		method?: string;
		path?: string;
		version?: string;
	}[];
}
function tlsRecords(options: FixtureOptions): Uint8Array {
	const session = Array.from({ length: options.sessionLength ?? 2 }, () => 7);
	const extensions = [0, 51, 0, 9, 0, 7, 0, options.group ?? 29, 0, 3, options.key ?? 8, 8, 8];
	const body = [
		3,
		3,
		...Array.from({ length: 32 }, () => options.random ?? 1),
		session.length,
		...session,
		0,
		2,
		0x13,
		1,
		1,
		0,
		0,
		extensions.length,
		...extensions,
	];
	const hello = [1, 0, 0, body.length, ...body];
	return Uint8Array.from([22, 3, 1, 0, hello.length, ...hello]);
}
function frame(type: number, flags: number, stream: number, payload = new Uint8Array()): Uint8Array {
	const bytes = new Uint8Array(9 + payload.length);
	bytes[0] = payload.length >>> 16;
	bytes[1] = payload.length >>> 8;
	bytes[2] = payload.length;
	bytes[3] = type;
	bytes[4] = flags;
	new DataView(bytes.buffer).setUint32(5, stream);
	bytes.set(payload, 9);
	return bytes;
}
function fixture(options: FixtureOptions = {}): FixtureCapture {
	const body = encoder.encode(options.body ?? "abc");
	const token = options.token ?? "fixture-secret-a";
	// Actual HPACK static indices/literals, without Huffman coding.
	const block = Uint8Array.from([
		...(options.literalMethod ? [2, 4, ...encoder.encode("POST")] : [0x83]),
		0x87,
		0x84,
		1,
		9,
		...encoder.encode("localhost"),
		15,
		8,
		token.length,
		...encoder.encode(token),
	]);
	const settings = new Uint8Array(6);
	new DataView(settings.buffer).setUint16(0, 4);
	new DataView(settings.buffer).setUint32(2, options.settingValue ?? 65535);
	const plaintext = Buffer.concat([
		encoder.encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"),
		frame(4, 0, 0, settings),
		frame(1, 4, 1, block),
		frame(0, 1, 1, body),
	]);
	return {
		schemaVersion: 1,
		alpn: "h2",
		clientRecordsHex: Buffer.from(tlsRecords(options)).toString("hex"),
		clientPlaintextHex: plaintext.toString("hex"),
		requests: [
			{
				streamId: 1,
				headers: [
					[":method", "POST"],
					[":scheme", "https"],
					[":path", "/"],
					[":authority", "localhost"],
					["authorization", token],
				],
				bodyHex: Buffer.from(body).toString("hex"),
			},
		],
	};
}
function http1(options: FixtureOptions = {}, whitespace = " "): FixtureCapture {
	const capture = fixture(options);
	const body = options.body ?? "abc",
		token = options.token ?? "fixture-secret-a";
	capture.alpn = "http/1.1";
	capture.requests = [
		{
			method: "POST",
			path: "/",
			version: "HTTP/1.1",
			headers: [
				["Host", "localhost"],
				["Authorization", token],
				["Content-Length", String(Buffer.byteLength(body))],
			],
			bodyHex: Buffer.from(body).toString("hex"),
		},
	];
	capture.clientPlaintextHex = Buffer.from(
		`POST / HTTP/1.1\r\nHost:${whitespace}localhost\r\nAuthorization: ${token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
	).toString("hex");
	return capture;
}
function chunked(
	body = "abc",
	encoded = `1;fixture=yes\r\n${body.slice(0, 1)}\r\n2\r\n${body.slice(1)}\r\n0\r\nX-Proof: fixture\r\n\r\n`,
): FixtureCapture {
	const capture = http1({ body });
	capture.requests[0]!.headers[2] = ["Transfer-Encoding", "chunked"];
	capture.clientPlaintextHex = Buffer.from(
		`POST / HTTP/1.1\r\nHost: localhost\r\nAuthorization: fixture-secret-a\r\nTransfer-Encoding: chunked\r\n\r\n${encoded}`,
	).toString("hex");
	return capture;
}
function exclusion(field: "body" | "header", offset: number, length: number, headerIndex?: number): ExclusionFile {
	const spans = [{ offset, length, reason: "explicit fixture nonce" }];
	return {
		schemaVersion: 1,
		requests: [
			{
				requestIndex: 0,
				field,
				...(headerIndex === undefined ? {} : { headerIndex }),
				reference: spans,
				candidate: structuredClone(spans),
			},
		],
	};
}
function pcap(records: Uint8Array, ttl = 64, gap = 0, sourcePort = 50000): Uint8Array {
	const header = new Uint8Array(24);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0xa1b2c3d4, true);
	view.setUint16(4, 2, true);
	view.setUint16(6, 4, true);
	view.setUint32(16, 65535, true);
	view.setUint32(20, 101, true);
	const packets = [new Uint8Array(), records].map((payload, index) => {
		const packet = new Uint8Array(40 + payload.length);
		const ip = new DataView(packet.buffer);
		packet[0] = 0x45;
		ip.setUint16(2, packet.length);
		packet[8] = ttl;
		packet[9] = 6;
		packet.set([127, 0, 0, 1, 127, 0, 0, 1], 12);
		ip.setUint16(20, sourcePort);
		ip.setUint16(22, 18443);
		ip.setUint32(24, index === 0 ? 100 : 101 + gap);
		packet[32] = 0x50;
		packet[33] = index === 0 ? 2 : 24;
		ip.setUint16(34, 65535);
		packet.set(payload, 40);
		const record = new Uint8Array(16);
		const entry = new DataView(record.buffer);
		entry.setUint32(0, 1700000000 + index, true);
		entry.setUint32(8, packet.length, true);
		entry.setUint32(12, packet.length, true);
		return Buffer.concat([record, packet]);
	});
	return Buffer.concat([header, ...packets]);
}

describe("AGY measured comparison", () => {
	test("default all-layer evaluation cannot pass without transport; subset must be explicit", () => {
		const reference = fixture(),
			candidate = fixture({ random: 2, key: 9 });
		const all = compareCaptures(reference, candidate);
		expect(all.exitCode).toBe(2);
		expect(all.scopes.tcp).toMatchObject({ state: "unavailable", required: true });
		const report = compareCaptures(reference, candidate, subset);
		expect(report.exitCode).toBe(0);
		expect(report.raw.clientHello.state).toBe("mismatch");
		expect(report.raw.clientHello.firstDifference).toBe(6);
		expect(report.raw.clientHello.reference?.sha256).toHaveLength(64);
		expect(report.raw.tlsRecords.state).toBe("mismatch");
		expect(report.scopes.clientHello?.state).toBe("match");
		expect(report.attestation).toBe("unverified");
		expect(report.scopes.tcp?.state).toBe("unavailable");
	});

	test("matching JA3 does not hide changed key-share group or dynamic span lengths", () => {
		const reference = fixture();
		for (const candidate of [fixture({ group: 23 }), fixture({ sessionLength: 3 })]) {
			const report = compareCaptures(reference, candidate, subset);
			expect(report.exitCode).toBe(1);
			expect(report.scopes.clientHello?.state).toBe("mismatch");
			const evidence = report.scopes.clientHello?.evidence as {
				reference: { ja3: { hash: string } };
				candidate: { ja3: { hash: string } };
				spanLayoutsEqual: boolean;
			};
			expect(evidence.reference.ja3.hash).toBe(evidence.candidate.ja3.hash);
			expect(evidence.spanLayoutsEqual).toBe(false);
		}
	});

	test("missing requests or inconsistent DATA evidence cannot pass with identical plaintext", () => {
		const reference = fixture(),
			missing = fixture(),
			inconsistent = fixture();
		missing.requests = [];
		inconsistent.requests[0]!.bodyHex = "78797a";
		expect(compareCaptures(reference, missing, subset).exitCode).toBe(2);
		expect(compareCaptures(reference, inconsistent, subset).exitCode).toBe(2);
	});

	test("body byte mismatch fails even when all transport fingerprints match", () => {
		const report = compareCaptures(fixture(), fixture({ body: "abd" }), subset);
		expect(report.exitCode).toBe(1);
		expect(report.scopes.http2Structure?.state).toBe("match");
		expect(report.scopes.requests?.state).toBe("mismatch");
		expect(report.raw.requests[0]!.body.firstDifference).toBe(2);
	});

	test("explicit paired body exclusion changes only normalized result, retaining raw hashes", () => {
		const report = compareCaptures(fixture(), fixture({ body: "abd" }), {
			...subset,
			exclusions: exclusion("body", 2, 1),
		});
		expect(report.exitCode).toBe(0);
		expect(report.raw.requests[0]!.body.state).toBe("mismatch");
		expect(report.raw.http2Plaintext.state).toBe("mismatch");
		expect(report.raw.requests[0]!.normalized).toBe("match");
	});

	test("paired header value exclusions preserve raw HPACK and never print credential contents", () => {
		const report = compareCaptures(fixture(), fixture({ token: "fixture-secret-b" }), {
			...subset,
			exclusions: exclusion("header", 15, 1, 4),
		});
		expect(report.exitCode).toBe(0);
		expect(report.scopes.hpackRaw?.state).toBe("mismatch");
		expect(report.raw.requests[0]!.orderedHeaders.state).toBe("mismatch");
		expect(JSON.stringify(report)).not.toContain("fixture-secret");
	});

	test("out-of-bounds, overlapping, asymmetric and missing-target exclusions fail closed", () => {
		const asymmetric = exclusion("body", 0, 1);
		asymmetric.requests[0]!.candidate[0]!.reason = "different explanation";
		const overlap = exclusion("body", 0, 2);
		overlap.requests[0]!.reference.push({ offset: 1, length: 1, reason: "overlap" });
		overlap.requests[0]!.candidate = structuredClone(overlap.requests[0]!.reference);
		const missing = exclusion("body", 0, 1);
		missing.requests[0]!.requestIndex = 2;
		const shifted = exclusion("body", 0, 1);
		shifted.requests[0]!.candidate[0]!.offset = 1;
		const cases = [
			exclusion("body", 3, 1),
			overlap,
			asymmetric,
			missing,
			shifted,
			exclusion("header", 0, 1, 99),
			{ schemaVersion: 1, requests: [], regex: ".*" },
		];
		for (const exclusions of cases) {
			const report = compareCaptures(fixture(), fixture(), { ...subset, exclusions });
			expect(report.exitCode).toBe(2);
			expect(report.scopes.exclusions?.state).toBe("unavailable");
		}
	});

	test("changed H2 setting or encoded frame length is not hidden by equal decoded requests", () => {
		for (const candidate of [fixture({ settingValue: 65536 }), fixture({ literalMethod: true })]) {
			const report = compareCaptures(fixture(), candidate, subset);
			expect(report.scopes.requests?.state).toBe("match");
			expect(report.scopes.http2Structure?.state).toBe("mismatch");
			expect(report.raw.http2Plaintext.state).toBe("mismatch");
			expect(report.exitCode).toBe(1);
		}
	});

	test("malformed trailing TLS record cannot be accepted from a valid initial ClientHello", () => {
		const candidate = fixture();
		candidate.clientRecordsHex += "17030300";
		const report = compareCaptures(fixture(), candidate, subset);
		expect(report.exitCode).toBe(2);
		expect(report.scopes.clientHello?.state).toBe("unavailable");
		expect(report.raw.tlsRecords.state).toBe("mismatch");
	});

	test("observed HTTP1 does not invent an H2 fingerprint and preserves raw whitespace differences", () => {
		const report = compareCaptures(http1(), http1({ random: 2 }), subset);
		expect(report.exitCode).toBe(0);
		expect(report.scopes.http2Structure?.state).toBe("not-applicable");
		expect(report.raw.http1Plaintext.state).toBe("match");
		const differentWhitespace = compareCaptures(http1(), http1({}, "  "), subset);
		expect(differentWhitespace.scopes.requests?.state).toBe("match");
		expect(differentWhitespace.scopes.http1Plaintext?.state).toBe("mismatch");
		expect(differentWhitespace.exitCode).toBe(1);
	});

	test("HTTP1 projects only explicitly excluded body and header value bytes into raw plaintext", () => {
		const exclusions = exclusion("header", 15, 1, 1);
		exclusions.requests.push(exclusion("body", 2, 1).requests[0]!);
		const report = compareCaptures(http1(), http1({ token: "fixture-secret-b", body: "abd" }), {
			...subset,
			exclusions,
		});
		expect(report.exitCode).toBe(0);
		expect(report.raw.http1Plaintext.state).toBe("mismatch");
		expect(report.scopes.http1Plaintext?.state).toBe("match");
		const shifted = compareCaptures(http1(), http1({ token: "fixture-secret-b", body: "abd" }, "  "), {
			...subset,
			exclusions,
		});
		expect(shifted.exitCode).toBe(1);
	});

	test("chunked HTTP1 preserves framing and projects an explicit body span across chunks", () => {
		const reference = chunked(),
			candidate = chunked("xyz");
		expect(compareCaptures(reference, reference, subset).exitCode).toBe(0);
		expect(compareCaptures(reference, candidate, subset).exitCode).toBe(1);
		const report = compareCaptures(reference, candidate, { ...subset, exclusions: exclusion("body", 0, 3) });
		expect(report.exitCode).toBe(0);
		expect(report.raw.http1Plaintext.state).toBe("mismatch");
		const resegmented = chunked("xyz", "3\r\nxyz\r\n0\r\nX-Proof: fixture\r\n\r\n");
		expect(compareCaptures(reference, resegmented, { ...subset, exclusions: exclusion("body", 0, 3) }).exitCode).toBe(
			1,
		);
	});

	test("chunk size errors, missing terminators, forbidden trailers and ambiguous framing are unavailable", () => {
		for (const encoded of [
			"Z\r\nabc\r\n0\r\n\r\n",
			"3\r\nabc\r\n",
			"3\r\nabcXX0\r\n\r\n",
			"3\r\nabc\r\n0\r\nContent-Length: 3\r\n\r\n",
		]) {
			expect(compareCaptures(chunked(), chunked("abc", encoded), subset).exitCode).toBe(2);
		}
		const ambiguous = chunked();
		ambiguous.requests[0]!.headers.push(["Content-Length", "3"]);
		ambiguous.clientPlaintextHex = Buffer.from(
			Buffer.from(ambiguous.clientPlaintextHex, "hex")
				.toString()
				.replace("Transfer-Encoding: chunked\r\n", "Transfer-Encoding: chunked\r\nContent-Length: 3\r\n"),
		).toString("hex");
		expect(compareCaptures(chunked(), ambiguous, subset).exitCode).toBe(2);
	});

	test("PCAP evidence binds to each capture but does not compare randomized encrypted-stream bytes across peers", () => {
		const reference = fixture(),
			candidate = fixture({ random: 2 });
		const referencePcap = pcap(Buffer.from(reference.clientRecordsHex, "hex"));
		const candidatePcap = pcap(Buffer.from(candidate.clientRecordsHex, "hex"));
		const report = compareCaptures(reference, candidate, { referencePcap, candidatePcap });
		expect(report.exitCode).toBe(0);
		expect(report.raw.pcap.state).toBe("mismatch");
		expect(report.scopes.tcp?.state).toBe("match");
		expect(report.attestation).toBe("unverified");
		const wrongBinding = compareCaptures(reference, candidate, { referencePcap, candidatePcap: referencePcap });
		expect(wrongBinding.exitCode).toBe(2);
	});

	test("multi-flow PCAP selects unique captured TLS bytes rather than first-flow order", () => {
		const capture = fixture(),
			records = Buffer.from(capture.clientRecordsHex, "hex");
		const unrelated = pcap(tlsRecords({ random: 9 }), 63, 0, 50001);
		const selected = pcap(records);
		const multi = Buffer.concat([unrelated, selected.subarray(24)]);
		const report = compareCaptures(capture, capture, { referencePcap: multi, candidatePcap: selected });
		expect(report.exitCode).toBe(0);
		const evidence = report.scopes.tcp?.evidence as {
			reference: { selectedTuple: { sourcePort: number }; omittedUnrelatedFlowCount: number; flows: unknown[] };
		};
		expect(evidence.reference.selectedTuple.sourcePort).toBe(50000);
		expect(evidence.reference.omittedUnrelatedFlowCount).toBe(1);
		expect(evidence.reference.flows).toHaveLength(2);
		expect(report.raw.pcap.state).toBe("mismatch");
	});

	test("duplicate matching flows remain ambiguous and damaged selected evidence cannot pass", () => {
		const capture = fixture(),
			records = Buffer.from(capture.clientRecordsHex, "hex");
		const selected = pcap(records);
		const duplicate = Buffer.concat([selected, pcap(records, 64, 0, 50001).subarray(24)]);
		expect(compareCaptures(capture, capture, { referencePcap: duplicate, candidatePcap: selected }).exitCode).toBe(2);
		const damaged = selected.slice();
		// Original packet size exceeds captured size: retained capture issue, not a clean SYN.
		new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength).setUint32(36, 41, true);
		const multi = Buffer.concat([pcap(tlsRecords({ random: 9 }), 64, 0, 50001), damaged.subarray(24)]);
		expect(compareCaptures(capture, capture, { referencePcap: multi, candidatePcap: selected }).exitCode).toBe(2);
	});

	test("CONNECT flow selection requires captured authority and a complete valid prefix before TLS", () => {
		const base = fixture();
		const capture = { ...base, connectAuthority: "fixture.invalid:443" };
		const prefix = Buffer.from(
			"CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\nProxy-Authorization: fixture-proxy-secret\r\n\r\n",
		);
		const tunneled = pcap(Buffer.concat([prefix, Buffer.from(base.clientRecordsHex, "hex")]));
		const unrelated = pcap(tlsRecords({ random: 9 }), 64, 0, 50001);
		const multi = Buffer.concat([unrelated, tunneled.subarray(24)]);
		const report = compareCaptures(capture, capture, { referencePcap: multi, candidatePcap: tunneled });
		expect(report.exitCode).toBe(0);
		expect(JSON.stringify(report)).not.toContain("fixture-proxy-secret");
		expect(compareCaptures(base, base, { referencePcap: multi, candidatePcap: tunneled }).exitCode).toBe(2);
		const wrongAuthority = { ...base, connectAuthority: "other.invalid:443" };
		expect(
			compareCaptures(wrongAuthority, wrongAuthority, { referencePcap: multi, candidatePcap: tunneled }).exitCode,
		).toBe(2);
		const malformed = pcap(
			Buffer.concat([
				Buffer.from("CONNECT fixture.invalid:443 HTTP/1.1\r\nMalformed\r\n\r\n"),
				Buffer.from(base.clientRecordsHex, "hex"),
			]),
		);
		expect(compareCaptures(capture, capture, { referencePcap: malformed, candidatePcap: tunneled }).exitCode).toBe(2);
	});

	test("observed TTL mismatch fails and sequence gaps or one missing PCAP are unavailable", () => {
		const capture = fixture(),
			records = Buffer.from(capture.clientRecordsHex, "hex");
		const referencePcap = pcap(records);
		expect(compareCaptures(capture, capture, { referencePcap, candidatePcap: pcap(records, 63) }).exitCode).toBe(1);
		expect(compareCaptures(capture, capture, { referencePcap, candidatePcap: pcap(records, 64, 2) }).exitCode).toBe(
			2,
		);
		expect(compareCaptures(capture, capture, { ...subset, referencePcap }).exitCode).toBe(2);
	});
});
