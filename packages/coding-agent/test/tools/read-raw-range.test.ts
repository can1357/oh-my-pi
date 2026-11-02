import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getConflictHistory } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { formatTruncationMetaNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

function makeSession(cwd: string, bridge?: ClientBridge): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		getClientBridge: bridge ? () => bridge : undefined,
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
		InternalUrlRouter.resetForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	describe.each(["disk", "located", "in-memory"])("%s raw reads", source => {
		it.each([
			["raw:2", "B"],
			["2:raw", "B"],
			["2-2:raw", "B"],
			["raw:1,3", "A\nC"],
			["1,3:raw", "A\nC"],
			["raw:3-4,2-3", "B\nC\nD"],
			["raw:-2", "C\nD"],
			["2-:raw", "B\nC\nD\n"],
			["raw:1,3-", "A\nC\nD\n"],
			["raw:1,3-99", "A\nC\nD"],
			["raw:1,99", "A"],
			["raw:99,101", ""],
			["raw:99", ""],
		])("returns only selected source lines for %s", async (selector, expected) => {
			const body = "A\nB\nC\nD\n";
			await Bun.write(filePath, body);
			await Bun.write(path.join(testDir, "session", "0.read.log"), body);
			const handler: ProtocolHandler = {
				scheme: "verbatim",
				spec: { backing: "virtual", selectors: "lines", immutable: true },
				resolve: async url => ({ url: url.href, content: body, contentType: "text/plain" }),
			};
			InternalUrlRouter.resetForTests();
			InternalUrlRouter.instance().register(handler);
			const wrapped = wrapToolWithMetaNotice(new ReadTool(makeSession(testDir)));

			const target = source === "disk" ? filePath : source === "located" ? "artifact://0" : "verbatim://fixture";
			const result = await wrapped.execute("raw-selected-lines", { path: `${target}:${selector}` });
			expect(getTextOutput(result)).toBe(expected);
			expect(result.details?.meta?.truncation).toBeUndefined();
			if (["raw:1,99", "raw:99,101", "raw:99"].includes(selector)) {
				expect(result.details?.notes?.join("\n")).toContain("beyond end");
			}
		});
	});

	it.each(["disk", "in-memory"])("keeps non-raw out-of-bounds notices in the %s body", async source => {
		await Bun.write(filePath, "A\nB\n");
		const handler: ProtocolHandler = {
			scheme: "verbatim",
			spec: { backing: "virtual", selectors: "lines", immutable: true },
			resolve: async url => ({ url: url.href, content: "A\nB\n", contentType: "text/plain" }),
		};
		InternalUrlRouter.resetForTests();
		InternalUrlRouter.instance().register(handler);

		const target = source === "disk" ? filePath : "verbatim://fixture";
		const result = await tool.execute("normal-bounds", { path: `${target}:1-1,99-99` });
		expect(getTextOutput(result)).toContain("A");
		expect(getTextOutput(result)).toContain("Range 99-99 is beyond end");
		expect(result.details?.notes).toBeUndefined();
	});

	it.each(["disk", "bridge", "archive", "json"])(
		"keeps a recovered %s source path in details rather than a raw prefix",
		async source => {
			const nested = path.join(testDir, "nested");
			let target: string;
			let bridge: ClientBridge | undefined;
			if (source === "archive") {
				await writeArchive(path.join(nested, "recovered.zip"), "zip", [["lines.txt", "A\nB\n"]]);
				target = "recovered.zip:lines.txt";
			} else if (source === "json") {
				await Bun.write(path.join(nested, "recovered.json"), '["A","B"]');
				target = "recovered.json?q=.[]&raw=true";
			} else {
				await Bun.write(path.join(nested, "recovered.txt"), source === "bridge" ? "disk A\ndisk B\n" : "A\nB\n");
				target = "recovered.txt";
				if (source === "bridge") {
					bridge = {
						capabilities: { readTextFile: true },
						readTextFile: async () => "A\nB\n",
					};
				}
			}
			const read = wrapToolWithMetaNotice(new ReadTool(makeSession(testDir, bridge)));
			for (const [selector, expected] of [
				["2:raw", "B"],
				["1,99:raw", "A"],
			]) {
				const result = await read.execute("recovered-raw", { path: `${target}:${selector}` });
				expect(getTextOutput(result)).toBe(expected);
				expect(result.details?.suffixResolution?.to).toContain("nested/recovered.");
			}
			expect(getTextOutput(await read.execute("recovered-normal", { path: target }))).toContain("via suffix match");
		},
	);

	it("keeps repeated raw content unchanged while retaining the loop diagnostic in details", async () => {
		await Bun.write(filePath, "A\nB\n");
		const read = wrapToolWithMetaNotice(tool);
		for (let count = 1; count <= 4; count++) {
			const result = await read.execute("repeat-raw", { path: `${filePath}:2:raw` });
			expect(getTextOutput(result)).toBe("B");
			if (count >= 3) expect(result.details?.notes?.join("\n")).toContain(`identical output ${count} times`);
		}
		const normal = wrapToolWithMetaNotice(new ReadTool(makeSession(testDir)));
		await normal.execute("normal-first", { path: filePath });
		await normal.execute("normal-second", { path: filePath });
		expect(getTextOutput(await normal.execute("normal-third", { path: filePath }))).toContain(
			"identical output 3 times",
		);
	});

	it("preserves CR bytes and joins disjoint raw windows with only a source line separator", async () => {
		await Bun.write(filePath, "A\r\nB\r\nC\r\nD\r\n");
		const wrapped = wrapToolWithMetaNotice(tool);

		expect(getTextOutput(await wrapped.execute("crlf-comma", { path: `${filePath}:1,3:raw` }))).toBe("A\r\nC\r");
		expect(getTextOutput(await wrapped.execute("crlf-single", { path: `${filePath}:2:raw` }))).toBe("B\r");
		expect(getTextOutput(await wrapped.execute("crlf-open", { path: `${filePath}:raw:3-` }))).toBe("C\r\nD\r\n");
	});

	it("keeps conflict diagnostics in details without changing raw bytes or conflict registration", async () => {
		const conflict = "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs";
		await Bun.write(filePath, `before\n${conflict}\nafter\n`);
		const session = makeSession(testDir);
		const wrapped = wrapToolWithMetaNotice(new ReadTool(session));
		const raw = await wrapped.execute("raw-conflict", { path: `${filePath}:2-6:raw` });

		expect(getTextOutput(raw)).toBe(conflict);
		expect(raw.details?.conflictCount).toBe(1);
		expect(raw.details?.notes?.join("\n")).toContain("conflict://<N>");
		expect(getConflictHistory(session).entries()).toMatchObject([{ id: 1, startLine: 2, endLine: 6 }]);

		const normal = await wrapped.execute("normal-conflict", { path: `${filePath}:2-6` });
		expect(getTextOutput(normal)).toContain("conflict://<N>");
		expect(normal.details?.conflictCount).toBe(1);
		expect(normal.details?.notes).toBeUndefined();
	});

	it("still reports a real byte ceiling when a finite raw range is not satisfied", async () => {
		const line = "x".repeat(DEFAULT_MAX_BYTES + 10);
		await Bun.write(filePath, `first\n${line}\nlast\n`);
		const result = await wrapToolWithMetaNotice(tool).execute("raw-byte-ceiling", { path: `${filePath}:2:raw` });
		const truncation = result.details?.meta?.truncation;
		if (!truncation) throw new Error("expected byte-limit metadata");

		expect(truncation).toMatchObject({
			truncatedBy: "bytes",
			partialLine: true,
			outputBytes: DEFAULT_MAX_BYTES,
			totalBytes: line.length,
		});
		expect(getTextOutput(result)).toBe(
			`${line.slice(0, DEFAULT_MAX_BYTES)}\n\n[${formatTruncationMetaNotice(truncation)}]`,
		);
	});

	it("still reports a real line ceiling for an open-ended raw read", async () => {
		await Bun.write(filePath, Array.from({ length: 320 }, (_, i) => `line ${i + 1}`).join("\n"));
		const result = await wrapToolWithMetaNotice(tool).execute("raw-line-ceiling", { path: `${filePath}:raw` });
		const truncation = result.details?.meta?.truncation;
		if (!truncation) throw new Error("expected line-limit metadata");

		expect(truncation).toMatchObject({
			truncatedBy: "lines",
			shownRange: { start: 1, end: 300 },
			nextOffset: 301,
		});
		expect(getTextOutput(result)).toEndWith(`\n\n[${formatTruncationMetaNotice(truncation)}]`);
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

	it("reads a bare line number beside raw as that one line, and N- as open-ended", async () => {
		for (const selector of ["31:raw", "raw:31"]) {
			const result = await tool.execute("call-raw-bare", { path: `${filePath}:${selector}` });
			expect(getTextOutput(result)).toBe("L31");
		}

		const open = await tool.execute("call-raw-open", { path: `${filePath}:58-:raw` });
		expect(getTextOutput(open)).toBe("L58\nL59\nL60");
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

		const result = await wrapToolWithMetaNotice(tool).execute("streamed-raw-range", {
			path: `${streamedFile}:raw:2-3`,
		});
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
		expect(getTextOutput(buffered)).toBe("one\nthree\n");
		expect(getTextOutput(streamed)).toBe("two\nfour\n");
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
