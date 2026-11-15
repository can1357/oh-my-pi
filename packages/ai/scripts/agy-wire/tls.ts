// Algorithms: https://github.com/salesforce/ja3#how-it-works
// https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md
// Fingerprints describe observable ClientHello features, not client identity or attestation.

export interface DynamicSpan {
	offset: number;
	length: number;
	reason: string;
}

export interface ClientHelloExtension {
	type: number;
	/** Offset of the extension header in the supplied handshake. */
	offset: number;
	data: Uint8Array;
}

export interface ClientHelloKeyShare {
	group: number;
	keyExchange: Uint8Array;
}

/** Byte arrays are unmodified views of the supplied handshake, not normalized copies. */
export interface ParsedClientHello {
	raw: Uint8Array;
	protocolVersion: number;
	random: Uint8Array;
	sessionId: Uint8Array;
	cipherSuites: number[];
	compressionMethods: Uint8Array;
	extensions: ClientHelloExtension[];
	supportedGroups: number[];
	ecPointFormats: number[];
	supportedVersions: number[];
	signatureAlgorithms: number[];
	alpn: Uint8Array[];
	keyShares: ClientHelloKeyShare[];
	/** Candidate nondeterminism only. No masking is performed; lengths and group IDs remain significant. */
	dynamicSpans: DynamicSpan[];
}

export class TlsParseError extends Error {
	constructor(
		message: string,
		readonly offset: number,
	) {
		super(`${message} at byte ${offset}`);
		this.name = "TlsParseError";
	}
}

class Cursor {
	position: number;
	constructor(
		readonly bytes: Uint8Array,
		readonly start = 0,
		readonly end = bytes.length,
	) {
		this.position = start;
	}
	get remaining(): number {
		return this.end - this.position;
	}
	need(length: number): void {
		if (length > this.remaining)
			throw new TlsParseError(`Truncated TLS vector: need ${length}, have ${this.remaining}`, this.position);
	}
	u8(): number {
		this.need(1);
		return this.bytes[this.position++]!;
	}
	u16(): number {
		return (this.u8() << 8) | this.u8();
	}
	u24(): number {
		return (this.u8() << 16) | (this.u8() << 8) | this.u8();
	}
	take(length: number): Uint8Array {
		this.need(length);
		const start = this.position;
		this.position += length;
		return this.bytes.subarray(start, this.position);
	}
	vector(width: 1 | 2): Cursor {
		const length = width === 1 ? this.u8() : this.u16();
		this.need(length);
		const start = this.position;
		this.position += length;
		return new Cursor(this.bytes, start, this.position);
	}
	finish(label: string): void {
		if (this.remaining) throw new TlsParseError(`Trailing bytes in ${label}`, this.position);
	}
}

function words(cursor: Cursor, label: string): number[] {
	if (!cursor.remaining || cursor.remaining % 2)
		throw new TlsParseError(`Invalid ${label} vector length`, cursor.position);
	const values: number[] = [];
	while (cursor.remaining) values.push(cursor.u16());
	return values;
}

function validateServerNames(cursor: Cursor): void {
	const names = cursor.vector(2);
	if (!names.remaining) throw new TlsParseError("Empty server_name list", names.position);
	const types = new Set<number>();
	while (names.remaining) {
		const type = names.u8();
		if (types.has(type)) throw new TlsParseError("Duplicate server_name type", names.position - 1);
		types.add(type);
		const name = names.vector(2);
		if (!name.remaining) throw new TlsParseError("Empty server_name", name.position);
	}
}

function validatePreSharedKey(cursor: Cursor): void {
	const identities = cursor.vector(2);
	let identityCount = 0;
	while (identities.remaining) {
		const identity = identities.vector(2);
		if (!identity.remaining) throw new TlsParseError("Empty PSK identity", identity.position);
		identities.take(4); // obfuscated_ticket_age remains significant, not a dynamic exclusion.
		identityCount++;
	}
	const binders = cursor.vector(2);
	let binderCount = 0;
	while (binders.remaining) {
		const binder = binders.vector(1);
		if (binder.remaining < 32) throw new TlsParseError("PSK binder shorter than 32 bytes", binder.position);
		binderCount++;
	}
	if (!identityCount || identityCount !== binderCount)
		throw new TlsParseError("PSK identity/binder count mismatch", cursor.start);
}

