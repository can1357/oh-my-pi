import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolPresentationEvent, TruncationFactMeta } from "@oh-my-pi/pi-agent-core/presentation";
import { byteLengthOf, byteOffset, streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import {
	enforceInlineByteCap,
	formatHeadTruncationNotice,
	formatMiddleElisionMarker,
	formatTailTruncationNotice,
	OutputSink,
	PRESENTATION_MAX_RETAINED_BYTES,
	TailBuffer,
	truncateHead,
	truncateHeadBytes,
	truncateLine,
	truncateMiddle,
	truncateTail,
	truncateTailBytes,
} from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { formatOutputNotice, outputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

const createdTempDirs: string[] = [];
const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "streaming-output-test-"));
	createdTempDirs.push(dir);
	return dir;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

afterEach(async () => {
	vi.useRealTimers();
	for (const dir of createdTempDirs.splice(0)) {
		await removeWithRetries(dir);
	}
	if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
	if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
});

describe("truncateTailBytes", () => {
	test("returns source when already under limit", () => {
		const text = "hello";
		expect(truncateTailBytes(text, 10)).toEqual({ text: "hello", bytes: 5 });
	});

	test("truncates from end without breaking UTF-8 boundaries", () => {
		const text = "a😀b";
		const result = truncateTailBytes(text, 4);
		expect(result).toEqual({ text: "b", bytes: 1 });
		expect(result.text).not.toContain("\uFFFD");
	});

	test("accepts Uint8Array input", () => {
		const bytes = new TextEncoder().encode("abc😀");
		const result = truncateTailBytes(bytes, 4);
		expect(result.text).toBe("😀");
		expect(result.bytes).toBe(4);
	});
});

describe("truncateHeadBytes", () => {
	test("returns source when already under limit", () => {
		const text = "hello";
		expect(truncateHeadBytes(text, 10)).toEqual({ text: "hello", bytes: 5 });
	});

	test("truncates from start without breaking UTF-8 boundaries", () => {
		const text = "a😀b";
		const result = truncateHeadBytes(text, 2);
		expect(result).toEqual({ text: "a", bytes: 1 });
		expect(result.text).not.toContain("\uFFFD");
	});

	test("returns empty when maxBytes is zero", () => {
		const result = truncateHeadBytes("abc", 0);
		expect(result).toEqual({ text: "", bytes: 0 });
	});
});

describe("truncateHead", () => {
	test("returns unmodified content when within limits", () => {
		const content = "a\nb";
		const result = truncateHead(content, { maxLines: 10, maxBytes: 20 });
		expect(result.truncated).toBeUndefined();
		expect(result.content).toBe(content);
		expect(result.truncatedBy).toBeUndefined();
	});

	test("handles first line exceeding byte limit", () => {
		const result = truncateHead("abcdef\nnext", { maxBytes: 3, maxLines: 10 });
		expect(result.content).toBe("");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.firstLineExceedsLimit).toBe(true);
	});

	test("includes first line when text fits exact byte budget", () => {
		const result = truncateHead("abc\nx", { maxBytes: 3, maxLines: 10 });
		expect(result.content).toBe("abc");
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.firstLineExceedsLimit).toBe(false);
		expect(result.outputBytes).toBe(byteLength("abc"));
	});
	test("truncates by line count", () => {
		const result = truncateHead("l1\nl2\nl3", { maxLines: 2, maxBytes: 100 });
		expect(result.content).toBe("l1\nl2");
		expect(result.truncatedBy).toBe("lines");
		expect(result.outputLines).toBe(2);
	});

	test("truncates by byte budget using complete lines", () => {
		const result = truncateHead("12345\nabc\nz", { maxLines: 10, maxBytes: 7 });
		expect(result.content).toBe("12345");
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(false);
		expect(result.outputBytes).toBe(byteLength("12345"));
	});
});

describe("truncateTail", () => {
	test("returns unmodified content when within limits", () => {
		const content = "a\nb";
		const result = truncateTail(content, { maxLines: 10, maxBytes: 20 });
		expect(result.truncated).toBeUndefined();
		expect(result.content).toBe(content);
		expect(result.truncatedBy).toBeUndefined();
	});

	test("truncates by line count", () => {
		const result = truncateTail("l1\nl2\nl3", { maxLines: 2, maxBytes: 100 });
		expect(result.content).toBe("l2\nl3");
		expect(result.truncatedBy).toBe("lines");
		expect(result.outputLines).toBe(2);
	});

	test("truncates by byte budget while preserving line boundaries", () => {
		const result = truncateTail("aaa\nbbbb\ncc", { maxLines: 10, maxBytes: 6 });
		expect(result.content).toBe("cc");
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(false);
	});

	test("returns partial single line when last line exceeds byte limit", () => {
		const result = truncateTail("abcdefghij", { maxLines: 10, maxBytes: 4 });
		expect(result.content).toBe("ghij");
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(true);
	});
});

describe("truncateLine", () => {
	test("does not truncate short lines", () => {
		expect(truncateLine("hello", 10)).toEqual({ text: "hello", wasTruncated: false });
	});

	test("truncates long lines with ellipsis", () => {
		expect(truncateLine("abcdefgh", 5)).toEqual({ text: "abcde…", wasTruncated: true });
	});
});

describe("TailBuffer", () => {
	test("keeps trailing bytes under budget", () => {
		const tail = new TailBuffer(5);
		tail.append("abc");
		tail.append("def");
		expect(tail.text()).toBe("bcdef");
		expect(tail.bytes()).toBe(5);
	});

	test("handles multibyte data and empty appends", () => {
		const tail = new TailBuffer(4);
		tail.append("");
		tail.append("😀");
		tail.append("x");
		expect(tail.text()).toBe("x");
		expect(tail.bytes()).toBe(1);
	});
});

