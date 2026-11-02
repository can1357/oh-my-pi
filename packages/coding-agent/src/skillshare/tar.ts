/**
 * Minimal deterministic tar for Skillshare packages.
 *
 * The writer emits POSIX ustar with every non-content field fixed (mtime 0,
 * uid/gid 0, empty owner names, mode 0644 or 0755) and entries sorted by the
 * UTF-8 bytes of their path, so the same files always produce the same bytes
 * and therefore the same integrity hash. Paths longer than 100 bytes use the
 * ustar `prefix` field; paths that cannot be split into prefix (≤155) and name
 * (≤100) at a `/` are rejected.
 *
 * The reader accepts ustar, PAX `path` records, and GNU `L` long names so
 * archives produced by other tools can be inspected; directories are skipped
 * and anything that is not a regular file (symlinks, hard links, devices) is
 * rejected. Gzip is handled by callers (`Bun.gzipSync` / `Bun.gunzipSync`).
 */

export interface TarEntry {
	/** POSIX path relative to the archive root; no `.`/`..` segments, no leading `/`. */
	path: string;
	content: Uint8Array;
	executable: boolean;
}

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
/** Longest path the ustar name + prefix fields can carry. */
export const TAR_PATH_MAX = 255;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Throws when `path` is not a safe, normalized, relative POSIX path. */
export function assertTarPath(path: string): void {
	if (path.length === 0) throw new Error("tar: empty entry path");
	if (path.includes("\0")) throw new Error(`tar: entry path contains NUL: ${JSON.stringify(path)}`);
	if (path.includes("\\")) throw new Error(`tar: entry path contains a backslash: ${path}`);
	if (path.startsWith("/")) throw new Error(`tar: absolute entry path: ${path}`);
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new Error(`tar: entry path is not normalized: ${path}`);
		}
	}
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

/** Split an encoded path into ustar `prefix` and `name`, preferring the longest name. */
function splitPath(path: string, bytes: Uint8Array): { name: Uint8Array; prefix: Uint8Array } {
	if (bytes.length <= NAME_MAX) return { name: bytes, prefix: new Uint8Array(0) };
	if (bytes.length > TAR_PATH_MAX) {
		throw new Error(`tar: path exceeds ${TAR_PATH_MAX} bytes: ${path}`);
	}
	// Smallest prefix that still leaves the name within 100 bytes.
	for (let slash = bytes.length - NAME_MAX - 1; slash <= PREFIX_MAX; slash++) {
		if (slash > 0 && bytes[slash] === 0x2f) {
			return { prefix: bytes.subarray(0, slash), name: bytes.subarray(slash + 1) };
		}
	}
	throw new Error(`tar: path cannot be split into ustar prefix/name fields: ${path}`);
}

function writeOctal(header: Uint8Array, offset: number, width: number, value: number): void {
	const digits = value.toString(8).padStart(width - 1, "0");
	if (digits.length > width - 1) throw new Error(`tar: value ${value} does not fit a ${width}-byte field`);
	header.set(encoder.encode(digits), offset);
	header[offset + width - 1] = 0;
}

function checksum(header: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
	return sum;
}

/** Serialize `entries` to an uncompressed ustar archive (deterministic; input order is irrelevant). */
export function writeTar(entries: TarEntry[]): Uint8Array<ArrayBuffer> {
	const encoded = entries.map(entry => {
		assertTarPath(entry.path);
		return { entry, pathBytes: encoder.encode(entry.path) };
	});
	encoded.sort((a, b) => compareBytes(a.pathBytes, b.pathBytes));

	let total = BLOCK * 2;
	for (let i = 0; i < encoded.length; i++) {
		if (i > 0 && compareBytes(encoded[i - 1].pathBytes, encoded[i].pathBytes) === 0) {
			throw new Error(`tar: duplicate entry path: ${encoded[i].entry.path}`);
		}
		total += BLOCK + Math.ceil(encoded[i].entry.content.length / BLOCK) * BLOCK;
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const { entry, pathBytes } of encoded) {
		const header = out.subarray(offset, offset + BLOCK);
		const { name, prefix } = splitPath(entry.path, pathBytes);
		header.set(name, 0);
		writeOctal(header, 100, 8, entry.executable ? 0o755 : 0o644);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, entry.content.length);
		writeOctal(header, 136, 12, 0);
		header[156] = 0x30; // '0' regular file
		header.set(encoder.encode("ustar\0"), 257);
		header.set(encoder.encode("00"), 263);
		header.set(prefix, 345);
		const sum = checksum(header).toString(8).padStart(6, "0");
		header.set(encoder.encode(sum), 148);
		header[154] = 0;
		header[155] = 0x20;
		offset += BLOCK;
		out.set(entry.content, offset);
		offset += Math.ceil(entry.content.length / BLOCK) * BLOCK;
	}
	return out;
}

