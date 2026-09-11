import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import * as zlib from "node:zlib";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { DEFAULT_BASH_INTERCEPTOR_RULES, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as toolTimeouts from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { $which, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { openArchive, readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { GlobTool } from "../src/tools/glob";
import { DEFAULT_FILE_LIMIT, GrepTool, MULTI_FILE_PER_FILE_MATCHES } from "../src/tools/grep";
import { HubTool } from "../src/tools/hub";

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function writeFileWithMtime(filePath: string, content: string, mtimeMs: number): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	const mtime = new Date(mtimeMs);
	fs.utimesSync(filePath, mtime, mtime);
}

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function createFifoOrSkip(fifoPath: string): boolean {
	if (process.platform === "win32") {
		return false;
	}

	const mkfifoPath = $which("mkfifo");
	if (!mkfifoPath) {
		return false;
	}

	const result = Bun.spawnSync([mkfifoPath, fifoPath], { stdout: "ignore", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const errorText = result.stderr.toString("utf-8").trim();
		throw new Error(`mkfifo failed${errorText ? `: ${errorText}` : ""}`);
	}

	return true;
}

interface ArchiveFixtureEntry {
	path: string;
	content: string;
	prefix?: string;
	typeFlag?: "0" | "1" | "2";
	linkName?: string;
	unpacked?: boolean;
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
	const valueBuffer = Buffer.from(value, "utf-8");
	valueBuffer.copy(buffer, offset, 0, Math.min(valueBuffer.length, length));
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
	const octal = value.toString(8).padStart(length - 1, "0");
	buffer.write(octal, offset, length - 1, "ascii");
	buffer[offset + length - 1] = 0;
}

function createTarArchive(entries: ArchiveFixtureEntry[]): Buffer {
	const parts: Buffer[] = [];

	for (const entry of entries) {
		const header = Buffer.alloc(512, 0);
		const content = Buffer.from(entry.content, "utf-8");

		writeTarString(header, 0, 100, entry.path);
		if (entry.prefix) writeTarString(header, 345, 155, entry.prefix);
		if (entry.linkName) writeTarString(header, 157, 100, entry.linkName);
		writeTarOctal(header, 100, 8, 0o644);
		writeTarOctal(header, 108, 8, 0);
		writeTarOctal(header, 116, 8, 0);
		writeTarOctal(header, 124, 12, content.length);
		writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
		header.fill(0x20, 148, 156);
		header[156] = (entry.typeFlag ?? "0").charCodeAt(0);
		writeTarString(header, 257, 6, "ustar");
		writeTarString(header, 263, 2, "00");

		let checksum = 0;
		for (const byte of header) checksum += byte;
		const checksumText = checksum.toString(8).padStart(6, "0");
		header.write(checksumText, 148, 6, "ascii");
		header[154] = 0;
		header[155] = 0x20;

		parts.push(header, content);
		const remainder = content.length % 512;
		if (remainder !== 0) {
			parts.push(Buffer.alloc(512 - remainder, 0));
		}
	}

	parts.push(Buffer.alloc(1024, 0));
	return Buffer.concat(parts);
}

function tarChecksum(header: Buffer): void {
	header.fill(0x20, 148, 156);
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
	header[154] = 0;
	header[155] = 0x20;
}

interface TarHeaderOptions {
	linkName?: string;
	oldGnu?: boolean;
}

function createTarHeader(
	memberPath: string,
	contentLength: number,
	typeFlag: string,
	opts: TarHeaderOptions = {},
): Buffer {
	const header = Buffer.alloc(512, 0);
	writeTarString(header, 0, 100, memberPath);
	if (opts.linkName) writeTarString(header, 157, 100, opts.linkName);
	writeTarOctal(header, 100, 8, 0o644);
	writeTarOctal(header, 108, 8, 0);
	writeTarOctal(header, 116, 8, 0);
	writeTarOctal(header, 124, 12, contentLength);
	writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
	header[156] = typeFlag.charCodeAt(0);
	if (opts.oldGnu) {
		writeTarString(header, 257, 8, "ustar  ");
	} else {
		writeTarString(header, 257, 6, "ustar");
		writeTarString(header, 263, 2, "00");
	}
	tarChecksum(header);
	return header;
}

function tarRecord(header: Buffer, content: Buffer): Buffer {
	const remainder = content.byteLength % 512;
	return Buffer.concat([header, content, ...(remainder === 0 ? [] : [Buffer.alloc(512 - remainder)])]);
}

function writeTarBase256(buffer: Buffer, offset: number, length: number, value: bigint): void {
	const bits = BigInt(length * 8 - 1);
	const signBit = 1n << (bits - 1n);
	if (value < -signBit || value >= signBit) {
		throw new Error("Test tar value does not fit its base-256 field");
	}
	let encoded = value < 0 ? (1n << bits) + value : value;
	for (let index = length - 1; index >= 0; index--) {
		buffer[offset + index] = Number(encoded & 0xffn);
		encoded >>= 8n;
	}
	buffer[offset] = buffer[offset]! | 0x80;
}

interface Base256TarEntry {
	path: string;
	content: string;
	mtime?: bigint;
	size?: bigint;
}

function createBase256TarArchive(entry: Base256TarEntry): Buffer {
	const content = Buffer.from(entry.content, "utf-8");
	const header = createTarHeader(entry.path, content.byteLength, "0");
	if (entry.size !== undefined) writeTarBase256(header, 124, 12, entry.size);
	if (entry.mtime !== undefined) writeTarBase256(header, 136, 12, entry.mtime);
	tarChecksum(header);
	return Buffer.concat([tarRecord(header, content), Buffer.alloc(1024)]);
}

function createPaxHeader(typeFlag: "g" | "x", body: Buffer): Buffer {
	return tarRecord(createTarHeader("./PaxHeaders/omp", body.byteLength, typeFlag), body);
}

function paxRecord(key: string, value: string): Buffer {
	const suffix = Buffer.from(` ${key}=${value}\n`, "utf-8");
	let length = suffix.byteLength;
	while (true) {
		const nextLength = Buffer.byteLength(`${length}`, "utf-8") + suffix.byteLength;
		if (nextLength === length) return Buffer.concat([Buffer.from(`${length}`, "utf-8"), suffix]);
		length = nextLength;
	}
}

/**
 * Build a GNU 1.0 sparse PAX archive: an `x` extended header carrying the
 * user-visible `GNU.sparse.name`/`GNU.sparse.realsize`, followed by a regular
 * file header using the internal `GNUSparseFile.NNN` path.
 */
function createSparsePaxTarArchive(realName: string, realSize: number, storedData: Buffer): Buffer {
	const paxBody = Buffer.concat([
		paxRecord("GNU.sparse.major", "1"),
		paxRecord("GNU.sparse.minor", "0"),
		paxRecord("GNU.sparse.name", realName),
		paxRecord("GNU.sparse.realsize", `${realSize}`),
		paxRecord("size", `${storedData.length}`),
	]);
	const paxHeader = Buffer.alloc(512, 0);
	writeTarString(paxHeader, 0, 100, "./PaxHeaders/sparse");
	writeTarOctal(paxHeader, 100, 8, 0o644);
	writeTarOctal(paxHeader, 124, 12, paxBody.length);
	writeTarOctal(paxHeader, 136, 12, Math.floor(Date.now() / 1000));
	paxHeader[156] = "x".charCodeAt(0);
	writeTarString(paxHeader, 257, 6, "ustar");
	writeTarString(paxHeader, 263, 2, "00");
	tarChecksum(paxHeader);

	const fileHeader = Buffer.alloc(512, 0);
	writeTarString(fileHeader, 0, 100, "./GNUSparseFile.0/sparse.bin");
	writeTarOctal(fileHeader, 100, 8, 0o644);
	writeTarOctal(fileHeader, 124, 12, storedData.length);
	writeTarOctal(fileHeader, 136, 12, Math.floor(Date.now() / 1000));
	fileHeader[156] = "0".charCodeAt(0);
	writeTarString(fileHeader, 257, 6, "ustar");
	writeTarString(fileHeader, 263, 2, "00");
	tarChecksum(fileHeader);

	const parts: Buffer[] = [paxHeader];
	const paxRemainder = paxBody.length % 512;
	parts.push(paxBody, paxRemainder === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - paxRemainder, 0));
	parts.push(fileHeader, storedData);
	const dataRemainder = storedData.length % 512;
	if (dataRemainder !== 0) parts.push(Buffer.alloc(512 - dataRemainder, 0));
	parts.push(Buffer.alloc(1024, 0));
	return Buffer.concat(parts);
}

/**
 * Build an old-GNU sparse archive: an `S` member whose header sets the
 * `isextended` flag (byte 482), followed by one 512-byte sparse-map
 * continuation block that is not counted in the member's declared size,
 * then the stored data and a regular member.
 */
function createOldGnuSparseTarArchive(): Buffer {
	const storedData = Buffer.from("sparse-extent\n", "utf-8");
	const header = createTarHeader("data/real-sparse.bin", storedData.byteLength, "S", { oldGnu: true });
	// These old-GNU fields occupy the POSIX `prefix` region. A parser must not
	// prepend the atime to the member path merely because it is non-empty.
	writeTarOctal(header, 345, 12, 0o14524770401);
	writeTarOctal(header, 357, 12, 0o14524770402);
	writeTarOctal(header, 398, 12, storedData.byteLength);
	header[482] = 1; // sparse map continues in extension blocks
	writeTarOctal(header, 483, 12, 1024);
	tarChecksum(header);

	// Final continuation block: its own isextended byte (504) stays 0.
	const continuation = Buffer.alloc(512, 0);
	// createTarArchive appends the member and the end-of-archive terminator.
	return Buffer.concat([
		header,
		continuation,
		storedData,
		Buffer.alloc(512 - (storedData.byteLength % 512), 0),
		createTarArchive([{ path: "data/after.txt", content: "after sparse\n" }]),
	]);
}

function createOldGnuNamesTarArchive(longPath: string): Buffer {
	const content = Buffer.from("old GNU long path\n", "utf-8");
	const nameRecord = Buffer.from(`Rename short.txt to ${longPath}\n`, "utf-8");
	return Buffer.concat([
		tarRecord(createTarHeader("short.txt", content.byteLength, "0", { oldGnu: true }), content),
		tarRecord(createTarHeader("././@LongLink", nameRecord.byteLength, "N", { oldGnu: true }), nameRecord),
		Buffer.alloc(1024),
	]);
}

function createGlobalPaxLinkTarArchive(): Buffer {
	const linkPath = paxRecord("linkpath", "../lib/tool.js");
	const clearLinkPath = paxRecord("linkpath", "");
	const content = Buffer.from("global PAX link\n", "utf-8");
	return Buffer.concat([
		createPaxHeader("g", linkPath),
		tarRecord(createTarHeader("pkg/lib/tool.js", content.byteLength, "0"), content),
		tarRecord(createTarHeader("pkg/bin/tool", 0, "2"), Buffer.alloc(0)),
		createPaxHeader("g", clearLinkPath),
		tarRecord(createTarHeader("pkg/bin/current", 0, "2"), Buffer.alloc(0)),
		Buffer.alloc(1024),
	]);
}

function createPaxLinkTarArchive(linkPath: string): Buffer {
	const body = paxRecord("linkpath", linkPath);
	return Buffer.concat([
		createPaxHeader("x", body),
		tarRecord(createTarHeader("pkg/link", 0, "2"), Buffer.alloc(0)),
		Buffer.alloc(1024),
	]);
}

function createPaxPathTarArchive(memberPath: string): Buffer {
	const body = paxRecord("path", memberPath);
	return Buffer.concat([
		createPaxHeader("x", body),
		tarRecord(createTarHeader("short.txt", 0, "0"), Buffer.alloc(0)),
		Buffer.alloc(1024),
	]);
}

function createLongLinkTarArchive(linkPath: string): Buffer {
	const data = Buffer.from(`${linkPath}\0`, "utf-8");
	return Buffer.concat([
		tarRecord(createTarHeader("././@LongLink", data.byteLength, "K", { oldGnu: true }), data),
		tarRecord(createTarHeader("pkg/link", 0, "2", { oldGnu: true }), Buffer.alloc(0)),
		Buffer.alloc(1024),
	]);
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) {
			value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
	}
	return (value ^ 0xffffffff) >>> 0;
}

function createZipArchive(entries: ArchiveFixtureEntry[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let localOffset = 0;

	for (const entry of entries) {
		const pathBuffer = Buffer.from(entry.path.replace(/\\/g, "/"), "utf-8");
		const content = Buffer.from(entry.content, "utf-8");
		const compressed = zlib.deflateRawSync(content);
		const checksum = crc32(content);

		const localHeader = Buffer.alloc(30, 0);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0x0800, 6);
		localHeader.writeUInt16LE(8, 8);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(compressed.length, 18);
		localHeader.writeUInt32LE(content.length, 22);
		localHeader.writeUInt16LE(pathBuffer.length, 26);

		localParts.push(localHeader, pathBuffer, compressed);

		const centralHeader = Buffer.alloc(46, 0);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x0800, 8);
		centralHeader.writeUInt16LE(8, 10);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(compressed.length, 20);
		centralHeader.writeUInt32LE(content.length, 24);
		centralHeader.writeUInt16LE(pathBuffer.length, 28);
		centralHeader.writeUInt32LE(localOffset, 42);

		centralParts.push(centralHeader, pathBuffer);
		localOffset += localHeader.length + pathBuffer.length + compressed.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const endOfCentralDirectory = Buffer.alloc(22, 0);
	endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
	endOfCentralDirectory.writeUInt16LE(entries.length, 8);
	endOfCentralDirectory.writeUInt16LE(entries.length, 10);
	endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
	endOfCentralDirectory.writeUInt32LE(localOffset, 16);

	return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

interface AsarFixtureDirectory {
	files: Record<string, AsarFixtureNode>;
}

interface AsarFixtureFile {
	offset?: string;
	size: number;
	unpacked?: true;
}

type AsarFixtureNode = AsarFixtureDirectory | AsarFixtureFile;

function createAsarArchive(entries: ArchiveFixtureEntry[]): Buffer {
	const root: AsarFixtureDirectory = { files: {} };
	const packed: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const segments = entry.path.replace(/\\/g, "/").split("/");
		const fileName = segments.pop();
		if (!fileName) throw new Error("ASAR fixture paths must name a file");

		let directory = root;
		for (const segment of segments) {
			let child = directory.files[segment];
			if (!child) {
				child = { files: {} };
				directory.files[segment] = child;
			}
			if (!("files" in child)) throw new Error(`ASAR fixture path crosses file '${segment}'`);
			directory = child;
		}

		const content = Buffer.from(entry.content, "utf-8");
		if (entry.unpacked) {
			directory.files[fileName] = { size: content.length, unpacked: true };
		} else {
			directory.files[fileName] = { size: content.length, offset: String(offset) };
			packed.push(content);
			offset += content.length;
		}
	}

	const json = Buffer.from(JSON.stringify(root), "utf-8");
	const alignedJsonSize = json.length + ((4 - (json.length % 4)) % 4);
	const header = Buffer.alloc(8 + alignedJsonSize);
	header.writeUInt32LE(4 + alignedJsonSize, 0);
	header.writeUInt32LE(json.length, 4);
	json.copy(header, 8);

	const sizePickle = Buffer.alloc(8);
	sizePickle.writeUInt32LE(4, 0);
	sizePickle.writeUInt32LE(header.length, 4);
	return Buffer.concat([sizePickle, header, ...packed]);
}

function createZipArchiveWithRawDeflateEntry(entry: {
	path: string;
	compressed: Buffer;
	originalSize: number;
}): Buffer {
	const pathBuffer = Buffer.from(entry.path.replace(/\\/g, "/"), "utf-8");
	const localHeader = Buffer.alloc(30, 0);
	localHeader.writeUInt32LE(0x04034b50, 0);
	localHeader.writeUInt16LE(20, 4);
	localHeader.writeUInt16LE(0x0800, 6);
	localHeader.writeUInt16LE(8, 8);
	localHeader.writeUInt32LE(0, 14);
	localHeader.writeUInt32LE(entry.compressed.length, 18);
	localHeader.writeUInt32LE(entry.originalSize, 22);
	localHeader.writeUInt16LE(pathBuffer.length, 26);

	const centralHeader = Buffer.alloc(46, 0);
	centralHeader.writeUInt32LE(0x02014b50, 0);
	centralHeader.writeUInt16LE(20, 4);
	centralHeader.writeUInt16LE(20, 6);
	centralHeader.writeUInt16LE(0x0800, 8);
	centralHeader.writeUInt16LE(8, 10);
	centralHeader.writeUInt32LE(0, 16);
	centralHeader.writeUInt32LE(entry.compressed.length, 20);
	centralHeader.writeUInt32LE(entry.originalSize, 24);
	centralHeader.writeUInt16LE(pathBuffer.length, 28);

	const centralDirectory = Buffer.concat([centralHeader, pathBuffer]);
	const endOfCentralDirectory = Buffer.alloc(22, 0);
	endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
	endOfCentralDirectory.writeUInt16LE(1, 8);
	endOfCentralDirectory.writeUInt16LE(1, 10);
	endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
	endOfCentralDirectory.writeUInt32LE(localHeader.length + pathBuffer.length + entry.compressed.length, 16);

	return Buffer.concat([localHeader, pathBuffer, entry.compressed, centralDirectory, endOfCentralDirectory]);
}

let artifactCounter = 0;
function createTestToolSession(
	cwd: string,
	settings: Settings = Settings.isolated(),
	overrides: Partial<ToolSession> = {},
): ToolSession {
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = String(++artifactCounter);
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
		...overrides,
	};
}