describe("OutputSink", () => {
	test("tracks totals and adds notice in dump", async () => {
		const sink = new OutputSink();
		await sink.push("hello\nworld");
		const dumped = await sink.dump("notice");

		expect(dumped.output).toBe("[notice]\nhello\nworld");
		expect(dumped.truncated).toBe(false);
		expect(dumped.totalLines).toBe(2);
		expect(dumped.totalBytes).toBe(byteLength("hello\nworld"));
		expect(dumped.outputLines).toBe(2);
		expect(dumped.outputBytes).toBe(byteLength("hello\nworld"));
	});

	test("counts lines correctly when chunks contain no newlines", async () => {
		const sink = new OutputSink();
		await sink.push("abc");
		await sink.push("def");
		const dumped = await sink.dump();

		expect(dumped.totalLines).toBe(1);
		expect(dumped.outputLines).toBe(1);
	});

	test("counts all newline boundaries across chunk splits", async () => {
		const sink = new OutputSink();
		await sink.push("a\n");
		await sink.push("b\n\n");
		await sink.push("c");
		const dumped = await sink.dump();

		expect(dumped.output).toBe("a\nb\n\nc");
		expect(dumped.totalLines).toBe(4);
		expect(dumped.outputLines).toBe(4);
	});
	test("invokes onChunk callback with sanitized text", async () => {
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk) });
		await sink.push("abc");
		await sink.push("def");
		expect(chunks).toEqual(["abc", "def"]);
	});

	test("normalizes carriage-return progress frames across chunk boundaries", async () => {
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk) });

		sink.push("start\r");
		sink.push("one\r");
		sink.push("two\r");
		sink.push("\n");
		const dumped = await sink.dump();

		expect(chunks.join("")).toBe("start\none\ntwo\n");
		expect(dumped.output).toBe("start\none\ntwo\n");
	});

	test("preserves SIXEL chunks when passthrough gates are enabled", async () => {
		const sixel = "\x1bPqabc\x1b\\";
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk) });
		await sink.push(`before\n${sixel}\nafter`);
		const dumped = await sink.dump();
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toContain(sixel);
		expect(dumped.output).toContain(sixel);
	});

	test("strips SIXEL chunks when passthrough gates are disabled", async () => {
		const sixel = "\x1bPqabc\x1b\\";
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		const sink = new OutputSink();
		await sink.push(sixel);
		const dumped = await sink.dump();
		expect(dumped.output).not.toContain("\x1bPq");
		expect(dumped.output).toBe("");
	});

	test("truncates in-memory output when spill threshold is exceeded", async () => {
		const sink = new OutputSink({ spillThreshold: 5 });
		await sink.push("abc");
		await sink.push("def");

		const dumped = await sink.dump();
		expect(dumped.truncated).toBe(true);
		expect(dumped.output).toBe("bcdef");
		expect(dumped.totalBytes).toBe(6);
		expect(dumped.outputBytes).toBe(5);
	});

	test("spills full output to artifact file when artifact path is provided", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "output.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "artifact-1",
			spillThreshold: 5,
		});

		await sink.push("abc");
		await sink.push("def");
		const dumped = await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(dumped.truncated).toBe(true);
		expect(dumped.artifactId).toBe("artifact-1");
		expect(artifactText).toBe("abcdef");
		expect(dumped.output).toBe("bcdef");
	});

	test("artifact file includes head-retained bytes when head retention is enabled", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "output.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "artifact-2",
			spillThreshold: 5,
			headBytes: 4,
		});

		// First chunk lands fully in the head window; later chunks overflow the
		// tail budget and trigger the artifact spill.
		sink.push("head");
		sink.push("abc");
		sink.push("defgh");
		const dumped = await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(dumped.truncated).toBe(true);
		expect(artifactText).toBe("headabcdefgh");
	});

	test("throttled onChunk coalesces held-back chunks instead of dropping them", async () => {
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk), chunkThrottleMs: 60_000 });
		sink.push("a");
		// Inside the throttle window: buffered, not dropped.
		sink.push("b");
		sink.push("c");
		const dumped = await sink.dump();

		// First push fires immediately; dump flushes the coalesced remainder.
		expect(chunks).toEqual(["a", "bc"]);
		expect(dumped.output).toBe("abc");
	});

	test("throttled onChunk emits a quiet tail at the throttle boundary", () => {
		vi.useFakeTimers();
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk), chunkThrottleMs: 20 });

		sink.push("a");
		sink.push("b");
		expect(chunks).toEqual(["a"]);

		vi.advanceTimersByTime(20);

		expect(chunks).toEqual(["a", "b"]);
	});

	test("dump flushes a throttled tail once and cancels its timer", async () => {
		vi.useFakeTimers();
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk), chunkThrottleMs: 20 });

		sink.push("a");
		sink.push("b");
		expect((await sink.dump()).output).toBe("ab");
		expect(chunks).toEqual(["a", "b"]);

		vi.advanceTimersByTime(20);

		expect(chunks).toEqual(["a", "b"]);
	});

	test("replace cancels a throttled tail and discards its pending preview", () => {
		vi.useFakeTimers();
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk), chunkThrottleMs: 20 });

		sink.push("a");
		sink.push("superseded");
		sink.replace("replacement");
		vi.advanceTimersByTime(20);

		expect(chunks).toEqual(["a"]);
	});

	test("caps artifact-on-disk size: head + notice + tail when stream exceeds cap", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "capped.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "art-cap",
			spillThreshold: 16,
			artifactMaxBytes: 32,
			artifactHeadBytes: 16,
		});

		// Push 64 raw bytes; cap is 32 (16 head + 16 tail). Expect head=first 16,
		// notice in the middle, tail=last 16, total file size between 32 and
		// 32 + notice length.
		const payload = "0123456789ABCDEF".repeat(4); // 64 bytes
		await sink.push(payload);
		await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(artifactText.startsWith("0123456789ABCDEF")).toBe(true);
		expect(artifactText.endsWith("0123456789ABCDEF")).toBe(true);
		expect(artifactText).toContain("[ARTIFACT TRUNCATED:");
		expect(artifactText).toContain("elided from the middle");
		// Strip the notice (with surrounding separators) and assert head + tail are
		// preserved verbatim at exactly the budget bytes.
		const stripped = artifactText.replace(/\n?\[ARTIFACT TRUNCATED:[^\]]+\]\n?/g, "");
		expect(byteLength(stripped)).toBe(32);
	});

	test("artifact cap stays a no-op when total stream fits inside the cap", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "small.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "art-small",
			spillThreshold: 4,
			artifactMaxBytes: 64,
			artifactHeadBytes: 32,
		});

		// Forces spill (in-memory tail) but file should stay verbatim.
		await sink.push("abcde");
		await sink.push("fghij");
		await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(artifactText).toBe("abcdefghij");
		expect(artifactText).not.toContain("[ARTIFACT TRUNCATED:");
	});

	test("artifact stays verbatim when spillover exceeds head budget but still fits inside the cap", async () => {
		// Regression for the PR #2083 review: when the head budget is filled
		// but the rest still fits in the tail ring, droppedBytes is zero —
		// the file MUST be the verbatim stream with no `[ARTIFACT TRUNCATED: …]`
		// marker spliced into the middle.
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "spilled.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "art-spilled",
			spillThreshold: 8,
			artifactMaxBytes: 32,
			artifactHeadBytes: 16,
		});

		// 24 bytes total: head takes 16, tail ring receives 8 (fits, no eviction).
		const payload = "0123456789ABCDEFghijklmn";
		await sink.push(payload);
		await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(artifactText).toBe(payload);
		expect(artifactText).not.toContain("[ARTIFACT TRUNCATED:");
	});

	test("artifact cap stays bounded across many small streaming chunks", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "stream.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "art-stream",
			spillThreshold: 16,
			artifactMaxBytes: 32,
			artifactHeadBytes: 16,
		});

		// 200 chunks * 4 bytes = 800 bytes streamed; cap is 32.
		for (let i = 0; i < 200; i++) {
			await sink.push(String(i % 10).repeat(4));
		}
		await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(artifactText).toContain("[ARTIFACT TRUNCATED:");
		const stripped = artifactText.replace(/\n?\[ARTIFACT TRUNCATED:[^\]]+\]\n?/g, "");
		expect(byteLength(stripped)).toBe(32);
	});

	test("head-retained bytes count against the artifact cap", async () => {
		// Regression for the rebase onto a13e9827f: #createFileSink flushes the
		// in-memory head retention into the artifact sink before the buffer. If
		// that flush bypasses #emitToSink, the head bytes escape the cap
		// accounting and the on-disk file grows past artifactMaxBytes.
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "head-capped.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "art-head-cap",
			spillThreshold: 4,
			headBytes: 8,
			artifactMaxBytes: 16,
			artifactHeadBytes: 8,
		});

		// 64 bytes total: the first 8 land in the in-memory head; the overflow
		// opens the artifact sink, which replays the head first. The replayed
		// head must consume the artifact head budget exactly, leaving the tail
		// ring (8 bytes) for the rest.
		for (let i = 0; i < 16; i++) {
			await sink.push("abcd");
		}
		await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(artifactText).toContain("[ARTIFACT TRUNCATED:");
		const stripped = artifactText.replace(/\n?\[ARTIFACT TRUNCATED:[^\]]+\]\n?/g, "");
		expect(byteLength(stripped)).toBe(16);
	});

	test("artifactMaxBytes=0 restores unbounded artifact streaming", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "uncapped.log");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "art-uncapped",
			spillThreshold: 16,
			artifactMaxBytes: 0,
		});

		const payload = "X".repeat(1024);
		await sink.push(payload);
		await sink.dump();
		const artifactText = await Bun.file(artifactPath).text();

		expect(artifactText).toBe(payload);
		expect(artifactText).not.toContain("[ARTIFACT TRUNCATED:");
	});
	test("createInput decodes streamed UTF-8 chunks correctly", async () => {
		const sink = new OutputSink();
		const writer = sink.createInput().getWriter();
		const bytes = new TextEncoder().encode("😀X");

		await writer.write(bytes.subarray(0, 2));
		await writer.write(bytes.subarray(2));
		await writer.close();

		const dumped = await sink.dump();
		expect(dumped.output).toBe("😀X");
		expect(dumped.totalBytes).toBe(byteLength("😀X"));
	});
});

