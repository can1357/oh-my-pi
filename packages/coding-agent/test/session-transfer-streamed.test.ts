import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { findSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	packSession,
	SESSION_ARCHIVE_VERSION,
	SESSION_TRANSFER_MESSAGE_TYPE,
	unpackSession,
} from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { sha256File } from "@oh-my-pi/pi-coding-agent/utils/file-hash";
import { formatBytes, getBlobsDir, getConfigRootDir, setAgentDir, TempDir, VERSION } from "@oh-my-pi/pi-utils";
import * as ar from "@oh-my-pi/pi-utils/ar";
import { ArchiveReader, encodeArchive, openArchive, readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";
import type { BunFile } from "bun";
import { makeAssistantMessage } from "./session-manager/helpers";

const SESSION_ID = "streamed-session";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const JOURNAL_NAME = `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`;
/** A text or buffer longer than this means a transcript was read or parsed whole. */
const WHOLE_VALUE_LIMIT = 16 * 1024 * 1024;
const REF_PREFIX = "blob:sha256:";

function sizeOf(value: string | ArrayBufferLike | ArrayBufferView): number {
	return typeof value === "string" ? value.length : value.byteLength;
}

/**
 * Run `action` while the entry points that read a file whole, join buffers,
 * decode text, or parse JSON record the longest text or buffer each takes or
 * makes. Returns `action`'s result and the entry points that passed
 * {@link WHOLE_VALUE_LIMIT}, with their longest value.
 */
async function watchWholeValues<T>(
	action: () => Promise<T>,
): Promise<{ result: T; oversized: Record<string, number> }> {
	const longest = new Map<string, number>();
	const note = (label: string, size: number): void => {
		if (size > (longest.get(label) ?? 0)) longest.set(label, size);
	};
	try {
		const parse = JSON.parse;
		vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
			note("JSON.parse", text.length);
			return parse(text, reviver);
		});
		const parseChunk = Bun.JSONL.parseChunk;
		vi.spyOn(Bun.JSONL, "parseChunk").mockImplementation((input, start, end) => {
			note("Bun.JSONL.parseChunk", sizeOf(input));
			return parseChunk(input, start, end);
		});
		const concat = Buffer.concat;
		vi.spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
			const joined = concat.call(Buffer, list, totalLength);
			note("Buffer.concat", joined.byteLength);
			return joined;
		});
		for (const [label, owner] of [
			["fs.promises.readFile", fs.promises],
			["fs/promises.readFile", fsp],
		] as const) {
			const readFile = owner.readFile;
			vi.spyOn(owner, "readFile").mockImplementation((async (...args: Parameters<typeof readFile>) => {
				const content = await readFile(...args);
				note(label, sizeOf(content));
				return content;
			}) as typeof readFile);
		}
		const decode = TextDecoder.prototype.decode;
		vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input, options) {
			const text = decode.call(this, input, options);
			note("TextDecoder.decode", text.length);
			return text;
		});
		const fileMethods = Object.getPrototypeOf(Bun.file(import.meta.path)) as BunFile;
		const bytes = fileMethods.bytes;
		vi.spyOn(fileMethods, "bytes").mockImplementation(async function (this: BunFile) {
			const content = await bytes.call(this);
			note("BunFile.bytes", content.byteLength);
			return content;
		});
		const arrayBuffer = fileMethods.arrayBuffer;
		vi.spyOn(fileMethods, "arrayBuffer").mockImplementation(async function (this: BunFile) {
			const content = await arrayBuffer.call(this);
			note("BunFile.arrayBuffer", content.byteLength);
			return content;
		});
		const text = fileMethods.text;
		vi.spyOn(fileMethods, "text").mockImplementation(async function (this: BunFile) {
			const content = await text.call(this);
			note("BunFile.text", content.length);
			return content;
		});
		const result = await action();
		return {
			result,
			oversized: Object.fromEntries([...longest].filter(([, size]) => size > WHOLE_VALUE_LIMIT)),
		};
	} finally {
		vi.restoreAllMocks();
	}
}