function readString(block: Uint8Array, offset: number, width: number): string {
	const field = block.subarray(offset, offset + width);
	const end = field.indexOf(0);
	return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function readOctal(block: Uint8Array, offset: number, width: number, label: string): number {
	const field = block.subarray(offset, offset + width);
	if (field[0] & 0x80) throw new Error(`tar: base-256 ${label} fields are not supported`);
	let text = "";
	for (const byte of field) {
		if (byte === 0) break;
		text += String.fromCharCode(byte);
	}
	text = text.trim();
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) throw new Error(`tar: invalid ${label} field ${JSON.stringify(text)}`);
	return Number.parseInt(text, 8);
}

function isZeroBlock(block: Uint8Array): boolean {
	for (const byte of block) if (byte !== 0) return false;
	return true;
}

/** Extract the `path` record from a PAX extended header body. */
function paxPath(body: Uint8Array): string | undefined {
	let path: string | undefined;
	let offset = 0;
	while (offset < body.length) {
		if (body[offset] === 0) break;
		const space = body.indexOf(0x20, offset);
		if (space === -1) throw new Error("tar: malformed PAX record");
		const length = Number.parseInt(decoder.decode(body.subarray(offset, space)), 10);
		if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > body.length) {
			throw new Error("tar: malformed PAX record length");
		}
		const record = decoder.decode(body.subarray(space + 1, offset + length - 1));
		const equals = record.indexOf("=");
		if (equals === -1) throw new Error("tar: malformed PAX record");
		if (record.slice(0, equals) === "path") path = record.slice(equals + 1);
		offset += length;
	}
	return path;
}

function normalizeReadPath(raw: string): string {
	let path = raw;
	while (path.startsWith("./")) path = path.slice(2);
	assertTarPath(path);
	return path;
}

/** Parse an uncompressed tar archive into its regular files. */
export function readTar(bytes: Uint8Array): TarEntry[] {
	const entries: TarEntry[] = [];
	const seen = new Set<string>();
	let offset = 0;
	let pendingPath: string | undefined;

	while (offset + BLOCK <= bytes.length) {
		const header = bytes.subarray(offset, offset + BLOCK);
		if (isZeroBlock(header)) break;
		const stored = readOctal(header, 148, 8, "checksum");
		if (stored !== checksum(header)) throw new Error(`tar: header checksum mismatch at offset ${offset}`);

		const size = readOctal(header, 124, 12, "size");
		const dataStart = offset + BLOCK;
		const dataEnd = dataStart + size;
		if (dataEnd > bytes.length) throw new Error("tar: truncated archive");
		const body = bytes.subarray(dataStart, dataEnd);
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

		const type = String.fromCharCode(header[156]);
		if (type === "x") {
			pendingPath = paxPath(body) ?? pendingPath;
			continue;
		}
		if (type === "g") continue;
		if (type === "L") {
			const end = body.indexOf(0);
			pendingPath = decoder.decode(end === -1 ? body : body.subarray(0, end));
			continue;
		}

		let path = pendingPath;
		pendingPath = undefined;
		if (path === undefined) {
			const name = readString(header, 0, NAME_MAX);
			const magic = readString(header, 257, 6);
			const prefix = magic === "ustar" ? readString(header, 345, PREFIX_MAX) : "";
			path = prefix ? `${prefix}/${name}` : name;
		}

		if (type === "5") continue;
		if (type !== "0" && type !== "\0" && type !== "7") {
			const kind = type === "2" ? "symlink" : type === "1" ? "hard link" : `type ${JSON.stringify(type)}`;
			throw new Error(`tar: unsupported entry (${kind}): ${path}`);
		}
		if (path.endsWith("/")) throw new Error(`tar: file entry with directory path: ${path}`);

		const normalized = normalizeReadPath(path);
		if (seen.has(normalized)) throw new Error(`tar: duplicate entry path: ${normalized}`);
		seen.add(normalized);
		const mode = readOctal(header, 100, 8, "mode");
		entries.push({ path: normalized, content: body.slice(), executable: (mode & 0o111) !== 0 });
	}
	return entries;
}