describe("truncation notice formatting", () => {
	test("formatTailTruncationNotice returns empty string for non-truncated results", () => {
		const truncation = truncateTail("a\nb", { maxLines: 10, maxBytes: 50 });
		expect(formatTailTruncationNotice(truncation)).toBe("");
	});

	test("formatTailTruncationNotice supports partial-line and complete-line notices", () => {
		const partialLineTruncation = truncateTail("abcdefghij", { maxLines: 10, maxBytes: 4 });
		const partialLineNotice = formatTailTruncationNotice(partialLineTruncation, {
			fullOutputPath: "/tmp/full.log",
			originalContent: "abcdefghij",
			suffix: " [suffix]",
		});
		expect(partialLineNotice).toBe(
			"\n\n[Showing last 4B of line 1 (line is 10B). Full output: /tmp/full.log [suffix]]",
		);

		const lineTruncation = truncateTail("l1\nl2\nl3", { maxLines: 2, maxBytes: 100 });
		expect(formatTailTruncationNotice(lineTruncation)).toBe("\n\n[Showing lines 2-3 of 3]");

		const byteTruncation = truncateTail("aaa\nbbbb\ncc", { maxLines: 10, maxBytes: 6 });
		expect(formatTailTruncationNotice(byteTruncation)).toBe("\n\n[Showing lines 3-3 of 3]");
	});

	test("formatHeadTruncationNotice returns empty string for non-truncated results", () => {
		const truncation = truncateHead("a\nb", { maxLines: 10, maxBytes: 50 });
		expect(formatHeadTruncationNotice(truncation)).toBe("");
	});

	test("formatHeadTruncationNotice formats head truncation range", () => {
		const lineTruncation = truncateHead("l1\nl2\nl3", { maxLines: 2, maxBytes: 100 });
		expect(formatHeadTruncationNotice(lineTruncation)).toBe("\n\n[Showing lines 1-2 of 3. Use :3 to continue]");

		const byteTruncation = truncateHead("12345\nabc\nz", { maxLines: 10, maxBytes: 7 });
		expect(
			formatHeadTruncationNotice(byteTruncation, {
				startLine: 100,
				totalFileLines: 500,
			}),
		).toBe("\n\n[Showing lines 100-100 of 500. Use :101 to continue]");
	});
});