/** Store `bytes` in the current agent's blob store; returns its hash. */
async function storeBlob(bytes: Buffer): Promise<string> {
	return (await new BlobStore(getBlobsDir()).put(bytes)).hash;
}

function header(cwd: string): SessionHeader {
	return { type: "session", version: CURRENT_SESSION_VERSION, id: SESSION_ID, timestamp: TIMESTAMP, cwd };
}

/**
 * A ustar header for the file member `name` declaring `size` bytes, or for a symlink `name` to `linkTarget`:
 * the writer's header of an empty top-level member, its name, size, type, link target and checksum rewritten.
 */
async function tarHeaderDeclaring(name: string, size: number, linkTarget?: string): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const header = (await encodeArchive("tar", [["placeholder", ""]])).slice(0, 512);
	header.fill(0, 0, 100);
	header.set(encoder.encode(name), 0);
	header.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
	if (linkTarget !== undefined) {
		header.set(encoder.encode("2"), 156);
		header.set(encoder.encode(linkTarget), 157);
	}
	header.fill(0x20, 148, 156);
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
	return header;
}

/** The blobs the transcripts in `archive` (its journal and artifact `.jsonl` members) name that it has no `blobs/` member for. */
async function blobsMissingFrom(archive: string): Promise<string[]> {
	const members = await readArchiveEntries({ path: archive, format: "tar" });
	const missing = new Set<string>();
	for (const [name, bytes] of members) {
		if (name !== "session.jsonl" && !(name.startsWith("artifacts/") && name.endsWith(".jsonl"))) continue;
		for (const [, hash] of new TextDecoder().decode(bytes).matchAll(/\bblob:sha256:([a-f0-9]{64})\b/g)) {
			if (!members.has(`blobs/${hash}`)) missing.add(hash);
		}
	}
	return [...missing];
}

