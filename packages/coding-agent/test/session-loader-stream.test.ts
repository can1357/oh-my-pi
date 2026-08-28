import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

// Parity contract for the ≥8MiB streaming loader (now Bun.JSONL-based): it must
// produce the SAME entries + titleSlot as the common-path parser
// (parseSessionContent, which uses parseJsonlLenient) on identical content —
// including a first-line title slot, blank lines, and malformed JSON lines that
// must be skipped rather than thrown on. loadEntriesFromFileStream works on any
// file size (the 8MiB threshold is only the routing decision in
// loadEntriesFromFile), so a small fixture exercises the full code path.

const ISO = "2026-06-29T12:00:00.000Z";
const HEADER = { type: "session", version: 3, id: "s1", timestamp: ISO, cwd: "/tmp" };

const msg = (id: string, parentId: string, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: ISO,
	message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});

let dir: string | undefined;
afterEach(() => {
	if (dir) {
		fs.rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
});

async function writeTemp(content: string): Promise<string> {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-loader-test-"));
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, content);
	return file;
}

function entryTypes(entries: FileEntry[]): string[] {
	return entries.map(entry => entry.type);
}

function entryIds(entries: FileEntry[]): string[] {
	return entries.map(entry => entry.id);
}

function messageIds(entries: FileEntry[]): string[] {
	return entries.filter(entry => entry.type === "message").map(entry => entry.id);
}

function messageTexts(entries: FileEntry[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message: unknown = entry.message;
		if (!message || typeof message !== "object" || !("content" in message)) continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		const first = content[0];
		if (
			first &&
			typeof first === "object" &&
			"type" in first &&
			first.type === "text" &&
			"text" in first &&
			typeof first.text === "string"
		) {
			texts.push(first.text);
		}
	}
	return texts;
}