describe("truncateMiddle", () => {
	test("returns content unchanged when within budget", () => {
		const result = truncateMiddle("a\nb\nc", { maxBytes: 100, maxLines: 10 });
		expect(result.truncated).toBeFalsy();
		expect(result.content).toBe("a\nb\nc");
	});

	test("keeps head and tail with marker for byte-overflow content", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n");
		const result = truncateMiddle(lines, {
			maxBytes: 24, // 12 bytes head + 12 bytes tail
			maxLines: 12,
			maxHeadBytes: 12,
			maxHeadLines: 3,
		});
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("middle");
		// Must contain first line and last line, plus the elision marker.
		expect(result.content.startsWith("line-1\n")).toBe(true);
		expect(result.content.endsWith("line-12")).toBe(true);
		expect(result.content).toContain("elided");
		expect(result.content).not.toContain("line-7"); // a middle line
		expect(result.elidedLines).toBeGreaterThan(0);
		expect(result.elidedBytes).toBeGreaterThan(0);
	});

	test("falls back to tail-only when head budget cannot accept the first line", () => {
		const giantFirstLine = `${"x".repeat(200)}\nshort-2\nshort-3`;
		const result = truncateMiddle(giantFirstLine, {
			maxBytes: 40,
			maxLines: 10,
			maxHeadBytes: 8, // first line is 200 bytes — exceeds head budget
			maxHeadLines: 1,
		});
		expect(result.truncated).toBe(true);
		// Should not contain the elision marker; it's a regular tail truncation.
		expect(result.content).not.toContain("elided");
	});

	test("formatMiddleElisionMarker uses lines, falling back to bytes for <=1 line", () => {
		expect(formatMiddleElisionMarker(0, 512)).toBe("[…512B elided…]");
		expect(formatMiddleElisionMarker(1, 100)).toBe("[…100B elided…]");
		expect(formatMiddleElisionMarker(123, 4096)).toBe("[…123ln elided…]");
	});
});

describe("OutputSink head-retain mode", () => {
	test("middle elision splices head, marker, and tail", async () => {
		const sink = new OutputSink({ spillThreshold: 6, headBytes: 6 });
		// Total 36 bytes: head ~6, tail ~6, middle ~24 elided.
		const lines = Array.from({ length: 12 }, (_, i) => `L${i}`).join("\n");
		await sink.push(lines);

		const dumped = await sink.dump();
		expect(dumped.truncated).toBe(true);
		expect(dumped.elidedBytes ?? 0).toBeGreaterThan(0);
		expect(dumped.elidedLines ?? 0).toBeGreaterThan(0);
		expect(dumped.output.startsWith("L0\n")).toBe(true);
		expect(dumped.output.endsWith("L11")).toBe(true);
		expect(dumped.output).toContain("elided");
		expect(dumped.totalBytes).toBe(byteLength(lines));
	});

	test("disabled (headBytes=0) preserves tail-only behavior", async () => {
		const sink = new OutputSink({ spillThreshold: 5, headBytes: 0 });
		await sink.push("abc");
		await sink.push("def");

		const dumped = await sink.dump();
		expect(dumped.truncated).toBe(true);
		expect(dumped.output).toBe("bcdef");
		expect(dumped.elidedBytes).toBeUndefined();
	});

	test("head fills cleanly across chunks without elision when total fits", async () => {
		const sink = new OutputSink({ spillThreshold: 50, headBytes: 4 });
		await sink.push("abcdefgh");
		const dumped = await sink.dump();
		expect(dumped.output).toBe("abcdefgh");
		expect(dumped.truncated).toBe(false);
		expect(dumped.elidedBytes).toBeUndefined();
	});

	test("replace + push appends to tail and emits no elision marker", async () => {
		// Simulates the bash-minimizer flow: large raw stream is replaced with a
		// short minimized text, then an artifact-link line is pushed. The push
		// must land at the END of the buffer (after the minimized text), and the
		// stale pre-replace totals must NOT trigger the middle-elision branch in
		// dump().
		const sink = new OutputSink({ spillThreshold: 1024, headBytes: 64 });
		// Feed a long original stream so #totalBytes/#totalLines climb high.
		const noisy = Array.from({ length: 50 }, (_, i) => `noise line ${i}`).join("\n");
		await sink.push(noisy);

		sink.replace("OK\n");
		await sink.push("[raw output: artifact://8]\n");

		const dumped = await sink.dump();
		expect(dumped.output).toBe("OK\n[raw output: artifact://8]\n");
		expect(dumped.output).not.toContain("elided");
		expect(dumped.elidedBytes).toBeUndefined();
		expect(dumped.elidedLines).toBeUndefined();
		expect(dumped.truncated).toBe(false);
		// Counters realign to the authoritative buffer + the subsequent push.
		expect(dumped.totalBytes).toBe(byteLength("OK\n[raw output: artifact://8]\n"));
	});

	test("middle-elided dump body fits the inline budget (no double truncation)", async () => {
		// Regression: the head and tail windows each had their own full budget,
		// so an elided dump body could reach headBytes + spillThreshold and
		// re-trip enforceInlineByteCap at the tool-result boundary — truncating
		// a second time and saving a duplicate artifact whose id disagreed with
		// the truncation notice's `Read artifact://N for full output`.
		const spillThreshold = 1000;
		const sink = new OutputSink({ spillThreshold, headBytes: 400 });
		const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
		sink.push(lines);

		const dumped = await sink.dump();
		expect(dumped.truncated).toBe(true);
		expect(dumped.elidedLines ?? 0).toBeGreaterThan(0);
		// Head window + elision marker + tail window share the one budget
		// (small slack for the marker and separators).
		expect(byteLength(dumped.output)).toBeLessThanOrEqual(spillThreshold + 64);

		let saved: string | undefined;
		const capped = await enforceInlineByteCap(dumped.output, {
			maxBytes: spillThreshold + 2048,
			saveArtifact: full => {
				saved = full;
				return "duplicate";
			},
		});
		expect(capped).toBe(dumped.output);
		expect(saved).toBeUndefined();
	});
});