/** Parse exactly one complete TLS ClientHello, including its four-byte handshake header, without a record envelope. */
export function parseClientHello(bytes: Uint8Array): ParsedClientHello {
	const cursor = new Cursor(bytes);
	if (cursor.u8() !== 1) throw new TlsParseError("Expected ClientHello handshake type 1", 0);
	const bodyLength = cursor.u24();
	cursor.need(bodyLength);
	if (bodyLength !== cursor.remaining)
		throw new TlsParseError("Trailing bytes after ClientHello handshake", 4 + bodyLength);
	const protocolVersion = cursor.u16();
	const randomOffset = cursor.position;
	const random = cursor.take(32);
	const session = cursor.vector(1);
	if (session.remaining > 32) throw new TlsParseError("Session ID exceeds 32 bytes", session.start);
	const sessionId = session.take(session.remaining);
	const cipherSuites = words(cursor.vector(2), "cipher_suites");
	const compression = cursor.vector(1);
	if (!compression.remaining) throw new TlsParseError("Empty compression_methods", compression.start);
	const compressionMethods = compression.take(compression.remaining);
	const hello: ParsedClientHello = {
		raw: bytes,
		protocolVersion,
		random,
		sessionId,
		cipherSuites,
		compressionMethods,
		extensions: [],
		supportedGroups: [],
		ecPointFormats: [],
		supportedVersions: [],
		signatureAlgorithms: [],
		alpn: [],
		keyShares: [],
		dynamicSpans: [{ offset: randomOffset, length: 32, reason: "ClientHello random" }],
	};
	if (sessionId.length)
		hello.dynamicSpans.push({ offset: session.start, length: sessionId.length, reason: "ClientHello session ID" });
	// TLS <= 1.2 allows the entire extensions vector to be omitted.
	if (!cursor.remaining) return hello;
	const extensions = cursor.vector(2);
	cursor.finish("ClientHello");
	const seen = new Set<number>();
	while (extensions.remaining) {
		const offset = extensions.position;
		const type = extensions.u16();
		const extension = extensions.vector(2);
		if (seen.has(type)) throw new TlsParseError(`Duplicate extension 0x${hex(type)}`, offset);
		seen.add(type);
		hello.extensions.push({ type, offset, data: bytes.subarray(extension.start, extension.end) });
		switch (type) {
			case 0:
				validateServerNames(extension);
				break;
			case 10:
				hello.supportedGroups = words(extension.vector(2), "supported_groups");
				break;
			case 11: {
				const formats = extension.vector(1);
				if (!formats.remaining) throw new TlsParseError("Empty ec_point_formats", formats.start);
				while (formats.remaining) hello.ecPointFormats.push(formats.u8());
				break;
			}
			case 13:
				hello.signatureAlgorithms = words(extension.vector(2), "signature_algorithms");
				break;
			case 16: {
				const protocols = extension.vector(2);
				if (!protocols.remaining) throw new TlsParseError("Empty ALPN protocol list", protocols.start);
				while (protocols.remaining) {
					const protocol = protocols.vector(1);
					if (!protocol.remaining) throw new TlsParseError("Empty ALPN protocol", protocol.start);
					hello.alpn.push(protocol.take(protocol.remaining));
				}
				break;
			}
			case 41:
				if (extensions.remaining) throw new TlsParseError("pre_shared_key must be the final extension", offset);
				validatePreSharedKey(extension);
				break;
			case 43:
				hello.supportedVersions = words(extension.vector(1), "supported_versions");
				break;
			case 50:
				words(extension.vector(2), "signature_algorithms_cert");
				break;
			case 51: {
				const shares = extension.vector(2);
				const groups = new Set<number>();
				while (shares.remaining) {
					const group = shares.u16();
					if (groups.has(group)) throw new TlsParseError("Duplicate key_share group", shares.position - 2);
					groups.add(group);
					const key = shares.vector(2);
					if (!key.remaining) throw new TlsParseError("Empty key_share key exchange", key.start);
					const keyExchange = key.take(key.remaining);
					hello.keyShares.push({ group, keyExchange });
					hello.dynamicSpans.push({
						offset: key.start,
						length: keyExchange.length,
						reason: `key_share key exchange (group 0x${hex(group)})`,
					});
				}
				break;
			}
			default:
				// Unknown extension contents stay opaque and significant, including GREASE.
				extension.take(extension.remaining);
		}
		extension.finish(`extension 0x${hex(type)}`);
	}
	return hello;
}