describe("loadEntriesFromFileStream (Bun.JSONL parity)", () => {
	it("visits entries incrementally while skipping malformed lines", async () => {
		const slotLine = serializeTitleSlot({ title: "Visitor", source: "user", updatedAt: ISO });
		const content = [
			slotLine,
			JSON.stringify(HEADER),
			JSON.stringify(msg("m1", "s1", "first")),
			"{ this is not valid json",
			JSON.stringify(msg("m2", "m1", "second")),
		].join("\n");
		const file = await writeTemp(content);
		const visited: FileEntry[] = [];
		const titleSlot = await sessionLoader.visitEntriesFromFileStream(file, entry => {
			visited.push(entry);
		});

		expect(titleSlot?.title).toBe("Visitor");
		expect(entryIds(visited)).toEqual(["s1", "m1", "m2"]);
		expect(visited[0]).toMatchObject({ title: "Visitor", titleSource: "user" });
		expect((await sessionLoader.loadEntriesFromFileStream(file)).malformedRecords).toBe(1);
	});

	it("visits a large journal before reading its tail", async () => {
		const largeText = "x".repeat(1024 * 1024);
		const slotLine = serializeTitleSlot({ title: "Visitor", source: "user", updatedAt: ISO });
		const lines = [slotLine, JSON.stringify({ ...HEADER, title: "stale", titleSource: "generated" })];
		for (let index = 1; index <= 9; index++) {
			lines.push(JSON.stringify(msg(`m${index}`, index === 1 ? "s1" : `m${index - 1}`, largeText)));
		}
		const file = await writeTemp(`${lines.join("\n")}\n`);
		expect(fs.statSync(file).size).toBeGreaterThan(8 * 1024 * 1024);

		let visited = 0;
		let headerTitle: string | undefined;
		let headerTitleSource: string | undefined;
		await sessionLoader.visitEntriesFromFile(file, entry => {
			visited++;
			if (entry.type === "session") {
				headerTitle = entry.title;
				headerTitleSource = entry.titleSource;
			}
			if (visited === 1) fs.truncateSync(file, 0);
		});

		// A collecting load reads the tail before the first callback and would
		// still visit every in-memory entry after the file is truncated.
		expect(visited).toBeLessThan(10);
		expect(headerTitle).toBe("Visitor");
		expect(headerTitleSource).toBe("user");
	});

	it("does not revisit entries before a malformed line spanning stream chunks", async () => {
		const content = [
			JSON.stringify(HEADER),
			JSON.stringify(msg("m1", "s1", "first")),
			`{ this is not valid json ${"x".repeat(256 * 1024)}`,
			JSON.stringify(msg("m2", "m1", "second")),
		].join("\n");
		const file = await writeTemp(content);
		const visited: FileEntry[] = [];

		await sessionLoader.visitEntriesFromFileStream(file, entry => {
			visited.push(entry);
		});

		expect(entryIds(visited)).toEqual(["s1", "m1", "m2"]);
	});

	it("bounds visitor scans by physical records, including malformed lines", async () => {
		const content = [
			JSON.stringify(HEADER),
			"{ malformed one",
			"{ malformed two",
			"{ malformed three",
			JSON.stringify(msg("after-bad", "s1", "must not be visited")),
		].join("\n");
		const file = await writeTemp(content);
		const visited: FileEntry[] = [];

		await sessionLoader.visitEntriesFromFileStream(
			file,
			entry => {
				visited.push(entry);
			},
			{ maxRecords: 2 },
		);

		expect(entryIds(visited)).toEqual(["s1"]);
	});

	it("propagates ENOENT errors thrown by the visitor", async () => {
		const file = await writeTemp(`${JSON.stringify(HEADER)}\n`);
		const failure = Object.assign(new Error("visitor failed"), { code: "ENOENT" });

		await expect(
			sessionLoader.visitEntriesFromFileStream(file, () => {
				throw failure;
			}),
		).rejects.toBe(failure);
	});

	it("matches parseSessionContent on title slot + valid + malformed + blank lines", async () => {
		const slotLine = serializeTitleSlot({ title: "Hello world", source: "user", updatedAt: ISO });
		// title slot | header | valid | blank | malformed | valid | malformed-no-newline-at-EOF
		const lines = [
			slotLine,
			JSON.stringify(HEADER),
			JSON.stringify(msg("m1", "s1", "first")),
			"",
			"{ this is not valid json",
			JSON.stringify(msg("m2", "m1", "second after bad line")),
		];
		const content = lines.join("\n"); // no trailing newline on the last line
		const file = await writeTemp(content);

		const stream = await sessionLoader.loadEntriesFromFileStream(file);
		const reference = sessionLoader.parseSessionContent(content);

		// Parity: the stream path must agree with the common path exactly.
		expect(stream).toEqual(reference);
		// And the concrete contracts that parity implies:
		expect(stream.titleSlot?.title).toBe("Hello world"); // title slot peeled + folded
		expect(entryTypes(stream.entries)).toEqual(["session", "message", "message"]);
		const ids = messageIds(stream.entries);
		expect(ids).toEqual(["m1", "m2"]); // valid entries kept in order, malformed skipped
		expect(stream.malformedRecords).toBe(1);
	});

	it("matches parseSessionContent when there is no title slot (header is the first line)", async () => {
		const lines = [
			JSON.stringify(HEADER),
			JSON.stringify(msg("m1", "s1", "first")),
			"",
			JSON.stringify(msg("m2", "m1", "second")),
		];
		const content = lines.join("\n");
		const file = await writeTemp(content);

		const stream = await sessionLoader.loadEntriesFromFileStream(file);
		const reference = sessionLoader.parseSessionContent(content);

		expect(stream).toEqual(reference);
		expect(stream.titleSlot).toBeUndefined();
		expect(entryIds(stream.entries)).toEqual(["s1", "m1", "m2"]);
	});

	it("matches parseSessionContent on multibyte UTF-8 spanning many stream chunks", async () => {
		// Fixture larger than Bun's default stream chunk (~64KiB) with multibyte
		// content (✓ is 3 bytes, emoji 4) that must survive chunk-boundary splits
		// without U+FFFD corruption — the regression this path had when the buffer
		// was a decoded string concatenated per chunk.
		const multibyte = "✓ checkmark, 🚀 emoji, こんにちは unicode ✓ ".repeat(20);
		const lines: string[] = [JSON.stringify(HEADER)];
		for (let i = 1; lines.join("\n").length < 128 * 1024; i++) {
			lines.push(JSON.stringify(msg(`m${i}`, i === 1 ? "s1" : `m${i - 1}`, multibyte)));
		}
		const content = lines.join("\n");
		const file = await writeTemp(content);

		const stream = await sessionLoader.loadEntriesFromFileStream(file);
		const reference = sessionLoader.parseSessionContent(content);

		// Parity (a corrupted multibyte sequence would diverge here) ...
		expect(stream).toEqual(reference);
		// ... and explicitly: every entry's text round-trips intact, no U+FFFD.
		for (const text of messageTexts(stream.entries)) {
			expect(text).toBe(multibyte);
			expect(text.includes("\uFFFD")).toBe(false);
		}
	});

	it("returns empty for a missing file (ENOENT)", async () => {
		const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.jsonl`);
		const stream = await sessionLoader.loadEntriesFromFileStream(missing);
		expect(stream.entries).toEqual([]);
		expect(stream.titleSlot).toBeUndefined();
		expect(stream.malformedRecords).toBe(0);
	});
});