describe("OutputSink maxColumns (per-line cap)", () => {
	test("truncates a single overlong line with an ellipsis and drops the rest", async () => {
		const sink = new OutputSink({ maxColumns: 8, spillThreshold: 1000 });
		await sink.push(`short\n${"x".repeat(50)}\nfooter`);

		const dumped = await sink.dump();
		// A per-line column cap trims individual lines but does not truncate the
		// output window: every line is still present, so `truncated` stays false.
		// (Regression: column-cap-only output was misreported as a byte-window
		// truncation, producing a bogus "Showing lines X-Y … limit" footer — #4735.)
		expect(dumped.truncated).toBe(false);
		expect(dumped.output).toContain("short\n");
		expect(dumped.output).toContain("\nfooter");
		expect(dumped.output).toContain("…");
		// The wide line shouldn't appear verbatim.
		expect(dumped.output).not.toContain("x".repeat(50));
		expect(dumped.columnTruncatedLines).toBe(1);
		expect(dumped.columnDroppedBytes ?? 0).toBeGreaterThan(0);
		expect(dumped.columnMax).toBe(8);
		// totalBytes still reflects the raw stream, not the post-cap view.
		expect(dumped.totalBytes).toBe(byteLength(`short\n${"x".repeat(50)}\nfooter`));
	});

	test("column-cap-only output surfaces a column notice, not a window/byte truncation footer", async () => {
		// Regression for #4735: fully-shown output whose only trimming was the
		// per-line column cap must not emit "Showing lines X-Y of Z (…B limit).
		// Read artifact://… for full output" — every line is present.
		const sink = new OutputSink({ maxColumns: 8, spillThreshold: 100_000 });
		const lines = ["a", "b", "c", "x".repeat(50), "d"];
		await sink.push(`${lines.join("\n")}\n`);
		const dumped = await sink.dump();

		const meta = outputMeta().truncationFromSummary(dumped, { direction: "tail" }).get();
		// No window truncation → no styled TUI warning and no range/limit footer.
		expect(meta?.truncation).toBeUndefined();
		expect(meta?.limits?.columnTruncated).toEqual({ maxColumn: 8 });

		const notice = formatOutputNotice(meta);
		expect(notice).toContain("Some lines truncated to 8 chars");
		expect(notice).not.toContain("Showing lines");
		expect(notice).not.toContain("limit");
		expect(notice).not.toContain("artifact://");
	});

	test("persists per-line state across chunk boundaries", async () => {
		const sink = new OutputSink({ maxColumns: 4, spillThreshold: 1000 });
		await sink.push("ab"); // 2 bytes into the current line
		await sink.push("cd"); // 4 bytes total — still within cap
		await sink.push("efgh"); // tips over → ellipsis once, then drop rest
		await sink.push("ijkl\n");
		await sink.push("next");

		const dumped = await sink.dump();
		const lines = dumped.output.split("\n");
		expect(lines[0]).toMatch(/^(abcd)?…$|^abcd…$/);
		expect(lines[1]).toBe("next");
		expect(dumped.columnTruncatedLines).toBe(1);
	});

	test("disabled by default — maxColumns: 0 is a passthrough", async () => {
		const sink = new OutputSink({ spillThreshold: 4000 });
		const wide = "y".repeat(2000);
		await sink.push(wide);
		const dumped = await sink.dump();
		expect(dumped.output).toBe(wide);
		expect(dumped.columnTruncatedLines).toBeUndefined();
		expect(dumped.columnDroppedBytes).toBeUndefined();
	});

	test("middle elision math subtracts column-dropped bytes", async () => {
		// Head + tail buffers are tiny; the wide middle line gets column-capped,
		// so its dropped bytes shouldn't be double-counted as "elided from middle".
		const sink = new OutputSink({
			maxColumns: 4,
			spillThreshold: 6,
			headBytes: 6,
		});
		const wideMiddle = "M".repeat(200);
		const input = `head\n${wideMiddle}\ntail`;
		await sink.push(input);
		const dumped = await sink.dump();
		const elided = dumped.elidedBytes ?? 0;
		const dropped = dumped.columnDroppedBytes ?? 0;
		expect(dropped).toBeGreaterThan(0);
		// elided + dropped + kept ≤ totalBytes (with a small slack for the marker/newlines).
		expect(elided + dropped).toBeLessThan(dumped.totalBytes);
	});
});