function createTestToolContext(toolNames: string[]): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getApiKey: async () => undefined,
		} as unknown as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		toolNames,
	} as AgentToolContext;
}

describe("Coding Agent Tools", () => {
	let testDir: string;
	let session: ToolSession;
	let readTool: ReadTool;
	let writeTool: WriteTool;
	let editTool: EditTool;
	let bashTool: BashTool;
	let searchTool: GrepTool;
	let findTool: GlobTool;
	let originalEditVariant: string | undefined;

	beforeAll(async () => {
		// Warm the process-global shell snapshot + persistent session once. The
		// first real bash command otherwise folds ~40ms of one-time shell setup
		// into its own measured body time; this hoists it out of every test.
		await new BashTool(createTestToolSession(os.tmpdir())).execute("warm-shell", { command: "true" });
	});

	beforeEach(() => {
		// Force replace mode for edit tool tests using old_string/new_string
		originalEditVariant = Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_EDIT_VARIANT = "replace";

		// Create a unique temporary directory for each test
		testDir = path.join(os.tmpdir(), `coding-agent-test-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });

		// Create tools for this test directory
		session = createTestToolSession(testDir);
		readTool = wrapToolWithMetaNotice(new ReadTool(session));
		writeTool = wrapToolWithMetaNotice(new WriteTool(session));
		editTool = wrapToolWithMetaNotice(new EditTool(session));
		bashTool = wrapToolWithMetaNotice(new BashTool(session));
		searchTool = wrapToolWithMetaNotice(new GrepTool(session));
		findTool = wrapToolWithMetaNotice(new GlobTool(session));
	});

	afterEach(() => {
		vi.restoreAllMocks();

		// Clean up test directory
		removeSyncWithRetries(testDir);

		// Restore original edit variant
		if (originalEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		}
		AsyncJobManager.resetForTests();
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = path.join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			fs.writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			const output = getTextOutput(result);
			expect(output).toContain("Hello, world!");
			expect(output).toContain("Line 2");
			expect(output).toContain("Line 3");
			// No truncation message since file fits within limits
			expect(getTextOutput(result)).not.toContain("Use :");
			expect(result.details?.truncation).toBeUndefined();
		});

		it("truncates lines wider than the read column cap, leaving narrow lines untouched", async () => {
			const wideLine = "x".repeat(1500);
			const testFile = path.join(testDir, "wide.txt");
			fs.writeFileSync(testFile, `header\n${wideLine}\nfooter`);

			const result = await readTool.execute("test-call-column-truncate", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("header");
			expect(output).toContain("footer");
			expect(output).not.toContain(wideLine); // verbatim wide line is gone
			expect(output).toContain("…"); // ellipsis marker
			expect(output).toContain("Some lines truncated to 768 chars");
		});

		it("returns wide lines verbatim with the :raw selector", async () => {
			const wideLine = "y".repeat(1500);
			const testFile = path.join(testDir, "wide-raw.txt");
			fs.writeFileSync(testFile, `head\n${wideLine}\ntail`);

			const result = await readTool.execute("test-call-column-raw", { path: `${testFile}:raw` });
			const output = getTextOutput(result);

			expect(output).toContain(wideLine);
			expect(output).not.toContain("Some lines truncated to 768 chars");
		});

		it("should read ipynb files as editable cell text", async () => {
			const notebookPath = path.join(testDir, "notebook.ipynb");
			const notebook = {
				cells: [
					{
						cell_type: "markdown",
						metadata: { keep: true },
						source: ["# Notebook Title\n", "\n", "Notebook body\n"],
					},
					{
						cell_type: "code",
						metadata: {},
						source: ["print('hello')\n"],
						execution_count: 7,
						outputs: [{ output_type: "stream", name: "stdout", text: "hello\n" }],
					},
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5,
			};
			fs.writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await readTool.execute("test-call-ipynb", { path: notebookPath });
			const output = getTextOutput(result);

			expect(output).toContain("# %% [markdown] cell:0");
			expect(output).toContain("# Notebook Title");
			expect(output).toContain("Notebook body");
			expect(output).toContain("# %% [code] cell:1");
			expect(output).toContain("print('hello')");
			expect(output).not.toContain('"cell_type"');
		});

		it("should apply edits to the ipynb editable representation", async () => {
			const notebookPath = path.join(testDir, "editable.ipynb");
			const notebook = {
				cells: [
					{
						cell_type: "markdown",
						metadata: { keep: true },
						source: ["Original title\n"],
					},
					{
						cell_type: "code",
						metadata: { trusted: true },
						source: ["print('old')\n"],
						execution_count: 3,
						outputs: [{ output_type: "stream", name: "stdout", text: "old\n" }],
					},
				],
				metadata: { kernelspec: { name: "python3" } },
				nbformat: 4,
				nbformat_minor: 5,
			};
			fs.writeFileSync(notebookPath, JSON.stringify(notebook));
			const noLspEditTool = wrapToolWithMetaNotice(new EditTool({ ...session, enableLsp: false }));

			await noLspEditTool.execute("test-edit-ipynb", {
				path: notebookPath,
				old_string: "print('old')",
				new_string: "print('new')",
			});

			const updated = JSON.parse(fs.readFileSync(notebookPath, "utf-8"));
			expect(updated.cells).toHaveLength(2);
			expect(updated.cells[1].source).toEqual(["print('new')\n"]);
			expect(updated.cells[1].metadata).toEqual({ trusted: true });
			expect(updated.cells[1].execution_count).toBe(3);
			expect(updated.cells[1].outputs).toEqual([{ output_type: "stream", name: "stdout", text: "old\n" }]);
			expect(updated.metadata).toEqual({ kernelspec: { name: "python3" } });
		});

		it("should handle non-existent files", async () => {
			const testFile = path.join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		it("should read local files passed as file:// URLs", async () => {
			const testFile = path.join(testDir, "file-url.txt");
			fs.writeFileSync(testFile, "Hello from file URL");

			const result = await readTool.execute("test-call-file-url", { path: url.pathToFileURL(testFile).href });
			const output = getTextOutput(result);

			expect(output).toContain("Hello from file URL");
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = path.join(testDir, "large.txt");
			const lines = Array.from({ length: 3500 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));
			const defaultLimit = session.settings.get("read.defaultLimit");

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain(`Line ${defaultLimit}`);
			expect(output).not.toContain(`Line ${defaultLimit + 1}`);
			expect(output).toContain(`[Showing lines 1-${defaultLimit} of 3500. Use :${defaultLimit + 1} to continue]`);
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = path.join(testDir, "large-bytes.txt");
			// Create file with long lines so the byte budget triggers before the line limit.
			const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}: ${"x".repeat(600)}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			// Should show byte limit message
			expect(output).toMatch(/\[Showing lines 1-\d+ of 1000 \(\d+(\.\d+)?\s*KB limit\)\. Use :\d+ to continue\]/);
		});

		it("should handle offset parameter (with leading context expansion)", async () => {
			const testFile = path.join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: `${testFile}:L51` });
			const output = getTextOutput(result);

			// Read tool widens by 1 leading + 3 trailing unanchored context lines
			// so anchors at the boundary stay fresh. Line 50 is the single leading
			// context line; lines 47..49 are NOT included.
			expect(output).not.toContain("Line 49");
			expect(output).toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use :");
		});

		it("should handle limit parameter (with trailing context expansion)", async () => {
			const testFile = path.join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: `${testFile}:L1-L10` });
			const output = getTextOutput(result);

			// Trailing context: lines 11..13 included so an edit anchored at
			// the boundary stays fresh.
			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).toContain("Line 13");
			expect(output).not.toContain("Line 14");
			expect(output).toContain("[Showing lines 1-13 of 100. Use :14 to continue]");
		});

		it("does not expand on the leading side when offset is 1 or unspecified", async () => {
			const testFile = path.join(testDir, "no-leading.txt");
			const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			// :L1-L5 has offset=1 → no leading context (already at the top).
			// Trailing context still applies.
			const result = await readTool.execute("test-no-leading", {
				path: `${testFile}:L1-L5`,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 5");
			expect(output).toContain("Line 8");
			expect(output).not.toContain("Line 9");
			expect(output).toContain("[Showing lines 1-8 of 50. Use :9 to continue]");
		});

		it("clamps leading context at file start without errors", async () => {
			const testFile = path.join(testDir, "leading-clamp.txt");
			const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			// :L2-L5: offset=2 → expand by min(1, 1) = 1 leading line.
			const result = await readTool.execute("test-leading-clamp", {
				path: `${testFile}:L2-L5`,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2");
			expect(output).toContain("Line 5");
			expect(output).toContain("Line 8");
			expect(output).not.toContain("Line 9");
		});

		it("should handle offset + limit together (1 leading + 3 trailing)", async () => {
			const testFile = path.join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: `${testFile}:L41-L60`,
			});
			const output = getTextOutput(result);

			// Both endpoints are user-constrained: 1 leading + 3 trailing.
			expect(output).not.toContain("Line 39");
			expect(output).toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).toContain("Line 63");
			expect(output).not.toContain("Line 64");
			expect(output).toContain("[Showing lines 40-63 of 100. Use :64 to continue]");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = path.join(testDir, "short.txt");
			fs.writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			const result = await readTool.execute("test-call-8", { path: `${testFile}:L100` });
			const output = getTextOutput(result);

			expect(output).toContain("Line 100 is beyond end of file (3 lines total)");
			expect(output).toContain("Use :1 to read from the start, or :3 to read the last line.");
		});

		it("should refuse binary files (NUL or invalid UTF-8) instead of emitting mojibake", async () => {
			const nulFile = path.join(testDir, "blob.bin");
			fs.writeFileSync(nulFile, Buffer.from([0x61, 0x62, 0x63, 0x00, 0xff, 0xfe, 0x64, 0x65]));
			// A header with no NUL but invalid UTF-8 (lone 0xFF/0xC0) must also refuse.
			const invalidUtf8File = path.join(testDir, "font.ttfish");
			fs.writeFileSync(invalidUtf8File, Buffer.from([0x4d, 0x5a, 0xff, 0xfe, 0xc0, 0xc0, 0x90, 0x91]));

			for (const file of [nulFile, invalidUtf8File]) {
				const output = getTextOutput(await readTool.execute("test-call-binary", { path: file }));
				expect(output).toContain("Cannot read binary file");
				expect(output).not.toContain("\u0000");
				expect(output).not.toContain("\uFFFD");
			}
		});

		it("reads a binary file verbatim when :raw is requested", async () => {
			const testFile = path.join(testDir, "raw-blob.bin");
			fs.writeFileSync(testFile, Buffer.from([0x61, 0x62, 0x63, 0x00, 0x64, 0x65]));

			const output = getTextOutput(await readTool.execute("test-call-binary-raw", { path: `${testFile}:raw` }));
			expect(output).not.toContain("Cannot read binary file");
		});

		it("does not route a legacy .xls through markit's unsupported-format error", async () => {
			// `.xls` was advertised as convertible but markit only registers the
			// OOXML `.xlsx` converter, so reading a legacy `.xls` surfaced
			// "Unsupported format: .xls" instead of falling through to normal
			// file handling (issue #5808). An OLE2 header (`D0 CF 11 E0`) is a
			// binary blob, so the read tool now refuses it as binary.
			const xlsFile = path.join(testDir, "legacy.xls");
			fs.writeFileSync(xlsFile, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

			const output = getTextOutput(await readTool.execute("test-call-legacy-xls", { path: xlsFile }));
			expect(output).not.toContain("Unsupported format");
			expect(output).toContain("Cannot read binary file");
		});

		it("should reject malformed internal-URL selectors instead of dumping the whole resource", async () => {
			await expect(readTool.execute("test-call-bad-internal-sel", { path: "artifact://3:-100-5" })).rejects.toThrow(
				/Invalid selector ':-100-5'/,
			);
		});

		it("reads the last N lines with a :-N tail selector (1 leading context line, no trailing)", async () => {
			const testFile = path.join(testDir, "tail-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));

			const output = getTextOutput(await readTool.execute("test-tail", { path: `${testFile}:-10` }));

			expect(output).not.toContain("Line 89");
			expect(output).toContain("Line 90");
			expect(output).toContain("Line 91");
			expect(output).toContain("Line 100");
			expect(output).not.toContain("Use :");
		});

		it("tails a file past the snapshot cap without buffering it", async () => {
			const testFile = path.join(testDir, "tail-large.txt");
			const line = `${"x".repeat(1024)}`;
			const total = 12_000;
			fs.writeFileSync(testFile, Array.from({ length: total }, (_, i) => `${i + 1} ${line}`).join("\n"));
			expect(fs.statSync(testFile).size).toBeGreaterThan(8 * 1024 * 1024);

			const output = getTextOutput(await readTool.execute("test-tail-large", { path: `${testFile}:-3` }));

			expect(output).not.toContain(`${total - 4} x`);
			expect(output).toContain(`${total - 3} x`);
			expect(output).toContain(`${total} x`);
		});

		it("tail selector is verbatim under :raw and clamps to the whole file when N exceeds it", async () => {
			const testFile = path.join(testDir, "tail-raw.txt");
			fs.writeFileSync(testFile, "alpha\nbeta\ngamma\n");

			const raw = getTextOutput(await readTool.execute("test-tail-raw", { path: `${testFile}:raw:-2` }));
			expect(raw).toBe("gamma\n");

			const clamped = getTextOutput(await readTool.execute("test-tail-clamp", { path: `${testFile}:-50` }));
			expect(clamped).toContain("alpha");
			expect(clamped).toContain("gamma");
			expect(clamped).not.toContain("beyond end of file");
		});

		it("should include truncation details when truncated", async () => {
			const testFile = path.join(testDir, "large-file.txt");
			const lines = Array.from({ length: 3500 }, (_, i) => `Line ${i + 1}`);
			fs.writeFileSync(testFile, lines.join("\n"));
			const defaultLimit = session.settings.get("read.defaultLimit");

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(3500);
			expect(result.details?.truncation?.outputLines).toBe(defaultLimit);
		});

		it("reports the artifact byte budget that truncated a ranged read", async () => {
			const artifactsDir = path.join(testDir, "artifact-limit-session");
			fs.mkdirSync(artifactsDir, { recursive: true });
			fs.writeFileSync(path.join(artifactsDir, "7.mcp.log"), `skip\n{\n${"x".repeat(60 * 1024)}\ntail`);
			const artifactSession = createTestToolSession(testDir, Settings.isolated(), {
				localProtocolOptions: {
					getArtifactsDir: () => artifactsDir,
					getSessionId: () => "artifact-limit-session",
				},
			});
			const artifactReadTool = wrapToolWithMetaNotice(new ReadTool(artifactSession));

			const result = await artifactReadTool.execute("test-call-artifact-byte-limit", {
				path: "artifact://7:3-4",
			});
			const output = getTextOutput(result);
			expect(output).toContain("[Showing lines 2-2 of 4 (50.0KB limit)]");
			expect(output).toContain("Line 3 is 60.0KB");
			expect(output).toContain("artifact://7:raw:3-3");
			expect(output).not.toContain("Use :3 to continue");
		});

		it("should spill oversized read output to an artifact", async () => {
			const testFile = path.join(testDir, "oversized-read.txt");
			const line = "0123456789".repeat(20);
			fs.writeFileSync(testFile, `${Array.from({ length: 3500 }, () => line).join("\n")}\n`);
			const spillSettings = Settings.isolated({
				"tools.artifactSpillThreshold": 20,
				"tools.artifactTailBytes": 1,
				"tools.artifactTailLines": 10,
				"tools.artifactHeadBytes": 1,
			});
			const defaultLimit = spillSettings.get("read.defaultLimit");
			const spillManager = SessionManager.create(testDir, path.join(testDir, "spill-sessions"));
			await spillManager.ensureOnDisk();
			const spillSession = createTestToolSession(testDir, spillSettings, {
				getSessionFile: () => spillManager.getSessionFile() ?? null,
				getArtifactsDir: () => spillManager.getArtifactsDir(),
				localProtocolOptions: {
					getArtifactsDir: () => spillManager.getArtifactsDir(),
					getSessionId: () => spillManager.getSessionId(),
				},
			});
			const spillReadTool = wrapToolWithMetaNotice(new ReadTool(spillSession));
			const context = {
				...createTestToolContext(["read"]),
				settings: spillSettings,
				sessionManager: spillManager,
			};

			try {
				const result = await spillReadTool.execute(
					"test-call-read-spill",
					{ path: testFile },
					undefined,
					undefined,
					context,
				);
				const truncation = result.details?.meta?.truncation;
				const output = getTextOutput(result);

				expect(truncation?.artifactId).toBeDefined();
				expect(Buffer.byteLength(output, "utf-8")).toBeLessThan(20 * 1024);
				expect(output).toContain("artifact://");
				expect(truncation?.nextOffset).toBe(defaultLimit + 1);
				expect(output).toContain(`Use :${defaultLimit + 1} to continue`);

				const saveArtifact = vi.spyOn(spillManager, "saveArtifact");
				const artifactResult = await spillReadTool.execute(
					"test-call-read-spilled-artifact",
					{ path: `artifact://${truncation?.artifactId}` },
					undefined,
					undefined,
					context,
				);
				expect(getTextOutput(artifactResult)).toContain(line);
				expect(saveArtifact).not.toHaveBeenCalled();
			} finally {
				await spillManager.close();
			}
		});

		it("should strip payloads duplicated by structured MCP blocks (#9687)", async () => {
			// MCP results carry a second copy of the payload under `details.rawContent`.
			// Everything already stored elsewhere must be pruned so it cannot re-inflate
			// on-disk size: text and `resource.text` land in the spill artifact, image
			// data survives on the result content. Only resource URI/MIME/blob metadata,
			// which has no other home, is retained.
			const spillSettings = Settings.isolated({
				"tools.artifactSpillThreshold": 20,
				"tools.artifactTailBytes": 64,
				"tools.artifactTailLines": 10,
				"tools.artifactHeadBytes": 64,
			});
			const spillManager = SessionManager.create(testDir, path.join(testDir, "mcp-spill-sessions"));
			await spillManager.ensureOnDisk();
			const context = {
				...createTestToolContext(["mcp__server__tool"]),
				settings: spillSettings,
				sessionManager: spillManager,
			};

			const payload = "SEARCH RESULT LINE\n".repeat(4000);
			const resourceMeta = {
				uri: "file:///workspace/result.bin",
				mimeType: "application/octet-stream",
				blob: "AAECAw==",
			};
			const resource = {
				type: "resource" as const,
				resource: { ...resourceMeta, text: "duplicated resource body\n".repeat(200) },
			};
			const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
			const mcpTool = {
				name: "mcp__server__tool",
				description: "fake mcp tool returning a large structured payload",
				async execute() {
					return {
						content: [
							{ type: "text" as const, text: payload },
							{ type: "image" as const, data: image.data, mimeType: image.mimeType },
						],
						details: {
							serverName: "server",
							mcpToolName: "tool",
							rawContent: [{ type: "text", text: payload }, resource, image],
						},
					};
				},
			};

			try {
				const wrapped = wrapToolWithMetaNotice(mcpTool as unknown as AgentTool);
				const result = await wrapped.execute("mcp-call", {}, undefined, undefined, context);

				const truncation = result.details?.meta?.truncation;
				expect(truncation?.artifactId).toBeDefined();
				expect(Buffer.byteLength(getTextOutput(result), "utf-8")).toBeLessThan(Buffer.byteLength(payload, "utf-8"));

				// Text and image are represented elsewhere; only resource metadata
				// (without the artifact-stored text) survives on details.rawContent.
				expect(result.details?.rawContent).toEqual([{ type: "resource", resource: resourceMeta }]);
				// The image block is preserved on the result content.
				expect(result.content).toContainEqual({
					type: "image",
					data: image.data,
					mimeType: image.mimeType,
				});

				const artifactPath = path.join(
					spillManager.getArtifactsDir()!,
					`${truncation.artifactId}.mcp__server__tool.log`,
				);
				expect(await Bun.file(artifactPath).text()).toBe(payload);
			} finally {
				await spillManager.close();
			}
		});

		it("should not prune details.rawContent for non-MCP tool results (#9689)", async () => {
			// SDK/extension tools share this spill wrapper and their `details` payload
			// is unconstrained. A tool that happens to name a field `rawContent` must
			// keep it verbatim: only the MCP bridge (serverName + mcpToolName) mirrors
			// its content there, so a bare property-name collision must not lose data.
			const spillSettings = Settings.isolated({
				"tools.artifactSpillThreshold": 20,
				"tools.artifactTailBytes": 64,
				"tools.artifactTailLines": 10,
				"tools.artifactHeadBytes": 64,
			});
			const spillManager = SessionManager.create(testDir, path.join(testDir, "sdk-spill-sessions"));
			await spillManager.ensureOnDisk();
			const context = {
				...createTestToolContext(["custom_sdk_tool"]),
				settings: spillSettings,
				sessionManager: spillManager,
			};

			const payload = "SDK OUTPUT LINE\n".repeat(4000);
			// No serverName/mcpToolName markers → not an MCP result.
			const rawContent = [
				{ type: "text", text: "extension-owned text that must survive" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			];
			const sdkTool = {
				name: "custom_sdk_tool",
				description: "fake sdk tool that uses details.rawContent for its own data",
				async execute() {
					return {
						content: [{ type: "text" as const, text: payload }],
						details: { rawContent },
					};
				},
			};

			try {
				const wrapped = wrapToolWithMetaNotice(sdkTool as unknown as AgentTool);
				const result = await wrapped.execute("sdk-call", {}, undefined, undefined, context);

				// Spill still fired on the oversized content.
				expect(result.details?.meta?.truncation?.artifactId).toBeDefined();
				// The tool's own rawContent is left untouched.
				expect(result.details?.rawContent).toEqual(rawContent);
			} finally {
				await spillManager.close();
			}
		});

		it("should render directories as a two-level tree without capping root entries", async () => {
			const childDir = path.join(testDir, "child");
			const base = Date.now() - 60_000;
			fs.mkdirSync(childDir, { recursive: true });
			writeFileWithMtime(path.join(testDir, ".hidden-root"), "hidden", base + 20_000);
			writeFileWithMtime(path.join(testDir, ".DS_Store"), "mac metadata", base + 25_000);
			writeFileWithMtime(path.join(testDir, "node_modules", "pkg", "index.js"), "ignored", base + 24_000);
			for (let i = 0; i < 13; i += 1) {
				const fileName = `root-${String(i).padStart(2, "0")}.txt`;
				writeFileWithMtime(path.join(testDir, fileName), fileName, base + i);
			}
			for (let i = 0; i < 13; i += 1) {
				const fileName = `child-${String(i).padStart(2, "0")}.txt`;
				writeFileWithMtime(path.join(childDir, fileName), fileName, base + i);
			}
			writeFileWithMtime(path.join(childDir, "nested", "deep.txt"), "deep", base + 30_000);

			const result = await readTool.execute("test-call-directory-tree", { path: testDir });
			const output = getTextOutput(result);

			expect(result.details?.isDirectory).toBe(true);
			expect(output).toContain(".");
			expect(output).toContain(".hidden-root");
			expect(output).not.toContain(".DS_Store");
			expect(output).not.toContain("node_modules");
			expect(output).toContain("root-00.txt");
			expect(output).toContain("root-01.txt");
			expect(output).toContain("root-12.txt");
			expect(output).toContain("child/");
			expect(output).toContain("nested/");
			expect(output).toContain("… 2 more");
			expect(output).not.toContain("child-01.txt");
			expect(output).toContain("child-00.txt");
			expect(output).not.toContain("deep.txt");
		});

		it("should treat .tar archives like directories", async () => {
			const archivePath = path.join(testDir, "fixture.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "pkg/README.md", content: "# Tar README\nLine 2\n" },
					{ path: "pkg/src/index.ts", content: "export const tarValue = 1;\n" },
					{ path: "top.txt", content: "top level\n" },
				]),
			);

			const result = await readTool.execute("test-call-tar-root", { path: archivePath });
			const output = getTextOutput(result);

			expect(output).toContain("pkg/");
			expect(output).toContain("top.txt");
			expect(result.details?.isDirectory).toBe(true);
		});

		it("should read tar.gz members with UTF-8 ustar prefixes", async () => {
			const archivePath = path.join(testDir, "unicode-prefix.tar.gz");
			const prefix = "bun-da3851e57ae130c5594d0e208a5da5ba8c13edfb/test/js/node/test/fixtures/copy/utf/新建文件夹";
			const memberPath = `${prefix}/experimental.json`;
			fs.writeFileSync(
				archivePath,
				zlib.gzipSync(
					createTarArchive([
						{
							path: "experimental.json",
							prefix,
							content: '{ "type": "module" }',
						},
					]),
				),
			);

			const rootResult = await readTool.execute("test-call-tar-unicode-prefix-root", { path: archivePath });
			expect(getTextOutput(rootResult)).toContain("bun-da3851e57ae130c5594d0e208a5da5ba8c13edfb/");
			expect(rootResult.details?.isDirectory).toBe(true);

			const memberResult = await readTool.execute("test-call-tar-unicode-prefix-member", {
				path: `${archivePath}:${memberPath}`,
			});
			expect(getTextOutput(memberResult)).toContain('{ "type": "module" }');
		});

		it("should preserve tar hard-link members", async () => {
			const archivePath = path.join(testDir, "hard-link.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "pkg/original.txt", content: "shared content\n" },
					{ path: "pkg/linked.txt", content: "", typeFlag: "1", linkName: "pkg/original.txt" },
				]),
			);

			const rootResult = await readTool.execute("test-call-tar-hard-link-root", { path: `${archivePath}:pkg` });
			expect(getTextOutput(rootResult)).toContain("linked.txt");

			const linkedResult = await readTool.execute("test-call-tar-hard-link-member", {
				path: `${archivePath}:pkg/linked.txt`,
			});
			expect(getTextOutput(linkedResult)).toContain("shared content");

			const entries = await readArchiveEntries(archivePath);
			const linkedContent = entries.get("pkg/linked.txt");
			if (!(linkedContent instanceof Uint8Array)) {
				throw new Error("Expected hard-link content to materialize as bytes");
			}
			expect(new TextDecoder().decode(linkedContent)).toBe("shared content\n");
		});

		it("should preserve safe relative tar file symlinks", async () => {
			const archivePath = path.join(testDir, "file-symlink.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "pkg/lib/tool.js", content: "export const linked = true;\n" },
					{ path: "pkg/bin/tool", content: "", typeFlag: "2", linkName: "../lib/tool.js" },
				]),
			);

			const linkedResult = await readTool.execute("test-call-tar-symlink-member", {
				path: `${archivePath}:pkg/bin/tool`,
			});
			expect(getTextOutput(linkedResult)).toContain("export const linked = true");

			const entries = await readArchiveEntries(archivePath);
			const linkedContent = entries.get("pkg/bin/tool");
			if (!(linkedContent instanceof Uint8Array)) {
				throw new Error("Expected symlink content to materialize as bytes");
			}
			expect(new TextDecoder().decode(linkedContent)).toBe("export const linked = true;\n");
		});

		it("should resolve directory symlinks lazily without materializing subtrees", async () => {
			const archivePath = path.join(testDir, "directory-symlinks.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "pkg/lib/tool.js", content: "export const linked = true;\n" },
					{ path: "pkg/lib/extra.js", content: "export const extra = true;\n" },
					{ path: "pkg/current-a", content: "", typeFlag: "2", linkName: "lib" },
					{ path: "pkg/current-b", content: "", typeFlag: "2", linkName: "lib" },
					{ path: "pkg/current-c", content: "", typeFlag: "2", linkName: "lib" },
				]),
			);

			const linkedResult = await readTool.execute("test-call-tar-directory-symlink-member", {
				path: `${archivePath}:pkg/current-a/tool.js`,
			});
			expect(getTextOutput(linkedResult)).toContain("export const linked = true");

			const directoryResult = await readTool.execute("test-call-tar-directory-symlink-directory", {
				path: `${archivePath}:pkg/current-b`,
			});
			expect(getTextOutput(directoryResult)).toContain("extra.js");

			// Whole-archive materialization flattens files and skips directory
			// aliases without inflating the map through them (no N×M subtrees).
			const entries = await readArchiveEntries(archivePath);
			expect([...entries.keys()].sort()).toEqual(["pkg/lib/extra.js", "pkg/lib/tool.js"]);
		});

		it("should resolve file symlinks routed through directory symlinks", async () => {
			const archivePath = path.join(testDir, "aliased-file-symlink.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					// The file symlink precedes the directory alias it routes
					// through, so resolution must defer until the alias settles.
					{ path: "pkg/bin/tool", content: "", typeFlag: "2", linkName: "../current/tool.js" },
					{ path: "pkg/lib/tool.js", content: "export const linked = true;\n" },
					{ path: "pkg/current", content: "", typeFlag: "2", linkName: "lib" },
				]),
			);

			const linkedResult = await readTool.execute("test-call-tar-aliased-symlink-member", {
				path: `${archivePath}:pkg/bin/tool`,
			});
			expect(getTextOutput(linkedResult)).toContain("export const linked = true");
		});

		it("should degrade directory symlinks targeting their own subtree to dangling links", async () => {
			const archivePath = path.join(testDir, "self-cycle-symlink.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "a/b/f.txt", content: "still readable\n" },
					// `a -> a/b` is inherently cyclic; the pre-fix resolver looped
					// forever growing the rewritten path. The link now dangles
					// while real members underneath stay readable.
					{ path: "a", content: "", typeFlag: "2", linkName: "a/b" },
				]),
			);

			const memberResult = await readTool.execute("test-call-tar-self-cycle-member", {
				path: `${archivePath}:a/b/f.txt`,
			});
			expect(getTextOutput(memberResult)).toContain("still readable");
			await expect(readTool.execute("test-call-tar-self-cycle-link", { path: `${archivePath}:a` })).rejects.toThrow(
				/cannot be materialized/,
			);
		});

		it("should resolve alias chains up to the rewrite bound and reject deeper ones", async () => {
			const buildChain = (length: number): ArchiveFixtureEntry[] => {
				const chain: ArchiveFixtureEntry[] = [{ path: "real/f.txt", content: "deep\n" }];
				for (let i = 0; i < length; i++) {
					chain.push({
						path: `a${i}`,
						content: "",
						typeFlag: "2",
						linkName: i === length - 1 ? "real" : `a${i + 1}`,
					});
				}
				return chain;
			};

			const okPath = path.join(testDir, "alias-chain-40.tar");
			fs.writeFileSync(okPath, createTarArchive(buildChain(40)));
			const okResult = await readTool.execute("test-call-tar-alias-chain-40", { path: `${okPath}:a0/f.txt` });
			expect(getTextOutput(okResult)).toContain("deep");

			const deepPath = path.join(testDir, "alias-chain-41.tar");
			fs.writeFileSync(deepPath, createTarArchive(buildChain(41)));
			await expect(
				readTool.execute("test-call-tar-alias-chain-41", { path: `${deepPath}:a0/f.txt` }),
			).rejects.toThrow(/cyclic symlink/);
		});

		it("should let the later duplicate tar member win", async () => {
			const archivePath = path.join(testDir, "duplicate-member.tar");
			// tar -rf append/update semantics: extraction yields the last member.
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "dup/file.txt", content: "first\n" },
					{ path: "dup/file.txt", content: "second\n" },
				]),
			);

			const result = await readTool.execute("test-call-tar-duplicate-member", {
				path: `${archivePath}:dup/file.txt`,
			});
			expect(getTextOutput(result)).toContain("second");
			expect(getTextOutput(result)).not.toContain("first");
		});

		it("should let a later empty tar member replace prior content", async () => {
			const archivePath = path.join(testDir, "duplicate-empty-member.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "dup/file.txt", content: "stale content\n" },
					{ path: "dup/file.txt", content: "" },
				]),
			);

			const entries = await readArchiveEntries(archivePath);
			expect(entries.get("dup/file.txt")).toEqual(new Uint8Array());
		});

		it("should discard a superseded tar hard link before resolving targets", async () => {
			const archivePath = path.join(testDir, "duplicate-link-member.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "dup/file.txt", content: "", typeFlag: "1", linkName: "missing.txt" },
					{ path: "dup/file.txt", content: "replacement\n" },
				]),
			);

			const entries = await readArchiveEntries(archivePath);
			const replacement = entries.get("dup/file.txt");
			if (!(replacement instanceof Uint8Array)) {
				throw new Error("Expected replacement tar member to materialize as bytes");
			}
			expect(new TextDecoder().decode(replacement)).toBe("replacement\n");
		});

		it("should skip old-GNU sparse extension blocks between header and data", async () => {
			const archivePath = path.join(testDir, "old-gnu-sparse.tar");
			fs.writeFileSync(archivePath, createOldGnuSparseTarArchive());

			// Pre-fix the continuation block was parsed as the next header and
			// the whole archive rejected as corrupt.
			const rootResult = await readTool.execute("test-call-tar-old-gnu-sparse-root", {
				path: `${archivePath}:data`,
			});
			expect(getTextOutput(rootResult)).toContain("real-sparse.bin");
			expect(getTextOutput(rootResult)).not.toContain("14524770401");
			expect(getTextOutput(rootResult)).toContain("after.txt");

			const afterResult = await readTool.execute("test-call-tar-old-gnu-sparse-after", {
				path: `${archivePath}:data/after.txt`,
			});
			expect(getTextOutput(afterResult)).toContain("after sparse");
			await expect(
				readTool.execute("test-call-tar-old-gnu-sparse-member", { path: `${archivePath}:data/real-sparse.bin` }),
			).rejects.toThrow(/sparse file and cannot be read/);
		});

		it("should preserve signed GNU base-256 mtimes", async () => {
			const archive = await openArchive({
				bytes: createBase256TarArchive({ path: "negative-mtime.txt", content: "old\n", mtime: -1n }),
				format: "tar",
			});

			expect(archive.getNode("negative-mtime.txt")?.mtimeMs).toBe(-1000);
		});

		it("should reject unsafe GNU base-256 member sizes", async () => {
			await expect(
				openArchive({
					bytes: createBase256TarArchive({ path: "unsafe-size.txt", content: "", size: 1n << 60n }),
					format: "tar",
				}),
			).rejects.toThrow(/Invalid tar member size/);
		});

		it("should apply old-GNU N rename records to long member paths", async () => {
			const longPath = `data/${"component/".repeat(14)}file.txt`;
			const archive = await openArchive({ bytes: createOldGnuNamesTarArchive(longPath), format: "tar" });

			const member = await archive.readFile(longPath);
			expect(new TextDecoder().decode(member.bytes)).toBe("old GNU long path\n");
			expect(archive.getNode("short.txt")).toBeUndefined();
		});

		it("should resolve tar symlinks whose target is the archive root", async () => {
			const archivePath = path.join(testDir, "root-symlinks.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "top.txt", content: "top level\n" },
					{ path: "dir/inner.txt", content: "inner\n" },
					// `current -> .` and `dir/up -> ..` both normalize to the archive root.
					{ path: "current", content: "", typeFlag: "2", linkName: "." },
					{ path: "dir/up", content: "", typeFlag: "2", linkName: ".." },
				]),
			);

			const currentNode = await readTool.execute("test-call-tar-root-symlink-current", {
				path: `${archivePath}:current/top.txt`,
			});
			expect(getTextOutput(currentNode)).toContain("top level");

			const upNode = await readTool.execute("test-call-tar-root-symlink-up", {
				path: `${archivePath}:dir/up/top.txt`,
			});
			expect(getTextOutput(upNode)).toContain("top level");
		});

		it("should list dangling tar symlinks but reject their materialization", async () => {
			const archivePath = path.join(testDir, "dangling-symlink.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([{ path: "pkg/dangling", content: "", typeFlag: "2", linkName: "missing-target" }]),
			);

			const rootResult = await readTool.execute("test-call-tar-dangling-symlink-root", {
				path: `${archivePath}:pkg`,
			});
			expect(getTextOutput(rootResult)).toContain("dangling");
			await expect(
				readTool.execute("test-call-tar-dangling-symlink-member", {
					path: `${archivePath}:pkg/dangling`,
				}),
			).rejects.toThrow(/cannot be materialized/);
			await expect(readArchiveEntries(archivePath)).rejects.toThrow(/cannot be materialized/);
		});

		it("should apply and clear global PAX link paths", async () => {
			const archive = await openArchive({ bytes: createGlobalPaxLinkTarArchive(), format: "tar" });

			const linked = await archive.readFile("pkg/bin/tool");
			expect(new TextDecoder().decode(linked.bytes)).toBe("global PAX link\n");
			expect(archive.getNode("pkg/bin/current")?.isDirectory).toBe(true);
		});

		it("should reject overlong PAX link targets before storing dangling symlinks", async () => {
			const target = `\0/${"x".repeat(10_000)}`;
			await expect(openArchive({ bytes: createPaxLinkTarArchive(target), format: "tar" })).rejects.toThrow(
				/Archive PAX link target exceeds 4096 bytes/,
			);
		});

		it("should measure PAX paths in UTF-8 bytes", async () => {
			await expect(
				openArchive({ bytes: createPaxPathTarArchive("😀".repeat(1500)), format: "tar" }),
			).rejects.toThrow(/Archive PAX path exceeds 4096 bytes/);
		});

		it("should reject overlong GNU LongLink targets before decoding them", async () => {
			await expect(
				openArchive({ bytes: createLongLinkTarArchive("x".repeat(10_001)), format: "tar" }),
			).rejects.toThrow(/Archive GNU long link target exceeds 4096 bytes/);
		});

		it("should surface GNU sparse PAX names and reject sparse reads", async () => {
			const archivePath = path.join(testDir, "sparse-pax.tar");
			fs.writeFileSync(
				archivePath,
				createSparsePaxTarArchive("data/sparse.bin", 1048576, Buffer.from("sparse-map\n")),
			);

			// The listing must show the real GNU.sparse.name, not the internal
			// GNUSparseFile.NNN path.
			const rootResult = await readTool.execute("test-call-tar-sparse-root", { path: `${archivePath}:data` });
			expect(getTextOutput(rootResult)).toContain("sparse.bin");
			expect(getTextOutput(rootResult)).not.toContain("GNUSparseFile");

			// Reading the real member name resolves the entry and rejects it as
			// sparse (a catchable error), rather than reporting it missing.
			await expect(
				readTool.execute("test-call-tar-sparse-member", { path: `${archivePath}:data/sparse.bin` }),
			).rejects.toThrow(/sparse file and cannot be read/);
		});

		it("should reject a truncated tar member while indexing", async () => {
			const archivePath = path.join(testDir, "truncated.tar");
			// A full, valid archive declares 2048 bytes for `big.txt`; slicing the
			// payload mid-member leaves the header's declared size pointing past EOF.
			const complete = createTarArchive([{ path: "big.txt", content: "A".repeat(2048) }]);
			fs.writeFileSync(archivePath, complete.subarray(0, 512 + 256));

			await expect(readTool.execute("test-call-tar-truncated", { path: archivePath })).rejects.toThrow(/truncated/);
		});

		it("should reject a tar truncated before its terminating zero block", async () => {
			const archivePath = path.join(testDir, "unterminated.tar");
			const complete = createTarArchive([{ path: "complete.txt", content: "complete member\n" }]);
			fs.writeFileSync(archivePath, complete.subarray(0, complete.length - 1024));

			await expect(readTool.execute("test-call-tar-unterminated", { path: archivePath })).rejects.toThrow(
				/missing terminating zero block/,
			);
		});

		it("should expose a non-tar gzip payload as a single stem-named member", async () => {
			// `sniffArchiveFormat` classifies any gzip magic as tar.gz; when the
			// decompressed stream is not a tar it must surface as a one-member
			// pseudo-archive named after the file stem, not an error or an
			// empty directory.
			const archivePath = path.join(testDir, "note.txt.gz");
			fs.writeFileSync(archivePath, zlib.gzipSync(Buffer.from("hello world\n")));

			const listing = await readTool.execute("test-call-gzip-non-tar", { path: archivePath });
			expect(getTextOutput(listing)).toContain("note.txt");

			const member = await readTool.execute("test-call-gzip-non-tar-member", {
				path: `${archivePath}:note.txt`,
			});
			expect(getTextOutput(member)).toContain("hello world");
		});

		it("should list archive subdirectories", async () => {
			const archivePath = path.join(testDir, "fixture.zip");
			fs.writeFileSync(
				archivePath,
				createZipArchive([
					{ path: "pkg/README.md", content: "# Zip README\n" },
					{ path: "pkg/src/index.ts", content: "export const zipValue = 2;\n" },
					{ path: "pkg/src/util.ts", content: "export const utilValue = 3;\n" },
				]),
			);

			const result = await readTool.execute("test-call-zip-dir", { path: `${archivePath}:pkg/src` });
			const output = getTextOutput(result);

			expect(output).toContain("index.ts");
			expect(output).toContain("util.ts");
			expect(result.details?.isDirectory).toBe(true);
		});

		it("should list zip archives without inflating member payloads", async () => {
			const archivePath = path.join(testDir, "header-only.zip");
			fs.writeFileSync(
				archivePath,
				createZipArchiveWithRawDeflateEntry({
					path: "corrupt.bin",
					compressed: Buffer.from([0xff, 0xff, 0xff, 0xff]),
					originalSize: 1024,
				}),
			);

			const result = await readTool.execute("test-call-zip-header-only", { path: archivePath });
			const output = getTextOutput(result);

			expect(output).toContain("corrupt.bin");
			expect(result.details?.isDirectory).toBe(true);
		});

		for (const archiveCase of [
			{
				label: ".tar",
				path: "fixture-subpath.tar",
				create: (entries: ArchiveFixtureEntry[]) => createTarArchive(entries),
			},
			{
				label: ".tar.gz",
				path: "fixture-subpath.tar.gz",
				create: (entries: ArchiveFixtureEntry[]) => zlib.gzipSync(createTarArchive(entries)),
			},
			{
				label: ".tgz",
				path: "fixture-subpath.tgz",
				create: (entries: ArchiveFixtureEntry[]) => zlib.gzipSync(createTarArchive(entries)),
			},
			{
				label: ".zip",
				path: "fixture-subpath.zip",
				create: (entries: ArchiveFixtureEntry[]) => createZipArchive(entries),
			},
			{
				label: ".asar",
				path: "fixture-subpath.asar",
				create: (entries: ArchiveFixtureEntry[]) => createAsarArchive(entries),
			},
			{
				// `.jar`/`.war` are ZIP containers under a different extension.
				// Regression: archiveFormatFromPath / parseArchivePathCandidates
				// previously excluded them, so `read lib.jar:member` failed with
				// path-not-found (issue #5808).
				label: ".jar",
				path: "fixture-subpath.jar",
				create: (entries: ArchiveFixtureEntry[]) => createZipArchive(entries),
			},
			{
				label: ".war",
				path: "fixture-subpath.war",
				create: (entries: ArchiveFixtureEntry[]) => createZipArchive(entries),
			},
		]) {
			it(`should read ${archiveCase.label} subpaths`, async () => {
				const archivePath = path.join(testDir, archiveCase.path);
				fs.writeFileSync(
					archivePath,
					archiveCase.create([
						{ path: "pkg/README.md", content: "# Archive README\nLine 2\nLine 3\n" },
						{ path: "pkg/src/index.ts", content: "export const archiveValue = 4;\n" },
					]),
				);

				const result = await readTool.execute("test-call-archive-subpath", {
					path: `${archivePath}:pkg/README.md:L1-L2`,
				});
				const output = getTextOutput(result);

				expect(output).toContain("# Archive README");
				expect(output).toContain("Line 2");
				// Trailing context (±3) keeps Line 3 visible when present.
				expect(output).toContain("Line 3");
			});
		}

		it("should read unpacked .asar members", async () => {
			const archivePath = path.join(testDir, "fixture-unpacked.asar");
			const memberPath = "native/config.txt";
			const content = "unpacked ASAR content\n";
			fs.writeFileSync(archivePath, createAsarArchive([{ path: memberPath, content, unpacked: true }]));
			const unpackedPath = path.join(`${archivePath}.unpacked`, memberPath);
			fs.mkdirSync(path.dirname(unpackedPath), { recursive: true });
			fs.writeFileSync(unpackedPath, content);

			const result = await readTool.execute("test-call-asar-unpacked", {
				path: `${archivePath}:${memberPath}`,
			});

			expect(getTextOutput(result)).toContain("unpacked ASAR content");
		});

		it("should treat a selector-shaped archive subpath as a root listing selector", async () => {
			const archivePath = path.join(testDir, "root-selector.tar");
			fs.writeFileSync(
				archivePath,
				createTarArchive([
					{ path: "alpha.txt", content: "alpha\n" },
					{ path: "beta.txt", content: "beta\n" },
				]),
			);

			// Previously misparsed as a member named "2" and failed with a
			// misleading "not found inside archive" error. The selector is honored
			// as a 1-indexed listing offset, so `:2` starts at the second entry.
			const result = await readTool.execute("test-call-archive-root-selector", { path: `${archivePath}:2` });
			const output = getTextOutput(result);

			expect(output).toContain("beta.txt");
			expect(output).not.toContain("alpha.txt");
			expect(result.details?.isDirectory).toBe(true);
		});

		it("should prefer an archive member over a selector-shaped name", async () => {
			const archivePath = path.join(testDir, "member-precedence.tar");
			fs.writeFileSync(archivePath, createTarArchive([{ path: "raw", content: "member named raw\n" }]));

			const result = await readTool.execute("test-call-archive-member-raw", { path: `${archivePath}:raw` });
			const output = getTextOutput(result);

			expect(output).toContain("member named raw");
		});

		it("should reject archive members larger than the in-memory extraction cap", async () => {
			const archivePath = path.join(testDir, "bomb.zip");
			fs.writeFileSync(
				archivePath,
				createZipArchiveWithRawDeflateEntry({
					path: "bomb.bin",
					compressed: Buffer.from([0xff, 0xff, 0xff, 0xff]),
					originalSize: 3 * 1024 * 1024 * 1024, // 3GB declared, never allocated
				}),
			);

			await expect(readTool.execute("test-call-archive-bomb", { path: `${archivePath}:bomb.bin` })).rejects.toThrow(
				/too large to extract/i,
			);
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = path.join(testDir, "image.txt");
			fs.writeFileSync(testFile, pngBuffer);

			const imageReadTool = wrapToolWithMetaNotice(
				new ReadTool(createTestToolSession(testDir, Settings.isolated({ "images.autoResize": false }))),
			);
			const result = await imageReadTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock?.mimeType).toBe("image/png");
		});

		it("returns metadata for text-only models and pixels for image-capable models", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");
			const testFile = path.join(testDir, "image-guidance.png");
			fs.writeFileSync(testFile, pngBuffer);

			const textOnlyModel = createMockModel({ id: "text-only" });
			const textOnlyTool = wrapToolWithMetaNotice(
				new ReadTool(
					createTestToolSession(testDir, Settings.isolated(), {
						getActiveModel: () => textOnlyModel,
					}),
				),
			);
			const metadataResult = await textOnlyTool.execute("test-call-img-guidance", { path: testFile });
			const output = getTextOutput(metadataResult);

			expect(output).toContain("Image metadata:");
			expect(output).toContain("MIME: image/png");
			expect(output).toContain("Bytes:");
			expect(output).toContain("Dimensions:");
			expect(output).toContain(`${path.basename(testFile)}?q=<question>`);
			expect(metadataResult.content.some(c => c.type === "image")).toBe(false);

			const visionModel = createMockModel({ id: "vision" });
			visionModel.input.push("image");
			const visionTool = new ReadTool(
				createTestToolSession(testDir, Settings.isolated({ "images.autoResize": false }), {
					getActiveModel: () => visionModel,
				}),
			);
			const inlineResult = await visionTool.execute("test-call-img-inline", { path: testFile });
			expect(inlineResult.content.some(c => c.type === "image")).toBe(true);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = path.join(testDir, "not-an-image.png");
			fs.writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = path.join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(getTextOutput(result)).toContain(path.basename(testFile));
		});

		it("should create parent directories", async () => {
			const testFile = path.join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
		it.skipIf(process.platform === "win32")(
			"should tell the model when a shebang write was chmodded executable",
			async () => {
				const testFile = path.join(testDir, "script.sh");
				const content = "#!/usr/bin/env bash\nprintf 'ok\\n'\n";

				const result = await writeTool.execute("test-call-3-shebang", { path: testFile, content });

				expect(getTextOutput(result)).toContain("[Notice: Made executable via chmod +x]");
				expect(result.details?.madeExecutable).toBe(true);
				expect(fs.statSync(testFile).mode & 0o111).toBe(0o111);
			},
		);

		it("should write to a new local:// path under the session local root", async () => {
			const localPath = "local://handoffs/new-output.json";
			const content = '{"ok":true}\n';
			const expectedPath = path.join(testDir, "session", "local", "handoffs", "new-output.json");

			const result = await writeTool.execute("test-call-4-local", { path: localPath, content });

			expect(getTextOutput(result)).toContain(
				`Successfully wrote ${content.length} bytes to session/local/handoffs/new-output.json`,
			);
			expect(fs.existsSync(expectedPath)).toBe(true);
			expect(fs.readFileSync(expectedPath, "utf-8")).toBe(content);
		});

		it("should reject oversized tar rewrites before reading the archive bytes", async () => {
			const archivePath = path.join(testDir, "oversized.tar");
			fs.writeFileSync(archivePath, "");
			fs.truncateSync(archivePath, 256 * 1024 * 1024 + 1);

			await expect(
				writeTool.execute("test-call-archive-write-oversized", {
					path: `${archivePath}:pkg/new.txt`,
					content: "new\n",
				}),
			).rejects.toThrow(/too large to read in memory/);
		});

		it("should write to an existing archive entry", async () => {
			const archivePath = path.join(testDir, "write-existing.zip");
			fs.writeFileSync(
				archivePath,
				createZipArchive([
					{ path: "pkg/README.md", content: "# Original\n" },
					{ path: "pkg/src/index.ts", content: "export const archiveValue = 1;\n" },
				]),
			);

			const content = "# Updated\nLine 2\n";
			const result = await writeTool.execute("test-call-archive-write-existing", {
				path: `${archivePath}:pkg/README.md`,
				content,
			});

			expect(getTextOutput(result)).toContain(
				`Successfully wrote ${content.length} bytes to ${path.basename(archivePath)}:pkg/README.md`,
			);

			const unzipped = await readArchiveEntries({
				bytes: new Uint8Array(fs.readFileSync(archivePath)),
				format: "zip",
			});
			expect(new TextDecoder().decode(unzipped.get("pkg/README.md"))).toBe(content);
			expect(new TextDecoder().decode(unzipped.get("pkg/src/index.ts"))).toBe("export const archiveValue = 1;\n");
		});

		it("should create a new archive when writing to an archive subpath", async () => {
			const archivePath = path.join(testDir, "nested", "created.tar.gz");
			const content = "created inside archive\n";

			const result = await writeTool.execute("test-call-archive-write-create", {
				path: `${archivePath}:pkg/new.txt`,
				content,
			});

			expect(getTextOutput(result)).toContain(
				`Successfully wrote ${content.length} bytes to nested/${path.basename(archivePath)}:pkg/new.txt`,
			);
			expect(fs.existsSync(archivePath)).toBe(true);

			const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
			const files = await archive.files();
			expect(await files.get("pkg/new.txt")?.text()).toBe(content);
		});

		it("should preserve gzip compression when writing into an existing .tar.gz", async () => {
			const archivePath = path.join(testDir, "write-existing.tar.gz");
			fs.writeFileSync(
				archivePath,
				zlib.gzipSync(
					createTarArchive([
						{ path: "pkg/README.md", content: "# Original\n" },
						{ path: "pkg/src/index.ts", content: "export const archiveValue = 1;\n" },
					]),
				),
			);

			const content = "# Updated\nLine 2\n";
			await writeTool.execute("test-call-archive-write-targz", {
				path: `${archivePath}:pkg/README.md`,
				content,
			});

			const bytes = fs.readFileSync(archivePath);
			// gzip magic must survive the rewrite (regression: archive was
			// silently rewritten as a bare tar under the .gz name).
			expect(bytes[0]).toBe(0x1f);
			expect(bytes[1]).toBe(0x8b);

			const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
			const files = await archive.files();
			expect(await files.get("pkg/README.md")?.text()).toBe(content);
			expect(await files.get("pkg/src/index.ts")?.text()).toBe("export const archiveValue = 1;\n");
		});

		it("should treat a plain archive filename as a regular file write", async () => {
			const archivePath = path.join(testDir, "literal.zip");
			const content = "plain file contents\n";

			const result = await writeTool.execute("test-call-archive-plain-file", {
				path: archivePath,
				content,
			});

			expect(getTextOutput(result)).toContain(
				`Successfully wrote ${content.length} bytes to ${path.basename(archivePath)}`,
			);
			expect(fs.readFileSync(archivePath, "utf-8")).toBe(content);
		});
	});

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = path.join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			fs.writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				old_string: "world",
				new_string: "testing",
			});
			const details = result.details as { diff?: string } | undefined;

			expect(details?.diff).toContain("testing");
		});

		it("should fail if text not found", async () => {
			const testFile = path.join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			fs.writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-6", {
				path: testFile,
				old_string: "nonexistent",
				new_string: "testing",
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toMatch(/Could not find/);
		});

		it("should fail if text appears multiple times", async () => {
			const testFile = path.join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			fs.writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-7", {
				path: testFile,
				old_string: "foo",
				new_string: "bar",
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toMatch(/Found 3 occurrences/);
		});

		it("should replace all occurrences with replace_all: true", async () => {
			const testFile = path.join(testDir, "edit-all-test.txt");
			fs.writeFileSync(testFile, "foo bar foo baz foo");

			const result = await editTool.execute("test-all-1", {
				path: testFile,
				old_string: "foo",
				new_string: "qux",
				replace_all: true,
			});

			expect(getTextOutput(result)).toContain("qux bar qux baz qux");
			const content = await Bun.file(testFile).text();
			expect(content).toBe("qux bar qux baz qux");
		});

		it("should reject replace_all: true when multiple fuzzy matches are ambiguous", async () => {
			const testFile = path.join(testDir, "edit-all-fuzzy.txt");
			// File has two similar blocks with different indentation
			fs.writeFileSync(
				testFile,
				`function a() {
  if (x) {
    doThing();
  }
}
function b() {
    if (x) {
        doThing();
    }
}
`,
			);

			// With multiple fuzzy matches, the tool rejects for safety to avoid ambiguous replacements
			const result = await editTool.execute("test-all-fuzzy", {
				path: testFile,
				old_string: "if (x) {\n  doThing();\n}",
				new_string: "if (y) {\n  doOther();\n}",
				replace_all: true,
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toMatch(/Found 2 high-confidence matches/);
		});

		it("should fail with replace_all: true if no matches found", async () => {
			const testFile = path.join(testDir, "edit-all-nomatch.txt");
			fs.writeFileSync(testFile, "hello world");

			const result = await editTool.execute("test-all-nomatch", {
				path: testFile,
				old_string: "nonexistent",
				new_string: "bar",
				replace_all: true,
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toMatch(/Could not find/);
		});

		it("should replace multiline text with replace_all: true", async () => {
			const testFile = path.join(testDir, "edit-all-multiline.txt");
			fs.writeFileSync(testFile, "start\nfoo\nbar\nend\nstart\nfoo\nbar\nend");

			const result = await editTool.execute("test-all-multiline", {
				path: testFile,
				old_string: "foo\nbar",
				new_string: "replaced",
				replace_all: true,
			});

			expect(getTextOutput(result)).toContain("replaced");
			const content = await Bun.file(testFile).text();
			expect(content).toBe("start\nreplaced\nend\nstart\nreplaced\nend");
		});

		it("should work with replace_all: true when only one occurrence exists", async () => {
			const testFile = path.join(testDir, "edit-all-single.txt");
			fs.writeFileSync(testFile, "hello world");

			const result = await editTool.execute("test-all-single", {
				path: testFile,
				old_string: "world",
				new_string: "universe",
				replace_all: true,
			});

			expect(getTextOutput(result)).toContain("hello universe");
			const content = await Bun.file(testFile).text();
			expect(content).toBe("hello universe");
		});

		it("applies the bridge's internal edits batch form as one aggregate result", async () => {
			// Only the Cursor exec bridge produces this shape (multi-replacement
			// pi_edit frames); it must apply every replacement in order and
			// return a single aggregated diff.
			const testFile = path.join(testDir, "edit-batch.txt");
			fs.writeFileSync(testFile, "alpha\nbeta\n");

			const result = await editTool.execute("test-batch-1", {
				path: testFile,
				edits: [
					{ old_string: "alpha", new_string: "ALPHA" },
					{ old_string: "beta", new_string: "BETA" },
				],
			});

			expect(result.isError).toBeUndefined();
			const content = await Bun.file(testFile).text();
			expect(content).toBe("ALPHA\nBETA\n");
			const details = result.details as { diff?: string } | undefined;
			expect(details?.diff).toContain("ALPHA");
			expect(details?.diff).toContain("BETA");
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details?.timeoutSeconds).toBe(300);
		});

		it("should record wall time in text content and details", async () => {
			const result = await bashTool.execute("test-call-walltime", { command: "echo wt" });

			const output = getTextOutput(result);
			expect(output).toContain("wt");
			expect(output).toMatch(/Wall time: \d+\.\d{2} seconds/);
			expect(typeof result.details?.wallTimeMs).toBe("number");
			expect(result.details?.wallTimeMs).toBeGreaterThanOrEqual(0);
		});

		it("should expose built-in interceptor defaults truthfully", () => {
			const defaultSettings = Settings.isolated({ "bashInterceptor.enabled": true });
			const explicitEmptySettings = Settings.isolated({
				"bashInterceptor.enabled": true,
				"bashInterceptor.patterns": [],
			});

			expect(defaultSettings.get("bashInterceptor.patterns")).toEqual(DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(defaultSettings.getBashInterceptorRules()).toEqual(DEFAULT_BASH_INTERCEPTOR_RULES);
			expect(explicitEmptySettings.get("bashInterceptor.patterns")).toEqual([]);
			expect(explicitEmptySettings.getBashInterceptorRules()).toEqual([]);
		});

		it("should block built-in interceptor commands when enabled with default patterns", async () => {
			const interceptedBashTool = wrapToolWithMetaNotice(
				new BashTool(createTestToolSession(testDir, Settings.isolated({ "bashInterceptor.enabled": true }))),
			);

			await expect(
				interceptedBashTool.execute(
					"test-call-8-intercept-default",
					{ command: "cat test.txt" },
					undefined,
					undefined,
					createTestToolContext(["read"]),
				),
			).rejects.toThrow(/Use the `read` tool instead of cat\/head\/tail/);
		});

		it("should allow an explicit empty interceptor pattern list", async () => {
			const allowedFile = path.join(testDir, "allow-empty.txt");
			fs.writeFileSync(allowedFile, "empty means empty\n");

			const interceptedBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bashInterceptor.enabled": true,
							"bashInterceptor.patterns": [],
						}),
					),
				),
			);

			const result = await interceptedBashTool.execute(
				"test-call-8-intercept-empty",
				{ command: `cat ${shellEscape(allowedFile)}` },
				undefined,
				undefined,
				createTestToolContext(["read"]),
			);

			expect(getTextOutput(result)).toContain("empty means empty");
		});

		it("should honor custom bash interceptor patterns", async () => {
			const interceptedBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bashInterceptor.enabled": true,
							"bashInterceptor.patterns": [
								{
									pattern: "^\\s*customcmd\\s+",
									tool: "grep",
									message: "Use the `grep` tool for customcmd.",
								},
							],
						}),
					),
				),
			);
			await expect(
				interceptedBashTool.execute(
					"test-call-8-intercept-custom",
					{ command: "customcmd foo" },
					undefined,
					undefined,
					createTestToolContext(["grep"]),
				),
			).rejects.toThrow(/Use the `grep` tool for customcmd\./);
		});

		it("should expose env values without shell re-parsing", async () => {
			const mermaid = [
				"flowchart TD",
				'N0["attack"]',
				'N1["[target] cluster"]',
				'N2["diff-review"]',
				'N3["extract"]',
				'N4["report"]',
				'N5["setup"]',
				"N3 --> N0",
				"N0 --> N1",
				"N2 --> N1",
				"N3 --> N2",
				"N5 --> N3",
				"N1 --> N4",
			].join("\n");
			const result = await bashTool.execute("test-call-8-env", {
				command: "printf '%s' \"$MERMAID\"",
				env: { MERMAID: mermaid },
			});
			const output = getTextOutput(result);
			expect(output).toContain('N0["attack"]');
			expect(output).toContain("N1 --> N4");
			expect(fs.existsSync(path.join(testDir, "N0"))).toBe(false);
			expect(fs.existsSync(path.join(testDir, "N4"))).toBe(false);
		});

		it("should resolve local:// destination paths for mv commands", async () => {
			const sourcePath = path.join(testDir, "move-source.json");
			const targetPath = path.join(testDir, "session", "local", "moved-via-bash.json");
			fs.writeFileSync(sourcePath, '{"move":true}\n');

			await bashTool.execute("test-call-8-local-mv", {
				command: `mv ${shellEscape(sourcePath)} local://moved-via-bash.json`,
			});

			expect(fs.existsSync(sourcePath)).toBe(false);
			expect(fs.existsSync(targetPath)).toBe(true);
			expect(fs.readFileSync(targetPath, "utf-8")).toBe('{"move":true}\n');
		});

		it("should stream output updates", async () => {
			const updates: string[] = [];
			const result = await bashTool.execute(
				"test-call-8-stream",
				{ command: "printf '1\\n'; sleep 0.03; printf '2\\n3\\n'" },
				undefined,
				update => {
					const text = update.content?.find(c => c.type === "text")?.text ?? "";
					updates.push(text);
				},
			);

			expect(updates.length).toBeGreaterThan(1);
			expect(getTextOutput(result)).toContain("1");
			expect(getTextOutput(result)).toContain("3");
		});

		it("should persist environment variables between commands", async () => {
			if (process.platform === "win32" || Bun.env.PI_SHELL_PERSIST !== "1") {
				return;
			}

			await bashTool.execute("test-call-8-env-set", { command: "export PI_TEST_VAR=hello" });
			const result = await bashTool.execute("test-call-8-env-get", { command: "echo $PI_TEST_VAR" });
			expect(getTextOutput(result)).toContain("hello");
		});

		it("should write truncated output to artifacts", async () => {
			const result = await bashTool.execute("test-call-8-artifact", {
				// Emit well past the ~50KB inline window across many lines so the
				// output is genuinely window-truncated (not merely column-capped),
				// which is what allocates the spill artifact.
				command: "seq 1 15000",
			});

			const artifactId = result.details?.meta?.truncation?.artifactId;
			expect(artifactId).toBeDefined();
			if (artifactId) {
				const artifactPath = path.join(testDir, "session", `${artifactId}.bash.log`);
				expect(fs.existsSync(artifactPath)).toBe(true);
			}
		});

		it("should surface non-zero exits as an error result", async () => {
			// A completed-but-failed command resolves as a non-throwing error
			// result carrying the exit code, so the renderer keeps its footer.
			const result = await bashTool.execute("test-call-9", { command: "exit 1" });
			expect(result.isError).toBe(true);
			expect(result.details?.exitCode).toBe(1);
			expect(getTextOutput(result)).toContain("Command exited with code 1");
		});

		it("should keep short commands inline when auto-background is enabled", async () => {
			const deliveries: string[] = [];
			const asyncJobManager = new AsyncJobManager({
				onJobComplete: async (_jobId, text) => {
					deliveries.push(text);
				},
			});
			const autoBackgroundBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bash.autoBackground.enabled": true,
							"bash.autoBackground.thresholdMs": 2_000,
						}),
						{
							getSessionId: () => "test-session",
							asyncJobManager,
						},
					),
				),
			);

			const result = await autoBackgroundBashTool.execute("test-call-9-auto-inline", { command: "echo short" });

			expect(getTextOutput(result)).toContain("short");
			expect(result.details?.timeoutSeconds).toBe(300);
			expect(result.details?.async).toBeUndefined();
			await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
			expect(deliveries).toEqual([]);
			await asyncJobManager.dispose();
		});

		it("should auto-background at the threshold even with a longer timeout", async () => {
			const deliveries: Array<{ jobId: string; text: string }> = [];
			const updates: string[] = [];
			const asyncJobManager = new AsyncJobManager({
				onJobComplete: async (jobId, text) => {
					deliveries.push({ jobId, text });
				},
			});
			const autoBackgroundBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bash.autoBackground.enabled": true,
							"bash.autoBackground.thresholdMs": 10,
						}),
						{
							getSessionId: () => "test-session",
							asyncJobManager,
						},
					),
				),
			);

			const result = await autoBackgroundBashTool.execute(
				"test-call-9-auto-running",
				{
					command: "printf 'start\\n'; sleep 0.03; printf 'done\\n'",
					timeout: 3_600,
				},
				undefined,
				update => {
					updates.push(update.content?.find(block => block.type === "text")?.text ?? "");
				},
			);

			expect(result.details?.async?.state).toBe("running");
			expect(result.details?.async?.type).toBe("bash");
			expect(getTextOutput(result)).toContain("Backgrounded as job");

			const jobId = result.details?.async?.jobId;
			if (!jobId) {
				throw new Error("expected an auto-backgrounded job id");
			}
			const runningJob = asyncJobManager.getJob(jobId);
			expect(runningJob?.status).toBe("running");
			const updatesAtBackground = updates.slice();
			await runningJob?.promise;
			await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]?.jobId).toBe(jobId);
			expect(deliveries[0]?.text).toContain("start");
			expect(deliveries[0]?.text).toContain("done");
			expect(updates).toEqual(updatesAtBackground);
			await asyncJobManager.dispose();
		});

		it("backgrounds a running command when the steering signal fires mid-wait", async () => {
			const asyncJobManager = new AsyncJobManager({});
			const autoBackgroundBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bash.autoBackground.enabled": true,
							// High threshold: only the steering signal can background this.
							"bash.autoBackground.thresholdMs": 60_000,
						}),
						{
							getSessionId: () => "test-session",
							asyncJobManager,
						},
					),
				),
			);

			const steering = new AbortController();
			steering.abort();
			const result = await autoBackgroundBashTool.execute(
				"test-call-steer-background",
				{ command: "printf 'start\\n'; sleep 0.05; printf 'done\\n'" },
				undefined,
				undefined,
				{
					...createTestToolContext([]),
					toolCall: {
						batchId: "batch-1",
						index: 0,
						total: 1,
						toolCalls: [{ id: "test-call-steer-background", name: "bash" }],
						steeringSignal: steering.signal,
					},
				},
			);

			// The steer backgrounds the command instead of killing it: the call
			// returns a running job and the command finishes on its own.
			expect(result.details?.async?.state).toBe("running");
			expect(getTextOutput(result)).toContain("Backgrounded early to handle an incoming message");
			const jobId = result.details?.async?.jobId;
			if (!jobId) {
				throw new Error("expected a steer-backgrounded job id");
			}
			const job = asyncJobManager.getJob(jobId);
			expect(job?.status).toBe("running");
			await job?.promise;
			expect(asyncJobManager.getJob(jobId)?.status).toBe("completed");
			await asyncJobManager.dispose();
		});

		it("should background instead of timing out when auto-background wait exceeds the effective timeout", async () => {
			const deliveries: Array<{ jobId: string; text: string }> = [];
			const asyncJobManager = new AsyncJobManager({
				onJobComplete: async (jobId, text) => {
					deliveries.push({ jobId, text });
				},
			});
			const autoBackgroundBashTool = wrapToolWithMetaNotice(
				new BashTool(
					createTestToolSession(
						testDir,
						Settings.isolated({
							"bash.autoBackground.enabled": true,
							"bash.autoBackground.thresholdMs": 60_000,
						}),
						{
							getSessionId: () => "test-session",
							asyncJobManager,
						},
					),
				),
			);
			// Drive the effective timeout via the production clamp seam so the
			// backgrounded job hits its timeout in ~0.1s instead of a real
			// wall-clock second. The auto-background-on-timeout decision path is
			// unchanged; we assert the timeout-notice prefix rather than the
			// rounded seconds (it reads "0" here only because the seam
			// deliberately undercuts the 1s production floor).
			vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);

			const result = await autoBackgroundBashTool.execute("test-call-9-auto-timeout-background", {
				command: "printf 'start\\n'; sleep 0.5; printf 'done\\n'",
				timeout: 1,
			});

			expect(result.details?.timeoutSeconds).toBe(0.05);
			expect(result.details?.async?.state).toBe("running");
			expect(getTextOutput(result)).toContain("Backgrounded as job");
			const jobId = result.details?.async?.jobId;
			if (!jobId) {
				throw new Error("expected an auto-backgrounded job id");
			}
			const runningJob = asyncJobManager.getJob(jobId);
			expect(runningJob?.status).toBe("running");
			await runningJob?.promise;
			await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]?.jobId).toBe(jobId);
			expect(deliveries[0]?.text).toContain("Command timed out after");
			await asyncJobManager.dispose();
		});

		it("should surface clamped timeout in results", async () => {
			const result = await bashTool.execute("test-call-timeout-clamp", { command: "echo ok", timeout: 7200 });

			const output = getTextOutput(result);
			expect(output).toContain("ok");
			expect(output).toContain("Timeout clamped to 3600s (requested 7200s; allowed range 1-3600s).");
			expect(result.details?.timeoutSeconds).toBe(3600);
			expect(result.details?.requestedTimeoutSeconds).toBe(7200);
		});

		it("should disable the command deadline when timeout is zero", async () => {
			vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);

			const result = await bashTool.execute("test-call-timeout-disabled", {
				command: "printf 'start\\n'; sleep 0.1; printf 'done\\n'",
				timeout: 0,
			});

			const output = getTextOutput(result);
			expect(output).toContain("start");
			expect(output).toContain("done");
			expect(result.details?.timeoutDisabled).toBe(true);
			expect(result.details?.timeoutSeconds).toBeUndefined();
		});

		it("should respect timeout", async () => {
			// Reduce the effective timeout through the production clamp seam; the
			// real subprocess kill-on-timeout path is still exercised, just faster.
			// Timeouts settle as a flagged result (rendered as a warning) rather
			// than a thrown error since #5546; ACP keeps its rejection semantics.
			vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);
			const result = await bashTool.execute("test-call-10", { command: "sleep 5", timeout: 1 });
			expect(result.isError).toBe(true);
			expect((result.details as { timedOut?: boolean } | undefined)?.timedOut).toBe(true);
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toMatch(/timed out/i);
		});

		it("should abort and recover for subsequent commands", async () => {
			const controller = new AbortController();
			const started = Promise.withResolvers<void>();
			const promise = bashTool.execute(
				"test-call-10-abort",
				{ command: "echo READY; sleep 60" },
				controller.signal,
				update => {
					const text = update.content?.find(c => c.type === "text")?.text ?? "";
					if (text.includes("READY")) started.resolve();
				},
			);
			// Abort as soon as the command has emitted output (proving the shell is
			// live), instead of blindly waiting a fixed beat for it to enter `sleep`.
			await started.promise;
			controller.abort("test abort");
			await expect(promise).rejects.toThrow(/abort|cancel|timed out/i);

			const result = await bashTool.execute("test-call-10-after-abort", { command: "echo ok" });
			expect(getTextOutput(result)).toContain("ok");
		}, 15_000);

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = new BashTool(createTestToolSession(nonexistentCwd));

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should not pull cwd from a later-line `&&` when the command is multiline", async () => {
			// Regression for #?: the `^cd ... && ...` extractor used `\s` and `[^&\\]`,
			// which let the lazy match cross newlines and capture the whole script as the
			// "cwd" when any later line contained `&&`. The model intended `cd` to run as
			// part of a multiline script, not to relocate the entire command.
			const command = [
				"cd /this/directory/definitely/does/not/exist/12345",
				"echo first-line",
				"echo second && echo third",
			].join("\n");
			const result = await bashTool.execute("test-call-multiline-cd", { command });
			const output = getTextOutput(result);
			expect(output).toContain("first-line");
			expect(output).toContain("second");
			expect(output).toContain("third");
		});
	});

	describe("HubTool", () => {
		it("should wait for jobs and acknowledge deliveries to prevent race conditions", async () => {
			const manager = new AsyncJobManager({
				onJobComplete: async () => {},
			});
			const session = createTestToolSession(testDir, Settings.isolated({ "bash.autoBackground.enabled": true }), {
				asyncJobManager: manager,
			});
			const jobTool = new HubTool(session);

			const jobId = manager.register("bash", "test job", async () => "success");

			// Job is running, call poll
			const resultPromise = jobTool.execute("test-call-poll-1", { op: "wait", ids: [jobId] });

			// Ensure poll finished
			const result = await resultPromise;
			expect(getTextOutput(result)).toContain("Completed");

			// Wait for deliveries to be processed
			await manager.drainDeliveries({ timeoutMs: 100 });

			// If it correctly acknowledged, the delivery is suppressed.
			expect(manager.hasPendingDeliveries()).toBe(false);
		});

		it("flags still-waiting polls and all-running snapshots as contextually useless", async () => {
			const manager = new AsyncJobManager({
				onJobComplete: async () => {},
			});
			const session = createTestToolSession(testDir, Settings.isolated({ "bash.autoBackground.enabled": true }), {
				asyncJobManager: manager,
			});
			const jobTool = new HubTool(session);
			const gate = Promise.withResolvers<string>();
			const jobId = manager.register("bash", "long job", () => gate.promise);

			// Poll cut short while the job is still running: a pure "still
			// waiting" snapshot carries no information once consumed.
			const controller = new AbortController();
			const pollPromise = jobTool.execute("test-call-useless-poll", { op: "wait", ids: [jobId] }, controller.signal);
			controller.abort();
			const polled = await pollPromise;
			expect(polled.useless).toBe(true);

			// A list snapshot showing only running jobs is equally uneventful.
			const listed = await jobTool.execute("test-call-useless-list", { op: "jobs" });
			expect(listed.useless).toBe(true);

			// Once the job settles, the result is informative — flag absent.
			gate.resolve("done");
			const settled = await jobTool.execute("test-call-useless-settled", { op: "wait", ids: [jobId] });
			expect(getTextOutput(settled)).toContain("Completed");
			expect(settled.useless).toBeUndefined();

			// Nothing left to wait for: noise once consumed.
			const idle = await jobTool.execute("test-call-useless-idle", { op: "wait" });
			expect(getTextOutput(idle)).toContain("No running background jobs");
			expect(idle.useless).toBe(true);

			// A poll naming unknown ids found nothing — equally uneventful.
			const missing = await jobTool.execute("test-call-useless-missing", { op: "wait", ids: ["no-such-job"] });
			expect(getTextOutput(missing)).toContain("No matching jobs found");
			expect(missing.useless).toBe(true);
		});
	});

	describe("search tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = path.join(testDir, "example.txt");
			fs.writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await searchTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).not.toContain("# example.txt");
			// PI_EDIT_VARIANT=replace in beforeEach disables hashlines; expect line-number mode
			expect(output).toMatch(/\*2\|match line/);
		});

		it("flags a zero-match search as contextually useless", async () => {
			fs.writeFileSync(path.join(testDir, "plain.txt"), "nothing interesting here\n");

			const result = await searchTool.execute("test-call-useless-search", {
				pattern: "ZZZ_NO_SUCH_TOKEN_999",
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No matches found");
			expect(result.useless).toBe(true);
		});

		it("flags a zero-match search useless even when it reports missing paths", async () => {
			fs.writeFileSync(path.join(testDir, "plain.txt"), "nothing interesting here\n");

			const result = await searchTool.execute("test-call-useless-search-warn", {
				pattern: "ZZZ_NO_SUCH_TOKEN_999",
				path: `${testDir}; ${path.join(testDir, "missing-file.txt")}`,
			});

			expect(getTextOutput(result)).toContain("Skipped missing paths");
			expect(result.useless).toBe(true);
		});

		it("should accept wildcard patterns in paths", async () => {
			fs.writeFileSync(path.join(testDir, "schema-review-alpha.test.ts"), "review target\n");
			fs.writeFileSync(path.join(testDir, "schema-review-beta.test.ts"), "review target\n");
			fs.writeFileSync(path.join(testDir, "schema-other.test.ts"), "review target\n");

			const result = await searchTool.execute("test-call-11-path-glob", {
				pattern: "review target",
				path: `${testDir}/schema-review-*.test.ts`,
			});

			const output = getTextOutput(result);
			expect(output).toContain("# schema-review-alpha.test.ts");
			expect(output).toContain("# schema-review-beta.test.ts");
			expect(output).not.toContain("schema-other.test.ts");
			expect(result.details?.fileCount).toBe(2);
		});
		it("should accept nested wildcard filters in paths", async () => {
			const packageDir = path.join(testDir, "node_modules", ".bun");
			const aiDir = path.join(packageDir, "ai@6.0.119+build123", "node_modules", "ai");
			const nestedDir = path.join(aiDir, "nested");
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.writeFileSync(path.join(aiDir, "root.ts"), "providerOptions\n");
			fs.writeFileSync(path.join(nestedDir, "child.d.ts"), "providerOptions\n");
			fs.writeFileSync(path.join(aiDir, "ignore.js"), "providerOptions\n");
			fs.writeFileSync(path.join(testDir, "outside.ts"), "providerOptions\n");

			const result = await searchTool.execute("test-call-11-path-and-glob", {
				pattern: "providerOptions",
				path: `${packageDir}/ai@6.0.119+*/node_modules/ai/**/*.{d.ts,ts}`,
				gitignore: false,
			});

			const output = getTextOutput(result);
			expect(output).toContain("## root.ts");
			expect(output).toContain("## child.d.ts");
			expect(output).not.toContain("ignore.js");
			expect(output).not.toContain("outside.ts");
			expect(result.details?.fileCount).toBe(2);
		});

		it("should include configured context lines", async () => {
			const testFile = path.join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			fs.writeFileSync(testFile, content);

			const contextSettings = Settings.isolated({ "grep.contextBefore": 1, "grep.contextAfter": 1 });
			const contextSearchTool = wrapToolWithMetaNotice(
				new GrepTool(createTestToolSession(testDir, contextSettings)),
			);
			const result = await contextSearchTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).not.toContain("# context.txt");
			expect(output).toMatch(/ 1\|before/);
			expect(output).toMatch(/\*2\|match one/);
			expect(output).toMatch(/ 3\|after/);
			expect(output).toMatch(/\*5\|match two/);
		});

		it("inserts a gap separator between non-contiguous match blocks", async () => {
			const testFile = path.join(testDir, "gaps.txt");
			const lines = Array.from({ length: 10 }, (_, idx) => (idx === 0 || idx === 5 ? "match" : `filler ${idx}`));
			fs.writeFileSync(testFile, lines.join("\n"));

			const noContextSettings = Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 });
			const noContextSearchTool = wrapToolWithMetaNotice(
				new GrepTool(createTestToolSession(testDir, noContextSettings)),
			);
			const result = await noContextSearchTool.execute("test-call-12-gap", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toMatch(/\*1\|match\n\.\.\.\n\*6\|match/);
		});

		it("should paginate files via the skip parameter", async () => {
			const skipDir = path.join(testDir, "skip-dir");
			fs.mkdirSync(skipDir, { recursive: true });
			for (let i = 1; i <= 4; i++) {
				fs.writeFileSync(path.join(skipDir, `file-${i}.txt`), `needle ${i}`);
			}

			const first = await searchTool.execute("test-call-12-skip-first", {
				pattern: "needle",
				path: skipDir,
			});
			expect(first.details?.fileCount).toBe(4);

			const second = await searchTool.execute("test-call-12-skip-page", {
				pattern: "needle",
				path: skipDir,
				skip: 2,
			});
			const secondOutput = getTextOutput(second);
			expect(second.details?.fileCount).toBe(2);
			expect(secondOutput).not.toContain("# file-1.txt");
			expect(secondOutput).not.toContain("# file-2.txt");
			expect(secondOutput).toContain("# file-3.txt");
			expect(secondOutput).toContain("# file-4.txt");
		});

		it("respects the case parameter (case-sensitive by default, case-insensitive if false)", async () => {
			const caseFile = path.join(testDir, "case.txt");
			fs.writeFileSync(caseFile, "Hello World\nhello world\n");

			// 1. By default, search is case-sensitive (only matches the lowercase pattern "hello")
			const defaultResult = await searchTool.execute("test-case-default", {
				pattern: "hello",
				path: caseFile,
			});
			expect(defaultResult.details?.matchCount).toBe(1);

			// 2. With case: true, search is case-sensitive (only matches "hello")
			const sensitiveResult = await searchTool.execute("test-case-sensitive", {
				pattern: "hello",
				path: caseFile,
				case: true,
			});
			expect(sensitiveResult.details?.matchCount).toBe(1);

			// 3. With case: false, search is case-insensitive (matches both "Hello World" and "hello world")
			const insensitiveResult = await searchTool.execute("test-case-insensitive", {
				pattern: "hello",
				path: caseFile,
				case: false,
			});
			expect(insensitiveResult.details?.matchCount).toBe(2);
		});

		it("should group multi-file matches", async () => {
			for (let i = 1; i <= 3; i++) {
				fs.writeFileSync(path.join(testDir, `file-${i}.txt`), `needle in file ${i}\nextra needle ${i}`);
			}
			fs.writeFileSync(path.join(testDir, "dominant.txt"), "needle a\nneedle b\nneedle c\nneedle d");

			const result = await searchTool.execute("test-call-13-round-robin", {
				pattern: "needle",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("# file-1.txt");
			expect(output).toContain("# file-2.txt");
			expect(output).toContain("# file-3.txt");
			expect(output).toContain("# dominant.txt");
			expect(output).not.toContain("# .");
			expect(output).not.toContain("Result limit reached");
			expect(result.details?.fileCount).toBe(4);
			expect(result.details?.matchCount).toBe(10);
		});

		it("should not repeat file headings for multiple matches per file", async () => {
			fs.writeFileSync(path.join(testDir, "alpha.txt"), "needle a1\nneedle a2\nneedle a3");
			fs.writeFileSync(path.join(testDir, "beta.txt"), "needle b1\nneedle b2\nneedle b3");

			const result = await searchTool.execute("test-call-14-grouped-headings", {
				pattern: "needle",
				path: testDir,
			});

			const output = getTextOutput(result);
			const alphaHeadings = output.match(/# alpha\.txt/g)?.length ?? 0;
			const betaHeadings = output.match(/# beta\.txt/g)?.length ?? 0;
			expect(alphaHeadings).toBe(1);
			expect(betaHeadings).toBe(1);
			expect(result.details?.fileMatches).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: "alpha.txt", count: 3 }),
					expect.objectContaining({ path: "beta.txt", count: 3 }),
				]),
			);
		});

		it("should group files under directory headings", async () => {
			const nestedDir = path.join(testDir, "packages", "ai");
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.writeFileSync(path.join(nestedDir, "CHANGELOG.md"), "Claude Opus\n");
			fs.writeFileSync(path.join(nestedDir, "models.json"), '{ "name": "Claude Opus" }\n');

			const result = await searchTool.execute("test-call-15-directory-headings", {
				pattern: "Claude Opus",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("# packages/ai");
			expect(output).toContain("## CHANGELOG.md");
			expect(output).toContain("## models.json");
			expect(result.details?.fileCount).toBeGreaterThanOrEqual(2);
		});

		it("should respect .gitignore by default", async () => {
			const scenarioDir = path.join(testDir, "grep-gitignore-default");
			fs.mkdirSync(path.join(scenarioDir, ".git"), { recursive: true });
			fs.writeFileSync(path.join(scenarioDir, ".gitignore"), "ignored.txt\n");
			fs.writeFileSync(path.join(scenarioDir, "ignored.txt"), "needle ignored\n");
			fs.writeFileSync(path.join(scenarioDir, "kept.txt"), "needle kept\n");

			const result = await searchTool.execute("test-call-15-gitignore-default", {
				pattern: "needle",
				path: scenarioDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
			expect(result.details?.fileCount).toBe(1);
			expect(result.details?.matchCount).toBe(1);
		});

		it("should include ignored files when gitignore is false", async () => {
			const scenarioDir = path.join(testDir, "grep-gitignore-off");
			fs.mkdirSync(path.join(scenarioDir, ".git"), { recursive: true });
			fs.writeFileSync(path.join(scenarioDir, ".gitignore"), "ignored.txt\n");
			fs.writeFileSync(path.join(scenarioDir, "ignored.txt"), "needle ignored\n");

			const result = await searchTool.execute("test-call-16-gitignore-off", {
				pattern: "needle",
				path: scenarioDir,
				gitignore: false,
			});

			const output = getTextOutput(result);
			expect(output).toContain("ignored.txt");
			expect(result.details?.fileCount).toBe(1);
			expect(result.details?.matchCount).toBe(1);
		});

		it("should ignore FIFOs when searching a directory with gitignore disabled", async () => {
			const scenarioDir = path.join(testDir, "grep-fifo-dir");
			fs.mkdirSync(scenarioDir, { recursive: true });
			fs.writeFileSync(path.join(scenarioDir, "match.txt"), "needle kept\n");
			const fifoPath = path.join(scenarioDir, "blocked.fifo");

			if (!createFifoOrSkip(fifoPath)) {
				return;
			}

			const result = await searchTool.execute("test-call-16-fifo-dir", {
				pattern: "needle",
				path: scenarioDir,
				gitignore: false,
			});

			const output = getTextOutput(result);
			expect(output).toContain("match.txt");
			expect(output).toContain("needle kept");
			expect(output).not.toContain("blocked.fifo");
			expect(output).not.toContain("## blocked.fifo");
			expect(result.details?.fileCount).toBe(1);
			expect(result.details?.matchCount).toBe(1);
		});
		it("should cap distinct files and surface pagination", async () => {
			const limitDir = path.join(testDir, "file-limit-dir");
			fs.mkdirSync(limitDir, { recursive: true });
			const totalFiles = DEFAULT_FILE_LIMIT + 4;
			for (let i = 1; i <= totalFiles; i++) {
				fs.writeFileSync(path.join(limitDir, `f-${String(i).padStart(2, "0")}.txt`), `needle ${i}`);
			}

			const result = await searchTool.execute("test-call-14-file-limit", {
				pattern: "needle",
				path: limitDir,
			});

			const output = getTextOutput(result);
			expect(result.details?.fileCount).toBe(DEFAULT_FILE_LIMIT);
			expect(result.details?.matchCount).toBe(DEFAULT_FILE_LIMIT);
			expect(result.details?.fileLimitReached).toBe(DEFAULT_FILE_LIMIT);
			expect(output).toContain(`Showing files 1-${DEFAULT_FILE_LIMIT} of ${totalFiles}`);
			expect(output).toContain(`Use skip=${DEFAULT_FILE_LIMIT}`);
		});

		it("should cap matches per file in multi-file scopes", async () => {
			const concDir = path.join(testDir, "concentration-dir");
			fs.mkdirSync(concDir, { recursive: true });
			const hotMatches = MULTI_FILE_PER_FILE_MATCHES + 30;
			fs.writeFileSync(
				path.join(concDir, "hot.txt"),
				Array.from({ length: hotMatches }, (_, i) => `needle ${i + 1}`).join("\n"),
			);
			fs.writeFileSync(path.join(concDir, "cool.txt"), "needle cool");

			const result = await searchTool.execute("test-call-14-per-file-cap", {
				pattern: "needle",
				path: concDir,
			});

			const hotCount = result.details?.fileMatches?.find(entry => entry.path.endsWith("hot.txt"))?.count ?? 0;
			expect(hotCount).toBe(MULTI_FILE_PER_FILE_MATCHES);
			expect(result.details?.perFileLimitReached).toBe(MULTI_FILE_PER_FILE_MATCHES);
		});

		it("should let a single-file scope exceed the multi-file per-file cap", async () => {
			const single = path.join(testDir, "single-file.txt");
			const count = MULTI_FILE_PER_FILE_MATCHES + 30;
			fs.writeFileSync(single, Array.from({ length: count }, (_, i) => `needle ${i + 1}`).join("\n"));

			const result = await searchTool.execute("test-call-14-single-file-cap", {
				pattern: "needle",
				path: single,
			});

			expect(result.details?.matchCount).toBe(count);
			expect(result.details?.fileLimitReached).toBeUndefined();
			expect(result.details?.perFileLimitReached).toBeUndefined();
		});
	});

	describe("find tool", () => {
		it("should return a single file when given a file path", async () => {
			const testFile = path.join(testDir, "single.txt");
			fs.writeFileSync(testFile, "single");

			const result = await findTool.execute("test-call-13a", {
				path: testFile,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean);

			expect(outputLines).toEqual(["single.txt"]);
		});

		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = path.join(testDir, ".secret");
			fs.mkdirSync(hiddenDir);
			fs.writeFileSync(path.join(hiddenDir, "hidden.txt"), "hidden");
			fs.writeFileSync(path.join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				path: `${testDir}/**/*.txt`,
				hidden: true,
			});

			const files = (result.details?.files ?? []).slice().sort();
			expect(files).toContain("visible.txt");
			expect(files).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore", async () => {
			fs.mkdirSync(path.join(testDir, ".git"));
			fs.writeFileSync(path.join(testDir, ".gitignore"), "ignored.txt\n");
			fs.writeFileSync(path.join(testDir, "ignored.txt"), "ignored");
			fs.writeFileSync(path.join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				path: `${testDir}/**/*.txt`,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should sort exact recursive filename matches by mtime", async () => {
			const olderDir = path.join(testDir, "a");
			const newerDir = path.join(testDir, "z");
			fs.mkdirSync(olderDir, { recursive: true });
			fs.mkdirSync(newerDir, { recursive: true });

			const olderFile = path.join(olderDir, "auth-actions.spec.ts");
			const newerFile = path.join(newerDir, "auth-actions.spec.ts");
			fs.writeFileSync(olderFile, "old\n");
			fs.writeFileSync(newerFile, "new\n");

			const olderTime = new Date(Date.now() - 60_000);
			const newerTime = new Date();
			fs.utimesSync(olderFile, olderTime, olderTime);
			fs.utimesSync(newerFile, newerTime, newerTime);

			const result = await findTool.execute("test-call-14b", {
				path: `${testDir}/**/auth-actions.spec.ts`,
			});

			expect(result.details?.files).toEqual(["z/auth-actions.spec.ts", "a/auth-actions.spec.ts"]);
		});

		it("should render nested glob results relative to the session cwd", async () => {
			const nestedDir = path.join(testDir, "apps", "daemon", "src", "telemetry");
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.writeFileSync(path.join(nestedDir, "daemon-telemetry.ts"), "telemetry\n");

			const result = await findTool.execute("test-call-14c", {
				path: "apps/daemon/src/**/daemon-telemetry.ts",
			});

			expect(result.details?.files).toEqual(["apps/daemon/src/telemetry/daemon-telemetry.ts"]);
		});

		it("should not double-prefix multi-pattern results under a shared base", async () => {
			const daemonDir = path.join(testDir, "apps", "daemon", "src");
			const clientDir = path.join(testDir, "apps", "client", "src");
			fs.mkdirSync(daemonDir, { recursive: true });
			fs.mkdirSync(clientDir, { recursive: true });
			fs.writeFileSync(path.join(daemonDir, "daemon.ts"), "daemon\n");
			fs.writeFileSync(path.join(clientDir, "client.ts"), "client\n");

			const result = await findTool.execute("test-call-14e", {
				path: JSON.stringify(["apps/daemon/src/**/*.ts", "apps/client/src/**/*.ts"]),
			});

			const files = (result.details?.files ?? []).slice().sort();
			expect(files).toEqual(["apps/client/src/client.ts", "apps/daemon/src/daemon.ts"]);
		});

		it("should not disable gitignore after an ignored broad hidden-file search finds no matches", async () => {
			fs.mkdirSync(path.join(testDir, ".git"));
			fs.writeFileSync(path.join(testDir, ".gitignore"), ".env*\nignored-generated/\n");
			fs.writeFileSync(path.join(testDir, ".env.local"), "SECRET=value\n");
			fs.mkdirSync(path.join(testDir, "ignored-generated"));
			fs.writeFileSync(path.join(testDir, "ignored-generated", ".env.generated"), "SECRET=value\n");

			const startedAt = performance.now();
			const result = await findTool.execute("test-call-14d", {
				path: "**/.env*",
			});
			const elapsedMs = performance.now() - startedAt;

			const output = getTextOutput(result);
			expect(output).toContain("No files found matching pattern");
			expect(output).not.toContain(".env.local");
			expect(output).not.toContain(".env.generated");
			expect(elapsedMs).toBeLessThan(1000);
		});

		it("should return directories alongside files with a trailing slash", async () => {
			fs.mkdirSync(path.join(testDir, "pkg"));
			fs.mkdirSync(path.join(testDir, "pkg", "nested"));
			fs.writeFileSync(path.join(testDir, "pkg", "file.txt"), "f");
			fs.writeFileSync(path.join(testDir, "pkg", "nested", "deep.txt"), "d");

			const result = await findTool.execute("test-call-14f", {
				path: `${testDir}/pkg/**/*`,
			});

			const files = (result.details?.files ?? []).slice().sort();
			expect(files).toEqual(["pkg/file.txt", "pkg/nested/", "pkg/nested/deep.txt"]);
		});

		it("should match a directory by glob and emit it with trailing slash", async () => {
			fs.mkdirSync(path.join(testDir, "alpha", "tests"), { recursive: true });
			fs.mkdirSync(path.join(testDir, "beta", "tests"), { recursive: true });
			fs.writeFileSync(path.join(testDir, "alpha", "tests", "a.ts"), "a");

			const result = await findTool.execute("test-call-14g", {
				path: `${testDir}/**/tests`,
			});

			const files = (result.details?.files ?? []).slice().sort();
			expect(files).toEqual(["alpha/tests/", "beta/tests/"]);
		});

		it("should not recurse into subdirectories for a single-star glob like dir/*", async () => {
			const dir = path.join(testDir, "shallow");
			const sub = path.join(dir, "sub");
			fs.mkdirSync(sub, { recursive: true });
			fs.writeFileSync(path.join(dir, "top.tsx"), "t");
			fs.writeFileSync(path.join(sub, "nested.tsx"), "n");

			const result = await findTool.execute("test-call-14h", {
				path: `${dir}/*.tsx`,
			});

			const files = (result.details?.files ?? []).slice().sort();
			expect(files).toEqual(["shallow/top.tsx"]);
		});
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;
	let editTool: EditTool;
	let originalEditVariant: string | undefined;

	beforeEach(() => {
		// Force replace mode for edit tool tests using old_string/new_string
		originalEditVariant = Bun.env.PI_EDIT_VARIANT;
		Bun.env.PI_EDIT_VARIANT = "replace";

		testDir = path.join(os.tmpdir(), `coding-agent-crlf-test-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		editTool = new EditTool(createTestToolSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);

		// Restore original edit variant
		if (originalEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		}
	});

	it("should match LF old_string against CRLF file content", async () => {
		const testFile = path.join(testDir, "crlf-test.txt");

		fs.writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			old_string: "line two\n",
			new_string: "replaced line\n",
		});

		expect(getTextOutput(result)).toContain("replaced line");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = path.join(testDir, "crlf-preserve.txt");
		fs.writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			old_string: "second\n",
			new_string: "REPLACED\n",
		});

		const content = await Bun.file(testFile).text();
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = path.join(testDir, "lf-preserve.txt");
		fs.writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			old_string: "second\n",
			new_string: "REPLACED\n",
		});

		const content = await Bun.file(testFile).text();
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("should detect duplicates across CRLF/LF variants", async () => {
		const testFile = path.join(testDir, "mixed-endings.txt");

		fs.writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		const result = await editTool.execute("test-crlf-dup", {
			path: testFile,
			old_string: "hello\nworld\n",
			new_string: "replaced\n",
		});
		expect(result.isError).toBe(true);
		expect(getTextOutput(result)).toMatch(/Found 2 occurrences/);
	});

	// TODO: CRLF preservation broken by LSP formatting - fix later
	it.skip("should preserve UTF-8 BOM after edit", async () => {
		const testFile = path.join(testDir, "bom-test.txt");
		fs.writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			old_string: "second\n",
			new_string: "REPLACED\n",
		});

		const content = await Bun.file(testFile).text();
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});
});