/** The members of a session archive whose journal holds 48 entries of 64 KiB of `fill`: over 3 MiB, so it is read in several chunks. */
function archiveMembers(fill: string): [string, string][] {
	const manifest = { version: SESSION_ARCHIVE_VERSION, id: SESSION_ID, cwd: "/laptop/project", omp: VERSION };
	const lines = [JSON.stringify(header("/laptop/project"))];
	for (let n = 0; n < 48; n++) {
		lines.push(
			JSON.stringify({
				type: "custom",
				customType: "pad",
				id: `p${n}`,
				parentId: n === 0 ? null : `p${n - 1}`,
				timestamp: TIMESTAMP,
				data: fill.repeat(64 * 1024),
			}),
		);
	}
	return [
		["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
		["session.jsonl", `${lines.join("\n")}\n`],
	];
}

/** The one character a padding entry's `data` repeats; `mixed` when it holds two. */
function fillOf(data: unknown): string {
	const text = String(data);
	return text.replaceAll(text[0] ?? "", "") === "" ? (text[0] ?? "") : "mixed";
}

describe("omp session pack/unpack of a long session", () => {
	let cleanup: AsyncDisposableStack;
	let root: string;
	let agentA: string;
	let agentB: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		// Disposed in reverse: mocks, the session index, the agent directory, then the temp directory. Each step
		// runs even when one before it throws.
		cleanup = new AsyncDisposableStack();
		root = cleanup.use(await TempDir.create("@omp-session-transfer-streamed-")).path();
		agentA = path.join(root, "agent-a");
		agentB = path.join(root, "agent-b");
		cwdA = path.join(root, "laptop", "project");
		cwdB = path.join(root, "cloud", "project");
		await fs.promises.mkdir(cwdA, { recursive: true });
		await fs.promises.mkdir(cwdB, { recursive: true });
		cleanup.defer(() => {
			if (originalAgentDir) {
				setAgentDir(originalAgentDir);
			} else {
				setAgentDir(path.join(getConfigRootDir(), "agent"));
				delete process.env.PI_CODING_AGENT_DIR;
			}
		});
		setAgentDir(agentA);
		cleanup.defer(() => closeSessionIndex());
		cleanup.defer(() => vi.restoreAllMocks());
	});

	afterEach(() => cleanup.disposeAsync(), 30_000);

	it("packs a journal over 32 MB to the bytes the in-memory writer gives and unpacks it whole, holding no text or buffer over 16 MiB", async () => {
		const journalImage = Buffer.alloc(4096, 7);
		const artifactImage = Buffer.alloc(4096, 9);
		const journalBlob = await storeBlob(journalImage);
		const artifactBlob = await storeBlob(artifactImage);

		const source = path.join(root, "sessions", JOURNAL_NAME);
		const body = "long transcript text ".repeat(3200);
		const lines = [JSON.stringify(header(cwdA))];
		let size = lines[0].length;
		let parentId: string | null = null;
		for (let turn = 0; size <= 34 * 1024 * 1024; turn++) {
			const user = {
				type: "message",
				id: `u${turn}`,
				parentId,
				timestamp: TIMESTAMP,
				message: {
					role: "user",
					content: [
						{ type: "text", text: `${turn} ${body}` },
						...(turn % 100 === 0
							? [{ type: "image", data: `${REF_PREFIX}${journalBlob}`, mimeType: "image/png" }]
							: []),
					],
					timestamp: 1,
				},
			};
			const assistant = {
				type: "message",
				id: `a${turn}`,
				parentId: `u${turn}`,
				timestamp: TIMESTAMP,
				message: { ...makeAssistantMessage(), content: [{ type: "text", text: `${turn} ${body}` }], timestamp: 2 },
			};
			parentId = `a${turn}`;
			for (const entry of [user, assistant]) {
				const line = JSON.stringify(entry);
				lines.push(line);
				size += line.length + 1;
			}
		}
		await Bun.write(source, `${lines.join("\n")}\n`);
		lines.length = 0;
		const artifactsDir = source.slice(0, -".jsonl".length);
		const artifacts: [string, string][] = [
			[
				"0-Explore.jsonl",
				`${JSON.stringify({ type: "session", id: "sub", cwd: "/x" })}\n${JSON.stringify({ image: `${REF_PREFIX}${artifactBlob}` })}\n`,
			],
			["nested/1.bash.log", "build output"],
		];
		for (const [relative, content] of artifacts) await Bun.write(path.join(artifactsDir, relative), content);

		const archive = path.join(root, "out", "session.tar");
		const pack = await watchWholeValues(() => packSession(source, archive));
		expect(pack.oversized).toEqual({});
		expect(pack.result.missingBlobs).toEqual([]);

		// The archive the in-memory writer makes of the same members, in the same order.
		const expected = path.join(root, "expected.tar");
		const manifest = { version: SESSION_ARCHIVE_VERSION, id: SESSION_ID, cwd: cwdA, omp: VERSION };
		await writeArchive(expected, "tar", [
			["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
			["session.jsonl", await Bun.file(source).bytes()],
			...artifacts.map(([relative, content]) => [`artifacts/${relative}`, content] as const),
			...[
				[journalBlob, journalImage],
				[artifactBlob, artifactImage],
			]
				.sort(([left], [right]) => (left < right ? -1 : 1))
				.map(([hash, bytes]) => [`blobs/${hash}`, bytes] as const),
		]);
		expect(Bun.file(archive).size).toBe(Bun.file(expected).size);
		expect(await sha256File(archive)).toBe(await sha256File(expected));

		// The cloud machine already holds a copy of the session, so unpack also checks that it is a prefix.
		setAgentDir(agentB);
		const sessionDir = SessionManager.getDefaultSessionDir(cwdB);
		await fs.promises.mkdir(sessionDir, { recursive: true });
		await fs.promises.copyFile(source, path.join(sessionDir, JOURNAL_NAME));
		const unpack = await watchWholeValues(() => unpackSession(archive, { cwd: cwdB }));
		expect(unpack.oversized).toEqual({});
		expect(unpack.result.mode).toBe("replaced");
		expect(unpack.result.id).toBe(SESSION_ID);

		const before = await loadEntriesFromFile(source);
		const after = await loadEntriesFromFile(unpack.result.sessionFile);
		expect(after[0]).toMatchObject({ type: "session", id: SESSION_ID, cwd: path.resolve(cwdB) });
		expect(after.slice(1, -1)).toEqual(before.slice(1));
		expect(after.at(-1)).toMatchObject({ type: "custom_message", customType: SESSION_TRANSFER_MESSAGE_TYPE });

		const unpackedArtifacts = unpack.result.sessionFile.slice(0, -".jsonl".length);
		for (const [relative, content] of artifacts) {
			expect(await Bun.file(path.join(unpackedArtifacts, relative)).text()).toBe(content);
		}
		const blobs = new BlobStore(getBlobsDir());
		expect(await blobs.get(journalBlob)).toEqual(journalImage);
		expect(await blobs.get(artifactBlob)).toEqual(artifactImage);
	}, 120_000);

	it("packs a blob that a reference split by a scan chunk edge names", async () => {
		// One reference straddles every 64 KiB boundary; file stream chunks end on such boundaries.
		const boundary = 64 * 1024;
		const refLinePrefix = '{"type":"custom","customType":"ref","data":"';
		const fillerPrefix = '{"type":"custom","customType":"filler","data":"';
		const refStarts: number[] = [];
		const hashes: string[] = [];
		let journal = `${JSON.stringify(header(cwdA))}\n`;
		for (let edge = boundary; edge <= 48 * boundary; edge += boundary) {
			const hash = await storeBlob(Buffer.from(`image at ${edge}`));
			hashes.push(hash);
			const refStart = edge - 38;
			const filler = refStart - refLinePrefix.length - journal.length - fillerPrefix.length - '"}\n'.length;
			journal += `${fillerPrefix}${"x".repeat(filler)}"}\n${refLinePrefix}`;
			refStarts.push(journal.length);
			journal += `${REF_PREFIX}${hash}"}\n`;
		}
		const source = path.join(root, "sessions", JOURNAL_NAME);
		await Bun.write(source, journal);

		// The case only proves something when a chunk of the file's stream ends inside a reference.
		const refLength = REF_PREFIX.length + 64;
		let offset = 0;
		let splitRefs = 0;
		for await (const chunk of Bun.file(source).stream()) {
			offset += chunk.byteLength;
			if (refStarts.some(start => start < offset && offset < start + refLength)) splitRefs++;
		}
		expect(splitRefs).toBeGreaterThan(0);

		const archive = path.join(root, "session.tar");
		const packed = await packSession(source, archive);
		expect(packed.missingBlobs).toEqual([]);
		const members = await readArchiveEntries({ path: archive, format: "tar" });
		const packedBlobs = [...members.keys()].filter(name => name.startsWith("blobs/")).map(name => name.slice(6));
		expect(packedBlobs.sort()).toEqual(hashes.sort());
	}, 30_000);

	it("refuses an archive whose member headers total more than 2 GiB, before staging any member", async () => {
		// Two members under the 2 GiB member limit in a sparse file: only their headers hold bytes.
		const memberSize = Math.round(1.2 * 1024 ** 3);
		const paddedSize = Math.ceil(memberSize / 512) * 512;
		const archive = path.join(root, "huge.tar");
		const file = await fs.promises.open(archive, "w");
		try {
			await file.write(await tarHeaderDeclaring("manifest.json", memberSize), 0, 512, 0);
			await file.write(await tarHeaderDeclaring("session.jsonl", memberSize), 0, 512, 512 + paddedSize);
			await file.truncate(2 * (512 + paddedSize) + 1024);
		} finally {
			await file.close();
		}

		setAgentDir(agentB);
		const memberReads = vi.spyOn(ArchiveReader.prototype, "readFileChunks");
		await expect(unpackSession(archive, { cwd: cwdB })).rejects.toThrow(
			`Bad session archive ${archive}: Archive is too large to read in memory (${formatBytes(2 * memberSize)} > ${formatBytes(2 * 1024 ** 3)} limit)`,
		);
		expect(memberReads).not.toHaveBeenCalled();
		expect(await findSessionFiles(SESSION_ID)).toEqual([]);
	}, 30_000);

	it("refuses an archive whose members total more than 2 GiB once a directory symlink is followed, before staging any member", async () => {
		// `artifacts/alias` links to `artifacts/real`, so the 1-byte record `artifacts/alias/big.bin` is read
		// as `artifacts/real/big.bin`: the headers declare 1.2 GiB and 1 byte, staging would write 2.4 GiB.
		const memberSize = Math.round(1.2 * 1024 ** 3);
		const archive = path.join(root, "aliased.tar");
		const file = await fs.promises.open(archive, "w");
		try {
			let offset = 0;
			for (const [block, paddedSize] of [
				[await tarHeaderDeclaring("artifacts/real/big.bin", memberSize), Math.ceil(memberSize / 512) * 512],
				[await tarHeaderDeclaring("artifacts/alias", 0, "real"), 0],
				[await tarHeaderDeclaring("artifacts/alias/big.bin", 1), 512],
			] as const) {
				await file.write(block, 0, 512, offset);
				offset += 512 + paddedSize;
			}
			// Sparse: only the headers hold bytes; the end-of-archive blocks are zeros.
			await file.truncate(offset + 1024);
		} finally {
			await file.close();
		}
		// The case holds only when the raw sizes stay under the limit and the alias resolves to the large member.
		const index = await openArchive({ path: archive, format: "tar" });
		const files = [...index.indexEntries()].filter(entry => !entry.isDirectory);
		expect(files.reduce((sum, entry) => sum + entry.size, 0)).toBe(memberSize + 1);
		expect(index.getNode("artifacts/alias/big.bin")?.size).toBe(memberSize);

		setAgentDir(agentB);
		// Staging a member is the failure this case guards against: refuse it at once instead of writing 2.4 GiB.
		const memberReads = vi.spyOn(ArchiveReader.prototype, "readFileChunks").mockImplementation(() => {
			throw new Error("A member was staged before the archive's size was checked");
		});
		await expect(unpackSession(archive, { cwd: cwdB })).rejects.toThrow(
			`Bad session archive ${archive}: Archive is too large to read in memory (${formatBytes(2 * memberSize)} > ${formatBytes(2 * 1024 ** 3)} limit)`,
		);
		expect(memberReads).not.toHaveBeenCalled();
		expect(await findSessionFiles(SESSION_ID)).toEqual([]);
	}, 30_000);

	it("refuses a blob member whose bytes do not match its name, before anything reaches the blob store or a session directory", async () => {
		const named = Buffer.from("the image the member's name promises");
		const carried = Buffer.from("other bytes in its place");
		const namedHash = new Bun.CryptoHasher("sha256").update(named).digest("hex");
		const carriedHash = new Bun.CryptoHasher("sha256").update(carried).digest("hex");
		const archive = path.join(root, "bad-blob.tar");
		const manifest = { version: SESSION_ARCHIVE_VERSION, id: SESSION_ID, cwd: cwdA, omp: VERSION };
		await writeArchive(archive, "tar", [
			["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
			["session.jsonl", `${JSON.stringify(header(cwdA))}\n`],
			[`blobs/${namedHash}`, carried],
		]);

		setAgentDir(agentB);
		await expect(unpackSession(archive, { cwd: cwdB })).rejects.toThrow(
			`Bad session archive ${archive}: blob ${namedHash} fails its sha256 check (content hashes to ${carriedHash}). Nothing was unpacked.`,
		);
		const blobs = new BlobStore(getBlobsDir());
		expect(await blobs.has(namedHash)).toBe(false);
		expect(await blobs.has(carriedHash)).toBe(false);
		expect(await findSessionFiles(SESSION_ID)).toEqual([]);
	}, 30_000);

	// Regressed: a subagent transcript that names another image while its session is packed lands in the
	// archive without that image, so the session unpacked on the other machine shows the image missing.
	it.each([
		{
			writer: "appends a line naming another blob to",
			write: (artifact: string, _scanned: string, added: string) =>
				fs.promises.appendFile(artifact, `${JSON.stringify({ image: `${REF_PREFIX}${added}` })}\n`),
		},
		{
			writer: "rewrites to the same size, naming another blob,",
			write: async (artifact: string, scanned: string, added: string) =>
				Bun.write(artifact, (await Bun.file(artifact).text()).replace(scanned, added)),
		},
	])(
		"packs every blob an artifact transcript names when another writer $writer it just before the archive takes it",
		async ({ write }) => {
			const scanned = await storeBlob(Buffer.from("the image the transcript names first"));
			const added = await storeBlob(Buffer.from("the image the other writer names"));
			const source = path.join(root, "sessions", JOURNAL_NAME);
			await Bun.write(source, `${JSON.stringify(header(cwdA))}\n`);
			const artifactMember = "artifacts/0-Explore.jsonl";
			const artifact = path.join(source.slice(0, -".jsonl".length), "0-Explore.jsonl");
			await Bun.write(
				artifact,
				`${JSON.stringify({ type: "session", id: "sub", cwd: "/x" })}\n${JSON.stringify({ image: `${REF_PREFIX}${scanned}` })}\n`,
			);
			// The other writer acts when the archive writer takes the artifact member: after the members before
			// it are written and after any read of the transcripts ahead of the write, before its bytes stream.
			const writeTarArchive = ar.writeTarArchive;
			let raced = false;
			vi.spyOn(ar, "writeTarArchive").mockImplementation((destPath, entries) =>
				writeTarArchive(
					destPath,
					(async function* () {
						for await (const member of entries) {
							if (member[0] === artifactMember && !raced) {
								await write(artifact, scanned, added);
								raced = true;
							}
							yield member;
						}
					})(),
				),
			);

			const archive = path.join(root, "out", "session.tar");
			const packed = await packSession(source, archive);

			expect(raced).toBe(true);
			expect(packed.missingBlobs).toEqual([]);
			// The archive holds the artifact as the other writer left it, and every blob that text names.
			const members = await readArchiveEntries({ path: archive, format: "tar" });
			expect(new TextDecoder().decode(members.get(artifactMember))).toBe(await Bun.file(artifact).text());
			expect(await blobsMissingFrom(archive)).toEqual([]);
		},
		30_000,
	);

	// Regressed: an archive replaced (renamed over) while it is unpacked lands a journal made of both
	// archives' bytes, so the session on this machine holds turns that no session ever had.
	// Windows can refuse to rename over a file that is still open.
	it.skipIf(process.platform === "win32")(
		"unpacks the original archive's journal when another archive is renamed over it during the unpack",
		async () => {
			const archive = path.join(root, "session.tar");
			const replacement = path.join(root, "replacement.tar");
			await writeArchive(archive, "tar", archiveMembers("a"));
			await writeArchive(replacement, "tar", archiveMembers("b"));
			expect(Bun.file(replacement).size).toBe(Bun.file(archive).size);
			// The replacement lands right after the first chunk of the journal member is read. The rename counts
			// only once it succeeded, and the chunks read after it show the journal was still being read.
			const readFileChunks = ArchiveReader.prototype.readFileChunks;
			let renamed = false;
			let chunksAfterRename = 0;
			vi.spyOn(ArchiveReader.prototype, "readFileChunks").mockImplementation(function (
				this: ArchiveReader,
				subPath: string,
			) {
				const chunks = readFileChunks.call(this, subPath);
				if (subPath !== "session.jsonl") return chunks;
				return (async function* () {
					for await (const chunk of chunks) {
						if (renamed) chunksAfterRename++;
						yield chunk;
						if (renamed) continue;
						await fs.promises.rename(replacement, archive);
						renamed = true;
					}
				})();
			});

			setAgentDir(agentB);
			const unpacked = await unpackSession(archive, { cwd: cwdB });

			expect(renamed).toBe(true);
			expect(chunksAfterRename).toBeGreaterThan(0);
			const entries = await loadEntriesFromFile(unpacked.sessionFile);
			const fills = new Set(entries.flatMap(entry => (entry.type === "custom" ? [fillOf(entry.data)] : [])));
			expect([...fills]).toEqual(["a"]);
		},
		30_000,
	);
});