describe("OutputSink presentation producer errors", () => {
	// Real producer, not a mock: the freeze/flush/scope machinery under test lives
	// in `ToolPresentationStream`, and a hand-rolled fake could accidentally
	// implement the exact bug this suite exists to catch.
	function collectingProducer(): { producer: ToolPresentationStream; events: ToolPresentationEvent[] } {
		const events: ToolPresentationEvent[] = [];
		return {
			producer: new ToolPresentationStream(streamId("presentation-error-probe"), event => events.push(event)),
			events,
		};
	}
	function appends(events: readonly ToolPresentationEvent[]): readonly string[] {
		return events.filter(event => event.type === "terminal_append").map(event => event.data);
	}

	/** Collect warn-level log events via the repository's standard log-sink pattern. */
	function collectWarnings(): { events: logger.LogEvent[]; dispose: () => void } {
		const events: logger.LogEvent[] = [];
		const dispose = logger.registerLogSink(event => {
			if (event.level === "warn") events.push(event);
		});
		return { events, dispose };
	}

	test("propagates a genuine emitter failure instead of swallowing it as a freeze race", () => {
		// Reproduces a producer whose emitter throws synchronously.
		// `OutputSink` used to catch *every* `appendTerminal` error unconditionally and
		// log it as "arrived after freeze started", which silently ate this failure too.
		const producer = new ToolPresentationStream(streamId("emitter-failure-probe"), () => {
			throw new Error("emitter failed");
		});
		const sink = new OutputSink({ presentation: producer });
		expect(() => sink.push("x")).toThrow("emitter failed");
	});

	test("warns and drops, without throwing, a chunk that arrives after freeze completed", async () => {
		const { producer, events } = collectingProducer();
		const { events: warnings, dispose } = collectWarnings();
		try {
			const sink = new OutputSink({ presentation: producer });
			await producer.freeze();
			expect(producer.phase).toBe("frozen");
			expect(() => sink.push("late")).not.toThrow();
			expect(appends(events)).toEqual([]);
			// The late chunk produced a warn-level log, so its loss is observable —
			// not silently discarded. Without this assertion the test would pass even
			// if the warning were removed, leaving the drop undetectable.
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.message).toBe("OutputSink produced a chunk after the presentation stream began freezing");
			expect(warnings[0]?.context).toMatchObject({ bytes: 4 });
		} finally {
			dispose();
		}
	});

	test("warns and drops, without throwing, an ordinary chunk that arrives mid-freeze", async () => {
		// Mid-freeze (`phase === "flushing"`) is not "frozen" yet, but an *ordinary*
		// (non-scoped) append must still be rejected — only the flusher's own scope may
		// append during that window.
		const { producer, events } = collectingProducer();
		const { events: warnings, dispose } = collectWarnings();
		try {
			const gate = Promise.withResolvers<void>();
			producer.registerFlusher(async () => {
				await gate.promise;
			});
			const sink = new OutputSink({ presentation: producer });
			const freezing = producer.freeze();
			// No wait needed: `#runFreeze` sets `#phase = "flushing"` synchronously, before
			// its first `await`, so it has already happened by the time `freeze()` returns.
			expect(producer.phase).toBe("flushing");
			expect(() => sink.push("mid-freeze")).not.toThrow();
			gate.resolve();
			await freezing;
			expect(appends(events)).toEqual([]);
			// The mid-freeze chunk also produced a warning, not a silent drop.
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.message).toBe("OutputSink produced a chunk after the presentation stream began freezing");
		} finally {
			dispose();
		}
	});

	test("still delivers a scoped flusher's own pending chunk during freeze", async () => {
		const { producer, events } = collectingProducer();
		const { events: warnings, dispose } = collectWarnings();
		try {
			const sink = new OutputSink({ presentation: producer, chunkThrottleMs: 60_000 });
			sink.push("first"); // the throttle boundary always lets the first push straight through
			sink.push("buffered"); // arrives inside the throttle window, held by the pending-chunk timer
			expect(appends(events)).toEqual(["first"]);
			await producer.freeze(); // the registered flusher flushes it through its own scope
			expect(appends(events)).toEqual(["first", "buffered"]);
			// A scoped flusher's own output is delivered normally — no warning.
			expect(warnings).toHaveLength(0);
		} finally {
			dispose();
		}
	});

	test("loses no bytes silently: a delivered chunk and a dropped late chunk are each observable", async () => {
		const { producer, events } = collectingProducer();
		const { events: warnings, dispose } = collectWarnings();
		try {
			const sink = new OutputSink({ presentation: producer });
			sink.push("delivered");
			await producer.freeze();
			sink.push("dropped-after-freeze");
			// The delivered chunk actually reached the producer's event stream...
			expect(appends(events)).toEqual(["delivered"]);
			// ...and the late chunk was neither appended nor silently discarded without a
			// trace: it is absent from the delivered stream (not corrupted into it) and the
			// producer's own retained cursor did not advance for it.
			expect(producer.nextByte).toBe(byteOffset(byteLengthOf("delivered")));
			// The late chunk also emitted a warning — its drop is observable, not silent.
			// Without this assertion the test passes even if the warning is removed,
			// leaving late output silently discarded.
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.message).toBe("OutputSink produced a chunk after the presentation stream began freezing");
			expect(warnings[0]?.context).toMatchObject({ bytes: 20 });
		} finally {
			dispose();
		}
	});

	test("dispose swallows a throwing pending-chunk flush instead of masking the tool error", async () => {
		// Round-5 review P20: dispose() runs in the executors' `finally`; a throw
		// from the pending flush would replace the original tool error — the same
		// masking its `#finalizeFile` sibling guards against. The swallow must
		// hold when the emitter itself is the thrower, and must not derive a
		// truncation fact from counters diverged by the failed append.
		const { events: warnings, dispose } = collectWarnings();
		try {
			let fail = false;
			const events: ToolPresentationEvent[] = [];
			const producer = new ToolPresentationStream(streamId("dispose-flush-throw-probe"), event => {
				if (fail) throw new Error("emitter failed");
				events.push(event);
			});
			const sink = new OutputSink({ presentation: producer, chunkThrottleMs: 60_000 });
			sink.push("first"); // the throttle boundary lets the first push straight through
			fail = true;
			sink.push("buffered"); // pends inside the throttle window; flush will throw
			expect(events.filter(event => event.type === "fact")).toHaveLength(0);

			await expect(sink.dispose()).resolves.toBeUndefined();

			// The failure is observable, not silent...
			expect(
				warnings.some(warning => warning.message === "OutputSink dispose failed to flush the pending chunk"),
			).toBe(true);
			// ...and no fabricated truncation fact was derived from diverged counters.
			expect(events.filter(event => event.type === "fact")).toHaveLength(0);
		} finally {
			dispose();
		}
	});
});

