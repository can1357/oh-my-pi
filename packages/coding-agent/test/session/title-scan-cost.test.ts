import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findMostRecentNonEmptySession,
	listSessions,
	resolveResumableSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { parseSessionContent, readLatestSessionTitle } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { getConfigRootDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const ISO = "2026-06-29T12:00:00.000Z";
const header = (id: string) => ({ type: "session", version: 3, id, timestamp: ISO, cwd: "/project" });
const title = (text: string, id = "rename") => ({
	type: "title_change",
	id,
	parentId: null,
	timestamp: ISO,
	title: text,
	source: "user",
});
const message = (role: string, content: string, stopReason?: string) => ({
	type: "message",
	id: "turn",
	parentId: null,
	timestamp: ISO,
	message: { role, content, timestamp: 1, stopReason },
});

class ObservedFileStorage extends FileSessionStorage {
	readonly slices: Array<{ file: string; suffix: number }> = [];
	override readTextSlices(file: string, prefix: number, suffix: number): Promise<[string, string]> {
		this.slices.push({ file, suffix });
		return super.readTextSlices(file, prefix, suffix);
	}
}

describe("title scan work stays proportional to the requested lookup", () => {
	let root: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-title-scan-cost-"));
		setAgentDir(path.join(root, "agent"));
	});
	afterEach(() => {
		setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		fs.rmSync(root, { recursive: true, force: true });
	});

	function write(dir: string, name: string, id: string, records: unknown[] = [], mtime = 1): string {
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${name}.jsonl`);
		fs.writeFileSync(file, `${[header(id), ...records].map(record => JSON.stringify(record)).join("\n")}\n`);
		fs.utimesSync(file, mtime, mtime);
		return file;
	}

	it("never decodes or parses large non-title physical records during a File titles-only scan", async () => {
		const file = write(root, "large", "large", [
			message("toolResult", "x".repeat(512 * 1024)),
			message("user", "y".repeat(512 * 1024)),
			title("Latest journal title"),
			message("assistant", "z".repeat(512 * 1024), "stop"),
		]);
		const decode = spyOn(TextDecoder.prototype, "decode");
		const parse = spyOn(JSON, "parse");
		const parseChunk = spyOn(Bun.JSONL, "parseChunk");
		try {
			expect((await readLatestSessionTitle(file, new FileSessionStorage()))?.title).toBe("Latest journal title");
			const decodedLargeRecords = decode.mock.calls.filter(([input]) => (input?.byteLength ?? 0) > 64 * 1024).length;
			const parsedLargeRecords = parse.mock.calls.filter(([input]) => input.length > 64 * 1024).length;
			const parsedChunkBytes = parseChunk.mock.calls.reduce((sum, [input, start, end]) => {
				const bytes = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
				return sum + ((end ?? bytes) - (start ?? 0));
			}, 0);
			expect(decodedLargeRecords).toBe(0);
			expect(parsedLargeRecords).toBe(0);
			expect(parsedChunkBytes).toBeLessThan(64 * 1024);
		} finally {
			decode.mockRestore();
			parse.mockRestore();
			parseChunk.mockRestore();
		}
	});

	for (const chunkBytes of [7, 4096, Number.POSITIVE_INFINITY]) {
		it(`preserves multiline, marker content, recovery and physical title order in ${chunkBytes}-byte chunks`, async () => {
			const finalTitle = 'Last 🌏 café "title_change"';
			const multilineTitle = `{"decoy":{"type":"message"}\n,"type":"title_change","id":"multiline","parentId":null,"timestamp":"${ISO}","source":"user","title":"multiline 🌏"}`;
			const content = [
				serializeTitleSlot({ title: "Stale slot", source: "auto", updatedAt: ISO }),
				JSON.stringify(header("multiline")),
				JSON.stringify(title("First", "first")),
				multilineTitle,
				'{"broken":oops}',
				JSON.stringify({ ...message("user", "not a title"), marker: "title_change", title: "Decoy" }),
				JSON.stringify(title(finalTitle, "last")),
				JSON.stringify({ ...message("toolResult", "trailing 🌏"), title_change: "Not a rename" }),
			].join("\n");
			const file = path.join(root, "multiline.jsonl");
			fs.writeFileSync(file, content);
			const expected = parseSessionContent(content).latestTitle;
			let bytes = Buffer.from(content);
			const realFile = Bun.file.bind(Bun);
			const fileSpy = spyOn(Bun, "file").mockImplementation((arg: unknown, options?: BlobPropertyBag) => {
				const handle = realFile(arg as string, options);
				if (arg === file) {
					handle.stream = () =>
						(async function* () {
							for (let start = 0; start < bytes.length; start += chunkBytes)
								yield bytes.subarray(start, start + chunkBytes);
						})() as unknown as ReadableStream<Uint8Array<ArrayBuffer>>;
				}
				return handle;
			});
			try {
				expect(expected?.title).toBe(finalTitle);
				expect(await readLatestSessionTitle(file, new FileSessionStorage())).toEqual(expected);
				// The final single-line rename must not mask a dropped multiline rename.
				bytes = Buffer.from(content.slice(0, content.indexOf(JSON.stringify(title(finalTitle, "last")))));
				expect((await readLatestSessionTitle(file, new FileSessionStorage()))?.title).toBe("multiline 🌏");
			} finally {
				fileSpy.mockRestore();
			}
		});
	}

	it("uses authoritative optional metadata without reading the journal, including an untitled result", async () => {
		class MetadataStorage extends MemorySessionStorage {
			reads = 0;
			metadataReads: string[] = [];
			async readLatestTitle(file: string) {
				this.metadataReads.push(file);
				return file === "/titled" ? { title: "Indexed title", source: "user" as const, updatedAt: ISO } : undefined;
			}
			override readText(file: string): Promise<string> {
				this.reads++;
				return super.readText(file);
			}
		}
		const storage = new MetadataStorage();
		storage.writeTextSync("/titled", `${JSON.stringify(header("titled"))}\n`);
		storage.writeTextSync("/untitled", `${JSON.stringify(header("untitled"))}\n`);
		expect((await readLatestSessionTitle("/titled", storage))?.title).toBe("Indexed title");
		expect(await readLatestSessionTitle("/untitled", storage)).toBeUndefined();
		expect(storage.metadataReads).toEqual(["/titled", "/untitled"]);
		expect(storage.reads).toBe(0);
	});

	it("does not resurrect a stale header title after an explicit journal clear", async () => {
		const file = path.join(root, "cleared.jsonl");
		fs.writeFileSync(
			file,
			`${JSON.stringify({ ...header("cleared"), title: "Stale title" })}\n${JSON.stringify({
				...title(""),
				title: undefined,
			})}\n`,
		);
		const sessions = await listSessions(root, new FileSessionStorage());
		expect(sessions).toHaveLength(1);
		expect(sessions[0].title).toBeUndefined();
	});

	it("--continue reads only newer empty stubs and the newest useful candidate, never older journals", async () => {
		const dir = path.join(root, "continue");
		write(dir, "older", "older", [title("Old title"), message("assistant", "old", "stop")], 1);
		const useful = write(dir, "useful", "useful", [message("assistant", "latest reply", "stop")], 2);
		const empty = write(dir, "empty", "empty", [], 3);
		const storage = new ObservedFileStorage();
		expect(await findMostRecentNonEmptySession(dir, storage)).toBe(useful);
		expect(storage.slices.map(read => read.file)).toEqual([empty, useful]);
		expect(storage.slices.every(read => read.suffix > 0)).toBe(true);
	});

	it("resume by header ID reads metadata only for the matching local journal", async () => {
		const dir = path.join(root, "local");
		write(dir, "unrelated_newer", "unrelated", [message("toolResult", "x".repeat(256 * 1024))], 3);
		const target = write(dir, "arbitrary-name", "Wanted-Header-ID", [title("Wanted title")], 2);
		write(dir, "unrelated_older", "older", [title("Other title")], 1);
		const storage = new ObservedFileStorage();
		const match = await resolveResumableSession("wAnTeD-hEaD", "/project", dir, storage);
		expect(match?.session.path).toBe(target);
		expect(match?.session.title).toBe("Wanted title");
		expect(match?.scope).toBe("local");
		expect(storage.slices.filter(read => read.suffix > 0).map(read => read.file)).toEqual([target]);
	});

	it("resume global fallback scans no unrelated local or global journal metadata", async () => {
		const local = path.join(root, "custom");
		write(local, "unrelated_local", "local", [message("toolResult", "x".repeat(256 * 1024))], 4);
		write(path.join(getSessionsDir(), "project-a"), "unrelated_global", "global", [title("Other title")], 3);
		const target = write(
			path.join(getSessionsDir(), "project-b"),
			"timestamp_Wanted-Filename-ID",
			"different-header",
			[title("Global title")],
			2,
		);
		const storage = new ObservedFileStorage();
		const match = await resolveResumableSession("wAnTeD-fIlE", "/project", local, storage, {
			allowGlobalFallback: true,
		});
		expect(match?.session.path).toBe(target);
		expect(match?.scope).toBe("global");
		expect(storage.slices.filter(read => read.suffix > 0).map(read => read.file)).toEqual([target]);
	});

	it("keeps combined filename/header prefix ordering and local precedence while rejecting malformed matches", async () => {
		const local = path.join(root, "precedence");
		write(local, "timestamp_prefix-old", "different", [title("Older filename match")], 1);
		const newest = write(local, "custom-name", "Prefix-New", [title("Newest local")], 2);
		const invalid = path.join(local, "timestamp_prefix-invalid.jsonl");
		fs.writeFileSync(invalid, "not a session\n");
		fs.utimesSync(invalid, 3, 3);
		write(path.join(getSessionsDir(), "other"), "timestamp_prefix-global", "prefix-global", [title("Global")], 4);
		const match = await resolveResumableSession("PREFIX", "/project", local, { allowGlobalFallback: true });
		expect(match?.session.path).toBe(newest);
		expect(match?.scope).toBe("local");
	});

	it("keeps absent and ENOTDIR custom lookups scoped unless global fallback is requested", async () => {
		const global = write(path.join(getSessionsDir(), "other"), "timestamp_lookup", "lookup", [title("Global")]);
		const notDirectory = path.join(root, "not-a-directory");
		fs.writeFileSync(notDirectory, "file");
		for (const local of [path.join(root, "absent"), path.join(notDirectory, "child")]) {
			expect(await resolveResumableSession("lookup", "/project", local)).toBeUndefined();
			const fallback = await resolveResumableSession("lookup", "/project", local, { allowGlobalFallback: true });
			expect(fallback?.session.path).toBe(global);
		}
	});
});