export interface ClientHelloRecordFragment {
	recordOffset: number;
	recordVersion: number;
	handshakeOffset: number;
	inputOffset: number;
	length: number;
}

export interface ExtractedClientHello {
	handshake: Uint8Array;
	/** End of the complete record containing the final hello byte; subsequent input is not inspected. */
	bytesConsumed: number;
	/** Maps reconstructed handshake bytes back to the supplied TLS record stream. */
	fragments: ClientHelloRecordFragment[];
}

/**
 * Extract from one ordered, reassembled TCP direction starting on a TLS record boundary.
 * Record and handshake headers may be fragmented. This does not reassemble TCP or decrypt TLS.
 * Complete preceding handshake messages and boundary-aligned compatibility CCS are skipped.
 * Missing ClientHello, interrupted messages and every truncated record/message encountered throw.
 */
export function extractClientHelloFromRecords(bytes: Uint8Array): ExtractedClientHello {
	const records = new Cursor(bytes);
	const header = new Uint8Array(4);
	let headerLength = 0;
	let remainingBody = 0;
	let messageLength = 0;
	let fragments: ClientHelloRecordFragment[] = [];
	while (records.remaining) {
		const recordOffset = records.position;
		const type = records.u8();
		const recordVersion = records.u16();
		const record = records.vector(2);
		if (recordVersion < 0x0300 || recordVersion > 0x0303)
			throw new TlsParseError("Invalid plaintext TLS record version", recordOffset + 1);
		if (record.remaining > 16384)
			throw new TlsParseError("Plaintext TLS record exceeds 16384 bytes", recordOffset + 3);
		if (type === 20 && headerLength === 0 && record.remaining === 1 && bytes[record.start] === 1) continue;
		if (type !== 22) throw new TlsParseError("Non-handshake record before complete ClientHello", recordOffset);
		if (!record.remaining) throw new TlsParseError("Empty handshake record", record.start);
		const addFragment = (inputOffset: number, length: number): void => {
			fragments.push({ recordOffset, recordVersion, handshakeOffset: messageLength, inputOffset, length });
			messageLength += length;
		};
		while (record.remaining) {
			if (headerLength < 4) {
				const start = record.position;
				const length = Math.min(4 - headerLength, record.remaining);
				header.set(record.take(length), headerLength);
				addFragment(start, length);
				headerLength += length;
				if (headerLength < 4) continue;
				remainingBody = (header[1]! << 16) | (header[2]! << 8) | header[3]!;
				if (header[0] !== 1) fragments = [];
			}
			const start = record.position;
			const length = Math.min(remainingBody, record.remaining);
			record.take(length);
			if (length && header[0] === 1) addFragment(start, length);
			remainingBody -= length;
			if (remainingBody) continue;
			if (header[0] === 1) {
				const handshake = new Uint8Array(messageLength);
				for (const fragment of fragments) {
					handshake.set(
						bytes.subarray(fragment.inputOffset, fragment.inputOffset + fragment.length),
						fragment.handshakeOffset,
					);
				}
				parseClientHello(handshake); // Do not return a structurally invalid hello as a successful extraction.
				return { handshake, bytesConsumed: records.position, fragments };
			}
			headerLength = 0;
			messageLength = 0;
			fragments = [];
		}
	}
	if (headerLength) throw new TlsParseError("Truncated TLS handshake before complete ClientHello", bytes.length);
	throw new TlsParseError("No ClientHello in TLS records", bytes.length);
}

export function isGrease(value: number): boolean {
	return value >= 0 && value <= 0xffff && (value & 0x0f0f) === 0x0a0a && value >>> 8 === (value & 0xff);
}