describe("OutputSink presentation retention cap", () => {
	function collectingProducer(): { producer: ToolPresentationStream; events: ToolPresentationEvent[] } {
		const events: ToolPresentationEvent[] = [];
		return {
			producer: new ToolPresentationStream(streamId("s-cap"), event => events.push(event)),
			events,
		};
	}
	function truncationMetas(events: readonly ToolPresentationEvent[]): TruncationFactMeta[] {
		const metas: TruncationFactMeta[] = [];
		for (const event of events) {
			if (event.type !== "fact") continue;
			if (event.fact.kind !== "truncation") continue;
			metas.push(event.fact.meta);
		}
		return metas;
	}
	function appendedBytes(events: readonly ToolPresentationEvent[]): number {
		return events.reduce(
			(sum, event) => (event.type === "terminal_append" ? sum + byteLengthOf(event.data) : sum),
			0,
		);
	}

	test("bounds a single oversized chunk and reports its full size as dropped", async () => {
		const { producer, events } = collectingProducer();
		const sink = new OutputSink({ presentation: producer });
		const chunk = "x".repeat(PRESENTATION_MAX_RETAINED_BYTES + 512 * 1024);
		await sink.push(chunk);

		// Hard bound enforced during the append itself, not checked afterwards.
		expect(appendedBytes(events)).toBe(PRESENTATION_MAX_RETAINED_BYTES);

		// Nothing declared until finalization...
		expect(truncationMetas(events)).toHaveLength(0);

		await sink.dump();

		// ...then exactly one fact, with the FINAL totals: the produced-but-dropped
		// remainder shows up in totalBytes, not silently vanished.
		const [meta] = truncationMetas(events);
		expect(truncationMetas(events)).toHaveLength(1);
		expect(meta).toMatchObject({
			direction: "head",
			truncatedBy: "bytes",
			maxBytes: PRESENTATION_MAX_RETAINED_BYTES,
			retainedBytes: PRESENTATION_MAX_RETAINED_BYTES,
			totalBytes: byteLengthOf(chunk),
		});
	});

	test("declares exactly one truncation fact at dump() with truthful totals", async () => {
		const { producer, events } = collectingProducer();
		const sink = new OutputSink({ presentation: producer });
		const chunk = "x".repeat(64 * 1024);
		for (let i = 0; i < 20; i++) await sink.push(chunk);
		await sink.dump();

		const metas = truncationMetas(events);
		expect(metas).toHaveLength(1);
		expect(metas[0]).toMatchObject({
			direction: "head",
			truncatedBy: "bytes",
			maxBytes: PRESENTATION_MAX_RETAINED_BYTES,
			retainedBytes: PRESENTATION_MAX_RETAINED_BYTES,
			totalBytes: 20 * 64 * 1024,
		});
		expect(metas[0]?.totalBytes).toBeGreaterThan(metas[0]?.retainedBytes ?? 0);

		// Retained head window is capped; the rest was dropped, not appended.
		expect(appendedBytes(events)).toBe(PRESENTATION_MAX_RETAINED_BYTES);
	});

	test("stream ending at exactly the cap declares no truncation fact", async () => {
		const { producer, events } = collectingProducer();
		const sink = new OutputSink({ presentation: producer });
		const chunk = "x".repeat(64 * 1024); // 16 × 64 KiB === 1 MiB exactly
		for (let i = 0; i < 16; i++) await sink.push(chunk);
		expect(appendedBytes(events)).toBe(PRESENTATION_MAX_RETAINED_BYTES);

		await sink.dump();

		expect(truncationMetas(events)).toHaveLength(0);
		expect(events.some(event => event.type === "fact")).toBe(false);
	});
	test("latches rollover when a boundary back-off leaves residual budget", async () => {
		// Regression: a multibyte code point straddling the exact cap makes
		// utf8PrefixWithin back off, landing retainedBytes at MAX-1. Without the
		// latch, the next chunk passed the `retained >= MAX` short-circuit and its
		// head appended AFTER the previous chunk's dropped tail — punching a hole
		// in the pure head prefix the truncation fact declares.
		const { producer, events } = collectingProducer();
		const sink = new OutputSink({ presentation: producer });
		await sink.push("x".repeat(PRESENTATION_MAX_RETAINED_BYTES - 1));
		expect(appendedBytes(events)).toBe(PRESENTATION_MAX_RETAINED_BYTES - 1);

		await sink.push("é"); // 2-byte code point; prefix within 1 byte backs off to ""
		await sink.push("z"); // must be rejected by the latch, not appended at MAX-1

		const text = events.map(event => (event.type === "terminal_append" ? event.data : "")).join("");
		expect(text).toBe("x".repeat(PRESENTATION_MAX_RETAINED_BYTES - 1));
		expect(appendedBytes(events)).toBe(PRESENTATION_MAX_RETAINED_BYTES - 1);

		await sink.dump();
		const [meta] = truncationMetas(events);
		expect(truncationMetas(events)).toHaveLength(1);
		expect(meta).toMatchObject({
			retainedBytes: PRESENTATION_MAX_RETAINED_BYTES - 1,
			totalBytes: PRESENTATION_MAX_RETAINED_BYTES + 2,
		});
	});
	test("declares the rollover fact from dispose when the executor threw without dumping", async () => {
		// Round-3 review P7: executeBash's catch rethrows without calling dump();
		// its `finally` runs sink.dispose() before the agent loop's freeze, so
		// that path is still pre-freeze and must carry the disclosure — a command
		// that streamed past the cap and then threw used to settle with a capped
		// transcript and no truncation fact at all.
		const { producer, events } = collectingProducer();
		const sink = new OutputSink({ presentation: producer });
		await sink.push("x".repeat(PRESENTATION_MAX_RETAINED_BYTES + 1024));
		expect(truncationMetas(events)).toHaveLength(0);

		await sink.dispose(); // the throw-path exit: no dump()

		const [meta] = truncationMetas(events);
		expect(truncationMetas(events)).toHaveLength(1);
		expect(meta).toMatchObject({
			retainedBytes: PRESENTATION_MAX_RETAINED_BYTES,
			totalBytes: PRESENTATION_MAX_RETAINED_BYTES + 1024,
		});
		// Idempotent: a later dump() must not declare a second fact.
		await sink.dump();
		expect(truncationMetas(events)).toHaveLength(1);
	});

	test("dispose flushes the throttled pending chunk before declaring the rollover fact", async () => {
		// Round-4 review P10: bash's live path always throttles (50 ms), so the
		// throw-path dispose can fire with bytes still coalescing in
		// `#pendingChunk` — invisible to both presentation counters. Declaring
		// before flushing made the fact's totals stale, and skipped it entirely
		// when the cap crossing fell inside the pending window.
		const { producer, events } = collectingProducer();
		const sink = new OutputSink({ presentation: producer, chunkThrottleMs: 60_000 });
		// First chunk is emitted immediately (no throttle window open yet)...
		await sink.push("x".repeat(PRESENTATION_MAX_RETAINED_BYTES - 1024));
		// ...the second lands in the pending buffer and crosses the cap there.
		await sink.push("y".repeat(4096));
		expect(truncationMetas(events)).toHaveLength(0);

		await sink.dispose(); // the throttled throw-path exit: no dump()

		const [meta] = truncationMetas(events);
		expect(truncationMetas(events)).toHaveLength(1);
		expect(meta).toMatchObject({
			retainedBytes: PRESENTATION_MAX_RETAINED_BYTES,
			totalBytes: PRESENTATION_MAX_RETAINED_BYTES - 1024 + 4096,
		});
	});

	test("a failed dispose flush poisons the latch so a later dump() cannot fabricate a fact", async () => {
		// Round-6 review P21: the flush-failure knowledge must outlive dispose()'s
		// stack frame. The thrown append increments `#presentationTotalBytes` but
		// not retained bytes, so the counters stay diverged forever; a fail-once
		// emitter that recovers before a later dump() (the suite-pinned
		// dispose-then-dump lifecycle) would otherwise derive and publish exactly
		// the fabricated truncation fact the skip exists to prevent.
		const events: ToolPresentationEvent[] = [];
		let fail = false;
		const producer = new ToolPresentationStream(streamId("s-fail-once"), event => {
			if (fail) throw new Error("emitter failed");
			events.push(event);
		});
		const sink = new OutputSink({ presentation: producer, chunkThrottleMs: 60_000 });
		sink.push("first"); // emitted immediately
		fail = true;
		sink.push("buffered"); // pends; its flush throws during dispose
		await sink.dispose();
		expect(truncationMetas(events)).toHaveLength(0);

		fail = false; // the emitter recovers...
		await sink.dump(); // ...but the poisoned latch keeps dump() honest too

		expect(truncationMetas(events)).toHaveLength(0);
	});

	test("a scoped flush crossing the cap during freeze neither throws nor declares", async () => {
		// Regression: the throttled pending chunk is delivered through the freeze
		// barrier's scope while `phase === "flushing"` / `"frozen"`. Declaring the
		// rollover from the append path used to call `producer.fact()` there and
		// throw "declared a fact after freeze".
		const { producer, events } = collectingProducer();
		const sink = new OutputSink({ presentation: producer, chunkThrottleMs: 60_000 });
		sink.push("x".repeat(PRESENTATION_MAX_RETAINED_BYTES - 4)); // first push bypasses the throttle
		sink.push("yyyy"); // buffered by the throttle, flushed through the freeze scope
		await expect(producer.freeze()).resolves.toBeUndefined(); // must not throw

		expect(appendedBytes(events)).toBe(PRESENTATION_MAX_RETAINED_BYTES);
		// The stream froze before dump(), so the fact can no longer be declared —
		// correctly absent rather than thrown.
		expect(truncationMetas(events)).toHaveLength(0);
		await expect(sink.dump()).resolves.toBeDefined();
		expect(truncationMetas(events)).toHaveLength(0);
	});

	test("an ordinary chunk crossing the cap mid-freeze neither throws nor declares", async () => {
		const { producer, events } = collectingProducer();
		const gate = Promise.withResolvers<void>();
		producer.registerFlusher(async () => {
			await gate.promise;
		});
		const sink = new OutputSink({ presentation: producer });
		sink.push("x".repeat(PRESENTATION_MAX_RETAINED_BYTES - 4));
		const freezing = producer.freeze();
		expect(producer.phase).toBe("flushing");
		expect(() => sink.push("y".repeat(PRESENTATION_MAX_RETAINED_BYTES))).not.toThrow();
		gate.resolve();
		await freezing;

		// The mid-freeze chunk was dropped wholesale (bounded feed, warned drop).
		expect(appendedBytes(events)).toBeLessThanOrEqual(PRESENTATION_MAX_RETAINED_BYTES);
		expect(truncationMetas(events)).toHaveLength(0);
		await expect(sink.dump()).resolves.toBeDefined();
		expect(truncationMetas(events)).toHaveLength(0);
	});
});
