import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { formatTruncationMetaNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		settings: Settings.isolated(),
	};
}

describe("read tool raw range exactness", () => {
	let testDir: string;
	let filePath: string;
	let tool: ReadTool;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-raw-range-"));
		filePath = path.join(testDir, "data.txt");
		const lines = Array.from({ length: 60 }, (_, index) => `L${String(index + 1).padStart(2, "0")}`);
		await Bun.write(filePath, lines.join("\n"));
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("returns exactly the requested single line for raw:N-N", async () => {
		// Regression: raw ranges used to get 1 leading + 3 trailing context
		// lines. Without line numbers the padding is indistinguishable from
		// requested content, so verbatim-extraction callers pasted 5 lines
		// where they asked for 1.
		const result = await tool.execute("call-raw-single", { path: `${filePath}:raw:31-31` });
		const output = getTextOutput(result);

		expect(output.trimEnd()).toBe("L31");
	});

	it("returns exactly the requested raw range at the start of the file", async () => {
		const result = await tool.execute("call-raw-head", { path: `${filePath}:raw:1-2` });
		const output = getTextOutput(result);

		expect(output.trimEnd()).toBe("L01\nL02");
	});

	it("returns only a closed raw range from a newline-terminated file and counts its lines", async () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
		await Bun.write(filePath, `${lines.join("\n")}\n`);

		const result = await tool.execute("closed-raw-range", { path: `${filePath}:raw:5-8` });
		expect(getTextOutput(result)).toBe(lines.slice(4, 8).join("\n"));
		expect(result.details?.totalLines).toBe(40);

		const last = await tool.execute("last-raw-line", { path: `${filePath}:raw:-1` });
		expect(getTextOutput(last)).toBe("line 40");

		const open = await tool.execute("open-raw-range", { path: `${filePath}:raw:40-` });
		expect(getTextOutput(open)).toBe("line 40\n");
		expect(open.details?.totalLines).toBe(40);
	});

	it("returns a closed raw range without a paging footer when the file is streamed", async () => {
		const streamedFile = path.join(testDir, "large.txt");
		await Bun.write(streamedFile, `${"x".repeat(4 * 1024 * 1024)}\nline 2\nline 3\nline 4\n`);

		const result = await tool.execute("streamed-raw-range", { path: `${streamedFile}:raw:2-3` });
		expect(getTextOutput(result)).toBe("line 2\nline 3");
	});

	it("reads an empty archive member verbatim in raw mode, matching an empty disk file", async () => {
		await writeArchive(path.join(testDir, "empty.zip"), "zip", [["empty.txt", ""]]);
		await Bun.write(filePath, "");

		const archive = await tool.execute("empty-archive-raw", { path: "empty.zip:empty.txt:raw" });
		const disk = await tool.execute("empty-disk-raw", { path: `${filePath}:raw` });
		expect(getTextOutput(archive)).toBe("");
		expect(getTextOutput(disk)).toBe("");
		expect(archive.details?.totalLines).toBe(disk.details?.totalLines);
	});

	it("keeps the terminal newline when the last raw multi-range is open-ended", async () => {
		await Bun.write(filePath, "one\ntwo\nthree\n");
		const streamedFile = path.join(testDir, "large-multi.txt");
		await Bun.write(streamedFile, `${"x".repeat(4 * 1024 * 1024)}\ntwo\nthree\nfour\n`);

		const buffered = await tool.execute("buffered-open-multi", { path: `${filePath}:raw:1,3-` });
		const streamed = await tool.execute("streamed-open-multi", { path: `${streamedFile}:raw:2,4-` });
		expect(getTextOutput(buffered)).toBe("one\n\n…\n\nthree\n");
		expect(getTextOutput(streamed)).toBe("two\n\n…\n\nfour\n");
	});

	it("records the source line count for an open-ended range that reaches EOF", async () => {
		const result = await tool.execute("call-raw-tail", { path: `${filePath}:raw:31-` });

		expect(result.details?.totalLines).toBe(60);
	});

	it("keeps context padding for numbered range reads", async () => {
		// Numbered mode intentionally pads (leading anchor buffer + trailing
		// disambiguation lines) — line numbers make the padding self-describing.
		const result = await tool.execute("call-numbered", { path: `${filePath}:31-31` });
		const output = getTextOutput(result);

		expect(output).toContain("L31");
		expect(output).toContain("L30");
		expect(output).toContain("L32");
	});

	it("keeps the continuation when the byte budget stops inside requested buffered content", async () => {
		const bufferedFile = path.join(testDir, "buffered-range.txt");
		await Bun.write(
			bufferedFile,
			Array.from({ length: 100 }, (_, index) => `line-${index + 1} ${"x".repeat(1_016)}`).join("\n"),
		);

		const result = await tool.execute("call-buffered-byte-limited-range", { path: `${bufferedFile}:1-100` });
		const output = getTextOutput(result);
		const truncation = result.details?.meta?.truncation;

		expect(output).not.toContain("could not fit after preceding context");
		expect(output).not.toContain(":raw:");
		expect(truncation).toBeDefined();
		if (!truncation) throw new Error("expected truncation metadata");
		const shownRange = truncation.shownRange;
		expect(shownRange).toBeDefined();
		if (!shownRange) throw new Error("expected shown range");
		expect(truncation.nextOffset).toBe(shownRange.end + 1);
		expect(formatTruncationMetaNotice(truncation)).toContain(`Use :${truncation.nextOffset} to continue`);
	});

	it("reports an oversized selected line from a buffered local file with a safe raw recovery selector", async () => {
		const bufferedFile = path.join(testDir, "buffered-oversized.txt");
		await Bun.write(
			bufferedFile,
			["leading-context", `oversized-${"x".repeat(70_000)}-end`, "trailing-one", "trailing-two"].join("\n"),
		);

		const result = await tool.execute("call-buffered-oversized-selected", { path: `${bufferedFile}:2-2` });
		const output = getTextOutput(result);

		expect(output).toContain("leading-context");
		expect(output).toContain("Line 2 is 68.4KB");
		expect(output).toContain("50.0KB read budget");
		expect(output).toContain(":raw:2-2");
		const truncation = result.details?.meta?.truncation;
		expect(truncation?.totalBytes).toBeGreaterThan(70_000);
		expect(truncation?.nextOffset).toBeUndefined();
		if (!truncation) throw new Error("expected truncation metadata");
		expect(formatTruncationMetaNotice(truncation)).not.toContain("Use :2 to continue");

		const recovered = await tool.execute("call-buffered-oversized-raw", { path: `${bufferedFile}:raw:2-2` });
		const recoveredOutput = getTextOutput(recovered);
		expect(recoveredOutput).toStartWith("oversized-");
		expect(recoveredOutput).not.toContain("leading-context");
		expect(recoveredOutput).not.toContain("trailing-one");
		expect(recovered.details?.meta?.truncation?.partialLine).toBe(true);
	});

	it("accounts for the displayed preview when a single raw line exceeds the byte budget", async () => {
		// Regression #10768: an oversized first line collects no complete line but
		// still renders a ~50 KB byte-capped preview. The truncation meta used to
		// report outputLines=0/outputBytes=0/totalBytes=0, so the notice claimed
		// "Showing 0 of N lines (0B limit)" over visible content.
		const bigFile = path.join(testDir, "big.txt");
		const bigLine = "x".repeat(70000);
		await Bun.write(bigFile, `first\n${bigLine}\nlast\n`);

		const result = await tool.execute("call-oversized-line", { path: `${bigFile}:raw:2-2` });
		const body = getTextOutput(result);
		expect(Buffer.byteLength(body, "utf-8")).toBeGreaterThan(50000);

		const truncation = result.details?.meta?.truncation;
		expect(truncation).toBeDefined();
		if (!truncation) throw new Error("expected truncation meta");
		expect(truncation.partialLine).toBe(true);
		expect(truncation.outputLines).toBe(1);
		expect(truncation.outputBytes).toBe(Buffer.byteLength(body, "utf-8"));
		expect(truncation.totalBytes).toBe(70000);

		const notice = formatTruncationMetaNotice(truncation);
		expect(notice).toContain("(partial,");
		expect(notice).not.toMatch(/Showing 0 of/);
		expect(notice).not.toContain("0B limit");
	});
});