export interface Ja3Fingerprint {
	raw: string;
	hash: string;
}

export function ja3(hello: ParsedClientHello): Ja3Fingerprint {
	const raw = [
		hello.protocolVersion,
		hello.cipherSuites.filter(value => !isGrease(value)).join("-"),
		hello.extensions
			.map(extension => extension.type)
			.filter(value => !isGrease(value))
			.join("-"),
		hello.supportedGroups.filter(value => !isGrease(value)).join("-"),
		hello.ecPointFormats.join("-"),
	].join(",");
	return { raw, hash: new Bun.CryptoHasher("md5").update(raw).digest("hex") };
}

export interface Ja4Fingerprint {
	/** Standard JA4_r: sorted ciphers/extensions; SNI and ALPN excluded from the extension list. */
	raw: string;
	/** JA4_ro: original cipher/extension order, including SNI and ALPN, excluding GREASE. */
	rawOriginal: string;
	hash: string;
	cipherInput: string;
	extensionInput: string;
	/** Twelve-character SHA256 prefixes, or twelve zeroes for an empty list. */
	cipherHash: string;
	extensionHash: string;
}

function hex(value: number): string {
	return value.toString(16).padStart(4, "0");
}

function alpnCode(protocol: Uint8Array | undefined): string {
	if (!protocol?.length) return "00";
	const first = protocol[0]!;
	const last = protocol[protocol.length - 1]!;
	const alphanumeric = (value: number): boolean =>
		(value >= 48 && value <= 57) || (value >= 65 && value <= 90) || (value >= 97 && value <= 122);
	if (alphanumeric(first) && alphanumeric(last)) return String.fromCharCode(first, last);
	return (first >>> 4).toString(16) + (last & 15).toString(16);
}

function versionCode(version: number): string {
	switch (version) {
		case 0x0304:
			return "13";
		case 0x0303:
			return "12";
		case 0x0302:
			return "11";
		case 0x0301:
			return "10";
		case 0x0300:
			return "s3";
		case 0x0002:
			return "s2";
		default:
			return "00";
	}
}

/** JA4 for TLS handshake framing only: TCP TLS (t), or a TLS hello already extracted from QUIC (q). Not DTLS. */
export function ja4(hello: ParsedClientHello, transport: "t" | "q" = "t"): Ja4Fingerprint {
	const ciphers = hello.cipherSuites.filter(value => !isGrease(value)).map(hex);
	const extensions = hello.extensions.map(extension => extension.type).filter(value => !isGrease(value));
	const signatures = hello.signatureAlgorithms
		.filter(value => !isGrease(value))
		.map(hex)
		.join(",");
	let version = hello.protocolVersion;
	if (hello.extensions.some(extension => extension.type === 43)) {
		version = 0;
		for (const supported of hello.supportedVersions)
			if (!isGrease(supported) && supported > version) version = supported;
	}
	const count = (value: number): string => Math.min(value, 99).toString().padStart(2, "0");
	const prefix = `${transport}${versionCode(version)}${extensions.includes(0) ? "d" : "i"}${count(ciphers.length)}${count(extensions.length)}${alpnCode(hello.alpn[0])}`;
	const signatureSuffix = signatures ? `_${signatures}` : "";
	const rawOriginal = `${prefix}_${ciphers.join(",")}_${extensions.map(hex).join(",")}${signatureSuffix}`;
	const cipherInput = ciphers.sort().join(",");
	const extensionList = extensions
		.filter(value => value !== 0 && value !== 16)
		.map(hex)
		.sort()
		.join(",");
	const extensionInput = extensionList + signatureSuffix;
	const cipherHash = cipherInput
		? new Bun.CryptoHasher("sha256").update(cipherInput).digest("hex").slice(0, 12)
		: "000000000000";
	const extensionHash = extensionList
		? new Bun.CryptoHasher("sha256").update(extensionInput).digest("hex").slice(0, 12)
		: "000000000000";
	return {
		raw: `${prefix}_${cipherInput}_${extensionInput}`,
		rawOriginal,
		hash: `${prefix}_${cipherHash}_${extensionHash}`,
		cipherInput,
		extensionInput,
		cipherHash,
		extensionHash,
	};
}
