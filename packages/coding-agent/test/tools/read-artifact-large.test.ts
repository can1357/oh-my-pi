import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { formatTruncationMetaNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

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
		allocateOutputArtifact: async (toolType: string) => ({
			id: "a1",
			path: path.join(cwd, "session", `a1.${toolType}.log`),
		}),
		settings: Settings.isolated(),
	};
}

function largeArtifactText(): string {
	return Array.from(
		{ length: 400 },
		(_, index) => `line-${String(index + 1).padStart(3, "0")} ${"x".repeat(256)}`,
	).join("\n");
}

function oversizedSelectedLineArtifact(): string {
	return ["leading-context", `oversized-${"x".repeat(70_000)}-end`, "trailing-one", "trailing-two"].join("\n");
}

function byteLimitedRangeArtifact(): string {
	return Array.from({ length: 100 }, (_, index) => `line-${index + 1} ${"x".repeat(1_016)}`).join("\n");
}

/**
 * 100 lines of 699 bytes — just under the 768-column output cap, so the text the
 * read returns is the bytes collected and the per-call budget is what bounds the
 * page, not the column truncation.
 */
function multiRangeBudgetArtifact(): string {
	return Array.from(
		{ length: 100 },
		(_, index) => `line-${String(index + 1).padStart(3, "0")} ${"x".repeat(690)}`,
	).join("\n");
}

/** 6.000 lines of 701 bytes, stacked past the 4 MiB snapshot cap so ranges stream off disk. */
function streamedMultiRangeArtifact(): string {
	return Array.from(
		{ length: 6_000 },
		(_, index) => `line-${String(index + 1).padStart(5, "0")} ${"x".repeat(690)}`,
	).join("\n");
}

/** 73 small lines, a 60 KB line 74, then small lines to 300 (wide second range). */
function oversizedTailArtifact(): string {
	return [
		...Array.from({ length: 73 }, (_, index) => `line-${String(index + 1).padStart(3, "0")} ${"x".repeat(690)}`),
		`line-074 ${"x".repeat(60_000)}`,
		...Array.from({ length: 226 }, (_, index) => `line-${String(index + 75).padStart(3, "0")} ${"x".repeat(690)}`),
	].join("\n");
}

/** 49 KB first line (fits the cap) + 2 KB second line: context eats the budget. */
function roomlessContextArtifact(): string {
	return [
		`ctx-line ${"y".repeat(49_996)}`,
		`wanted-002 ${"z".repeat(2000)}`,
		...Array.from({ length: 140 }, (_, index) => `tail-${String(index + 3).padStart(3, "0")}`),
	].join("\n");
}

/** A 60 KB `{`-opener followed by small lines and a closer: block-context bait. */
function blockBaitArtifact(): string {
	const lines = [`${"y".repeat(60_000)} {`];
	for (let index = 2; index <= 142; index++) {
		lines.push(index === 100 ? "}" : `wanted-${String(index).padStart(3, "0")}`);
	}
	return lines.join("\n");
}

/** A 60 KB line followed by small ones: oversized leading context, not content. */
function oversizedContextArtifact(): string {
	return [
		`context-60k ${"y".repeat(60_000)}`,
		...Array.from({ length: 200 }, (_, index) => `wanted-${String(index + 1).padStart(3, "0")}`),
	].join("\n");
}

/** 400 lines of 699 bytes: several budget pages, all addressable from memory. */
function wideMultiRangeArtifact(): string {
	return Array.from(
		{ length: 400 },
		(_, index) => `line-${String(index + 1).padStart(3, "0")} ${"x".repeat(690)}`,
	).join("\n");
}

/** One 60 KB line: multi-range EOF-clamp bait. */
function singleLineOversizedArtifact(): string {
	return `solo-${"x".repeat(60_000)}-end`;
}

/** ~4.4 MiB of ~1.1 KiB lines: past the 4 MiB snapshot cap, so reads stream. */
function hugeArtifact(): string {
	return Array.from(
		{ length: 4000 },
		(_, index) => `line-${String(index + 1).padStart(5, "0")} ${"x".repeat(1090)}`,
	).join("\n");
}

/** Streamed scale with a 200 KB line 70: per-range cap stops mid-range. */
function streamedStuckRangeArtifact(): string {
	const lines = Array.from({ length: 69 }, (_, index) => `s-${String(index + 1).padStart(3, "0")} ${"x".repeat(693)}`);
	lines.push(`stuck-070 ${"x".repeat(200_000)}`);
	for (let index = 71; index <= 6000; index++) lines.push(`s-${String(index).padStart(5, "0")} ${"x".repeat(693)}`);
	return lines.join("\n");
}

/** 60 KB `{`-opener at line 1, closer at 100, 250 small lines: block-context budget bait. */
function blockBudgetArtifact(): string {
	const lines = [`${"y".repeat(60_000)} {`];
	for (let index = 2; index <= 250; index++) {
		lines.push(index === 100 ? "}" : `s-${String(index).padStart(3, "0")}`);
	}
	return lines.join("\n");
}

/** Small line 1, 60 KB line 2, small lines 3-142: omitted-line remainder bait. */
function omittedRemainderArtifact(): string {
	const lines = ["ctx-small", `big-${"x".repeat(60_000)}-end`];
	for (let index = 3; index <= 142; index++) lines.push(`wanted-${String(index).padStart(3, "0")}`);
	return lines.join("\n");
}

/** Same scale, but the first line alone is 70 KB: wider than any per-range cap. */
function streamedOversizedFirstLineArtifact(): string {
	return [`oversized-first ${"x".repeat(70_000)}`, streamedMultiRangeArtifact()].join("\n");
}

/** 70 KB first line over a small buffered artifact: single-range preview path. */
function bufferedOversizedFirstLineArtifact(): string {
	return [
		`oversized-first ${"x".repeat(70_000)}`,
		...Array.from({ length: 200 }, (_, index) => `tail-${String(index + 2).padStart(3, "0")}`),
	].join("\n");
}

describe("read tool large artifact handling", () => {
	let testDir: string;
	let artifactDir: string;
	let unregisterArtifactsDir: (() => void) | undefined;
	let tool: ReadTool;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-large-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		await Bun.write(path.join(artifactDir, "0.mcp.log"), largeArtifactText());
		resetRegisteredArtifactDirsForTests();
		unregisterArtifactsDir = registerArtifactsDir(artifactDir);
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(async () => {
		unregisterArtifactsDir?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("blocks unbounded raw reads and points to bounded artifact workflows", async () => {
		const result = await tool.execute("call-raw", { path: "artifact://0:raw" });
		const output = getTextOutput(result);

		// The notice must name the artifact file so it can be searched or copied.
		// Only the directory prefix varies by host (a Windows temp dir sits under
		// `%USERPROFILE%` and is displayed shortened), so match the path tail.
		expect(output).toMatch(/session[/\\]0\.mcp\.log/);
		expect(output).not.toContain("line-001");
	});

	it("streams bounded artifact reads and points large artifacts at paging and search workflows", async () => {
		const result = await tool.execute("call-range", { path: "artifact://0:1-3" });
		const output = getTextOutput(result);

		expect(output).toContain("line-001");
		expect(output).toContain("line-003");
		expect(output).not.toContain("line-400");
		// A large artifact page surfaces its backing file for search/copy workflows.
		expect(output).toMatch(/session[/\\]0\.mcp\.log/);
		expect(result.details?.meta?.source).toEqual({ type: "internal", value: "artifact://0" });
	});

	it("keeps bounded raw artifact chunks verbatim (no workflow notice appended)", async () => {
		const result = await tool.execute("call-raw-range", { path: "artifact://0:raw:1-2" });
		const output = getTextOutput(result);

		// Raw chunks stay verbatim so copy/paste workflows never absorb the notice.
		expect(output.split("\n")).toEqual(largeArtifactText().split("\n").slice(0, 2));
		expect(output).not.toMatch(/0\.mcp\.log/);
	});

	it("returns exactly the requested raw artifact range without context padding", async () => {
		const result = await tool.execute("call-raw-exact", { path: "artifact://0:raw:31-31" });
		const output = getTextOutput(result);

		expect(output).toContain("line-031");
		expect(output).not.toContain("line-030");
		expect(output).not.toContain("line-032");
	});

	it("records the source line count for an open-ended artifact range that reaches EOF", async () => {
		const result = await tool.execute("call-raw-tail", { path: "artifact://0:raw:301-" });

		expect(result.details?.totalLines).toBe(400);
	});

	it("keeps the continuation when the byte budget stops inside requested artifact content", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), byteLimitedRangeArtifact());

		const result = await tool.execute("call-byte-limited-range", { path: "artifact://0:1-100" });
		const output = getTextOutput(result);
		const truncation = result.details?.meta?.truncation;

		expect(output).not.toContain("could not fit after preceding context");
		expect(output).not.toContain("to read that line without context");
		expect(truncation).toBeDefined();
		if (!truncation) throw new Error("expected truncation metadata");
		const shownRange = truncation.shownRange;
		expect(shownRange).toBeDefined();
		if (!shownRange) throw new Error("expected shown range");
		expect(truncation.nextOffset).toBe(shownRange.end + 1);
		expect(formatTruncationMetaNotice(truncation)).toContain(`Use :${truncation.nextOffset} to continue`);
	});

	it("reports an oversized selected line instead of sending a looping continuation selector", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), oversizedSelectedLineArtifact());

		const result = await tool.execute("call-oversized-selected", { path: "artifact://0:2-2" });
		const output = getTextOutput(result);

		expect(output).toContain("leading-context");
		expect(output).toContain("Line 2 is 68.4KB");
		expect(output).toContain("50.0KB read budget");
		expect(output).toContain("artifact://0:raw:2-2");
		const truncation = result.details?.meta?.truncation;
		expect(truncation?.totalBytes).toBeGreaterThan(70_000);
		expect(truncation?.nextOffset).toBeUndefined();
		if (!truncation) throw new Error("expected truncation metadata");
		expect(formatTruncationMetaNotice(truncation)).not.toContain("Use :2 to continue");
	});

	it("bounds a wide artifact range by the per-call budget instead of scaling past it", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), oversizedSelectedLineArtifact());

		const result = await tool.execute("call-wide-oversized-selected", { path: "artifact://0:2-142" });
		const output = getTextOutput(result);

		// Before the per-call budget, widening the range to 2-142 raised the byte
		// budget above the line's 68.4KB, so one page carried the whole oversized
		// line plus its trailing context. The budget is fixed per call now, so the
		// read falls back to the oversized-line notice and the raw hint, exactly
		// what `2-2` already did.
		expect(output).toContain("could not fit after preceding context");
		expect(output).toContain("Line 2 is 68.4KB");
		expect(output).toContain("50.0KB read budget");
		expect(output).toContain("artifact://0:raw:2-2");
		expect(output).not.toContain("trailing-two");
	});

	it("cuts a multi-range artifact read at the per-call byte budget and names the next line", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), multiRangeBudgetArtifact());

		const result = await tool.execute("call-multi-range-budget", { path: "artifact://0:1-40,60-100" });
		const output = getTextOutput(result);

		// Each range fits its own per-range budget (40 lines × 699 bytes ≈ 28KB),
		// so the old page returned all 81 selected lines for ~56KB. The per-call
		// budget stops the second range at a line boundary and says where to pick
		// the read back up in the same artifact.
		expect(output).toContain("line-001");
		expect(output).toContain("line-040");
		expect(output).toContain("line-060");
		expect(output).toContain("line-092");
		expect(output).not.toContain("line-093");
		expect(output).not.toContain("line-100");
		expect(output).toContain("Read budget of 50.0KB");
		expect(output).toContain("Use artifact://0:93-100 to continue");
		expect(result.details?.meta?.source).toEqual({ type: "internal", value: "artifact://0" });
	});

	it("keeps the remaining ranges in the continuation hint", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), wideMultiRangeArtifact());

		const result = await tool.execute("call-multi-range-ranges-kept", { path: "artifact://0:1-200,300-310" });
		const output = getTextOutput(result);

		// The budget runs out inside the first range. A hint that restarts at
		// an open offset would page through the unrequested gap and skip the
		// requested tail, so the hint carries the rest of this range plus the
		// later ones.
		expect(output).toContain("Read budget of 50.0KB");
		expect(output).toContain("Use artifact://0:74-200,300-310 to continue");
		expect(output).not.toContain("line-074");

		// Following the hint shows the cut line: nothing requested is skipped.
		const followed = getTextOutput(
			await tool.execute("call-multi-range-follow", { path: "artifact://0:74-200,300-310" }),
		);
		expect(followed).toContain("line-074");
		expect(followed).toContain("300-310");
	});

	it("applies the same per-call budget when the artifact is too large to buffer", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), streamedMultiRangeArtifact());

		const result = await tool.execute("call-streamed-multi-range-budget", { path: "artifact://0:1-40,60-100" });
		const output = getTextOutput(result);

		// 6.000 lines of 701 bytes sit just past the 4 MiB snapshot cap, so both
		// ranges stream off disk instead of slicing a buffer. The budget lands one
		// line earlier than the buffered case because every line is 701 bytes.
		expect(output).toContain("line-00001");
		expect(output).toContain("line-00040");
		expect(output).toContain("line-00060");
		expect(output).toContain("line-00091");
		expect(output).not.toContain("line-00092");
		expect(output).not.toContain("line-00100");
		expect(output).toContain("Read budget of 50.0KB");
		expect(output).toContain("Use artifact://0:92-100 to continue");
	});

	it("resumes at the same line when it fits a fresh budget", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), multiRangeBudgetArtifact());

		// 73 lines of 699 bytes leave 101 bytes of budget: line 75 cannot be
		// shown on this page, but at 699 bytes it fits a fresh 50 KB budget, so
		// the hint resumes at the same line instead of skipping it. The
		// follow-up shows it in full, which is what makes this not a loop.
		// (The gap at line 74 is the selector's, not the budget's.)
		const result = await tool.execute("call-multi-range-kept-zero", { path: "artifact://0:1-73,75-100" });
		const output = getTextOutput(result);

		expect(output).toContain("line-073");
		expect(output).toContain("Read budget of 50.0KB");
		expect(output).toContain("Use artifact://0:75-100 to continue");
		expect(output).not.toContain("line-075");

		const followed = getTextOutput(
			await tool.execute("call-multi-range-kept-zero-follow", { path: "artifact://0:75-100" }),
		);
		expect(followed).toContain("line-075");
		expect(followed).toContain("line-100");
		expect(followed).not.toContain("Read budget");
	});

	it("names a line that exceeds the full budget instead of looping", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), oversizedTailArtifact());

		// Line 74 is 60 KB: wider than any fresh budget, so resuming at it
		// would replay the same cut forever. The page names it with a raw
		// hint and resumes after it instead. (Line 73 is an unrequested gap:
		// adjacent ranges would merge into one.)
		const result = await tool.execute("call-multi-range-oversized-kept-zero", { path: "artifact://0:1-72,74-300" });
		const output = getTextOutput(result);

		expect(output).toContain("line-072");
		expect(output).toContain("Line 74 is");
		expect(output).toContain("was not shown");
		expect(output).toContain("Use artifact://0:raw:74-74");
		expect(output).toContain("artifact://0:75-300");
		expect(output).not.toContain("Use artifact://0:74-300");

		const followed = getTextOutput(
			await tool.execute("call-multi-range-oversized-follow", { path: "artifact://0:75-300" }),
		);
		expect(followed).toContain("line-075");
	});

	it("bounds the issue's own single-range raw repro and keeps the continuation raw", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), multiRangeBudgetArtifact());

		const result = await tool.execute("call-raw-single-repro", { path: "artifact://0:raw:1-300" });
		const output = getTextOutput(result);

		expect(output).toContain("line-001");
		expect(output).not.toContain("line-100");
		expect(output).toContain("Use artifact://0:raw:74-300 to continue");
		// No conflicting generic meta hint next to the bounded raw one.
		expect(result.details?.meta?.truncation?.nextOffset).toBeUndefined();

		const followed = getTextOutput(
			await tool.execute("call-raw-single-repro-follow", { path: "artifact://0:raw:74-300" }),
		);
		expect(followed).toContain("line-074");
		expect(followed).toContain("line-100");
	});

	it("keeps the end bound in streamed raw continuations", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), streamedMultiRangeArtifact());

		// Past the 4 MiB snapshot cap the same raw:1-300 goes through the
		// not-scanned-to-EOF branch, which used to emit an open offset that
		// pages past the requested end.
		const result = await tool.execute("call-raw-streamed-repro", { path: "artifact://0:raw:1-300" });
		const output = getTextOutput(result);

		expect(output).toContain("line-00001");
		expect(output).not.toContain("line-00301");
		expect(output).toContain("Use artifact://0:raw:73-300 to continue");

		const followed = getTextOutput(
			await tool.execute("call-raw-streamed-repro-follow", { path: "artifact://0:raw:73-300" }),
		);
		expect(followed).toContain("line-00073");
		expect(followed).not.toContain("line-00301");
	});

	it("bounds raw multi-range artifact reads at the same per-call budget", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), multiRangeBudgetArtifact());

		const result = await tool.execute("call-raw-multi-range", { path: "artifact://0:raw:1-40,60-100" });
		const output = getTextOutput(result);

		// The issue's own repro is a raw read: raw:1-300 must also fit one
		// finite bound. The cut stays on a line boundary and the hint stays
		// raw, so the continuation is the same kind of read.
		expect(output).toContain("line-001");
		expect(output).toContain("line-092");
		expect(output).not.toContain("line-093");
		expect(output).toContain("Read budget of 50.0KB");
		expect(output).toContain("Use artifact://0:raw:93-100 to continue");

		const followed = getTextOutput(
			await tool.execute("call-raw-multi-range-follow", { path: "artifact://0:raw:93-100" }),
		);
		expect(followed).toContain("line-093");
		expect(followed).toContain("line-100");
	});

	it("continues after an oversized first line instead of ending the page", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), bufferedOversizedFirstLineArtifact());

		// The capped first line ends the page at line 1 with a byte-capped
		// preview. Lines 2-300 would otherwise have no continuation: the
		// partial-line metadata intentionally carries no nextOffset.
		const raw = await tool.execute("call-oversized-first-single-raw", { path: "artifact://0:raw:1-300" });
		const rawOutput = getTextOutput(raw);
		expect(rawOutput).toContain("oversized-first");
		expect(rawOutput).toContain("Use artifact://0:raw:2-300 to continue");

		const rawFollowed = getTextOutput(
			await tool.execute("call-oversized-first-single-raw-follow", { path: "artifact://0:raw:2-300" }),
		);
		expect(rawFollowed).toContain("tail-002");

		const numbered = await tool.execute("call-oversized-first-single", { path: "artifact://0:1-300" });
		const numberedOutput = getTextOutput(numbered);
		expect(numberedOutput).toContain("Use artifact://0:2-300 to continue");

		const numberedFollowed = getTextOutput(
			await tool.execute("call-oversized-first-single-follow", { path: "artifact://0:2-300" }),
		);
		expect(numberedFollowed).toContain("tail-002");
	});

	it("names the stuck line when the per-range cap stops mid-range", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), streamedStuckRangeArtifact());

		// The 200 KB line 70 stops the per-range window while the shared budget
		// still has room, so lines 70-100 were never collected. Without a notice
		// they would vanish silently; the budget cut never fires here.
		const result = await tool.execute("call-stuck-range", { path: "artifact://0:1-50,52-100" });
		const output = getTextOutput(result);

		expect(output).toContain("s-001");
		expect(output).toContain("stopped at line 70");
		expect(output).toContain("Use artifact://0:70-100 to continue");
		expect(output).not.toContain("stuck-070");

		const followed = getTextOutput(await tool.execute("call-stuck-range-follow", { path: "artifact://0:70-100" }));
		expect(followed).toContain("Line 70 is");
		expect(followed).toContain("artifact://0:raw:70-70");
	});

	it("names an oversized first line instead of leaving a silent hole", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), streamedOversizedFirstLineArtifact());

		const result = await tool.execute("call-streamed-oversized-first", { path: "artifact://0:1-2,4-5" });
		const output = getTextOutput(result);

		// The 70 KB first line fits no per-range cap, so the window collects
		// nothing for range 1-2 — not even line 2. The page must say line 1 is
		// missing and carry the unattempted remainder in the hint.
		expect(output).not.toContain("oversized-first");
		expect(output).toContain("Line 1 is");
		expect(output).toContain("exceeds the 50.0KB per-read budget");
		expect(output).toContain("Use artifact://0:raw:1-1");
		expect(output).toContain("artifact://0:2-2,4-5");
		// The later range still renders in the same page.
		expect(output).toContain("line-00003");

		const raw = getTextOutput(
			await tool.execute("call-streamed-oversized-first-raw", { path: "artifact://0:raw:1-1" }),
		);
		expect(raw).toContain("oversized-first");

		const rest = getTextOutput(
			await tool.execute("call-streamed-oversized-first-rest", { path: "artifact://0:2-2,4-5" }),
		);
		expect(rest).toContain("line-00001");
		expect(rest).toContain("line-00003");
	});

	it("retries without context when it leaves no room for the requested start", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), roomlessContextArtifact());

		const result = await tool.execute("call-roomless-context", { path: "artifact://0:2-142" });
		const output = getTextOutput(result);

		// Line 1 fits the cap but leaves no room for line 2, so the first
		// collection returns context only. Widening cannot raise a fixed
		// budget; the read retries from the requested start instead of
		// showing no requested content.
		expect(output).toContain("wanted-002");
		expect(output).toContain("Leading context line 1");
		expect(output).toContain("was skipped");
		expect(output).not.toContain("yyyyyyyyyy");
	});

	it("keeps a skipped opener out of block context", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), blockBaitArtifact());

		const result = await tool.execute("call-block-bait", { path: "artifact://0:2-142" });
		const output = getTextOutput(result);

		// Line 1 opens a block its closer (line 100) belongs to, so the block
		// pass would normally resurface it as context. It was deliberately
		// skipped: the page must not display it and claim it was skipped.
		expect(output).toContain("wanted-002");
		expect(output).toContain("was skipped");
		expect(output).not.toContain("yyyyyyyyyy");
	});

	it("collects the requested window after dropping context, not one line more", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), oversizedContextArtifact());

		// Line 1 is dropped context; the window must be the requested line 2
		// plus its three trailing lines — not five lines reaching an
		// unrequested line 6 with a continuation pointing at it.
		const result = await tool.execute("call-context-limits", { path: "artifact://0:2-2" });
		const output = getTextOutput(result);

		expect(output).toContain("wanted-001");
		expect(output).toContain("wanted-004");
		expect(output).not.toContain("wanted-005");
	});

	it("skips oversized leading context instead of rendering it", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), oversizedContextArtifact());

		const result = await tool.execute("call-oversized-context", { path: "artifact://0:2-142" });
		const output = getTextOutput(result);

		// Line 1 is context for the requested line 2, not content: with a
		// fixed per-call budget it can no longer ride along, so the page says
		// it was skipped and spends the budget on the requested lines.
		expect(output).toContain("wanted-002");
		expect(output).toContain("Leading context line 1");
		expect(output).toContain("was skipped");
		expect(output).not.toContain("context-60k");
	});

	it("keeps raw oversized-line reads context-free and byte-capped", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), oversizedSelectedLineArtifact());

		const result = await tool.execute("call-raw-oversized-selected", { path: "artifact://0:raw:2-2" });
		const output = getTextOutput(result);

		expect(output).toStartWith("oversized-");
		expect(output).not.toContain("leading-context");
		expect(output).not.toContain("trailing-one");
		expect(result.details?.meta?.truncation?.partialLine).toBe(true);
		expect(result.details?.meta?.truncation?.shownRange).toEqual({ start: 2, end: 2 });
	});

	it("tails an artifact with :-N by counting lines first, then streaming only that window", async () => {
		const output = getTextOutput(await tool.execute("call-tail", { path: "artifact://0:-3" }));

		// One leading context line joins the requested 398-400 window.
		expect(output).not.toContain("line-396");
		expect(output).toContain("line-397");
		expect(output).toContain("line-398");
		expect(output).toContain("line-400");

		const raw = getTextOutput(await tool.execute("call-raw-tail-n", { path: "artifact://0:raw:-2" }));
		expect(raw).toStartWith("line-399");
		expect(raw).not.toContain("line-398");
		expect(raw).toContain("line-400");
	});

	it("shortens artifact paths under the user's home dir instead of leaking the absolute path", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue(testDir);
		try {
			const result = await tool.execute("call-raw-home", { path: "artifact://0:raw" });
			const output = getTextOutput(result);
			// artifactDir sits under the (mocked) home, so the notice must display it
			// as `~`-relative (with `/` separators) and must NOT leak the absolute
			// artifact path. Assert the exact displayed path rather than recomputing
			// it with the production shortener.
			expect(output).toContain("~/session/0.mcp.log");
			expect(output).not.toContain(artifactDir);
		} finally {
			homeSpy.mockRestore();
		}
	});

	it("withholds block context that alone exceeds the artifact budget", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), blockBudgetArtifact());

		// With column truncation off the 60 KB `{`-opener would ride along verbatim
		// as off-window block context for lines 100 and 200, pushing the page past
		// the fixed 50 KB per-call budget `pagedSource` cannot spill downstream.
		const zeroColumnTool = new ReadTool({
			...makeSession(testDir),
			settings: Settings.isolated({ "tools.outputMaxColumns": 0 }),
		});
		const result = await zeroColumnTool.execute("call-block-budget", {
			path: "artifact://0:100-100,200-200",
		});
		const output = getTextOutput(result);

		expect(output).toContain("s-200");
		expect(output).not.toContain("yyyyyyyyyy");
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(51_200);
	});

	it("carries the remainder after an omitted requested line", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), omittedRemainderArtifact());

		// Line 2 is 60 KB behind a small retained context line: the page names the
		// omitted line's raw preview, and must also carry lines 3-142 explicitly —
		// the suppressed `nextOffset` leaves them no other continuation.
		const result = await tool.execute("call-omitted-remainder", { path: "artifact://0:2-142" });
		const output = getTextOutput(result);

		expect(output).toContain("could not fit after preceding context");
		expect(output).toContain("artifact://0:raw:2-2");
		expect(output).toContain("Use artifact://0:3-142 to continue");

		const followed = getTextOutput(
			await tool.execute("call-omitted-remainder-follow", { path: "artifact://0:3-142" }),
		);
		expect(followed).toContain("wanted-003");
	});

	it("emits no continuation past the known EOF after an omitted line", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), ["ctx-small", `big-${"x".repeat(60_000)}-end`].join("\n"));

		// Two-line file read as `2-142`: line 2 is omitted with its raw hint, but
		// lines 3-142 do not exist (`totalFileLines` is 2), so no `3-142`
		// follow-up may be advertised.
		const result = await tool.execute("call-omitted-eof", { path: "artifact://0:2-142" });
		const output = getTextOutput(result);

		expect(output).toContain("could not fit after preceding context");
		expect(output).toContain("artifact://0:raw:2-2");
		expect(output).not.toContain("3-142");

		// Same file, open-ended selector: without the EOF gate the clamped end
		// is absent (`resumeEnd === undefined`) and a bogus `3-` follow-up lands.
		const openEnded = getTextOutput(await tool.execute("call-omitted-eof-open", { path: "artifact://0:2-" }));
		expect(openEnded).toContain("artifact://0:raw:2-2");
		expect(openEnded).not.toContain("Use artifact://0:3-");
	});

	it("drops multi-range recovery past the known EOF", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), singleLineOversizedArtifact());

		// One-line file read as `1-2,4-5`: line 1 is oversized with its raw hint,
		// and both the `2-2` suffix and the `4-5` later range are past EOF. The
		// advertised rest must not name them; following it once returned only
		// beyond-EOF notices and no requested content.
		const result = await tool.execute("call-multi-eof", { path: "artifact://0:1-2,4-5" });
		const output = getTextOutput(result);

		expect(output).toContain("artifact://0:raw:1-1");
		expect(output).toContain("Range 4-5 is beyond end of file");
		expect(output).not.toContain("2-2,4-5");
	});

	it("drops raw multi-range recovery past the buffered EOF", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), singleLineOversizedArtifact());

		// Raw reads never set `fullLines`, but the buffered collector still knows
		// the exact count: `raw:1-2,4-5` on a one-line file must not advertise
		// `raw:2-2,4-5`, whose follow-up returns only out-of-bounds notices.
		const result = await tool.execute("call-raw-multi-eof", { path: "artifact://0:raw:1-2,4-5" });
		const output = getTextOutput(result);

		expect(output).toContain("raw:1-1");
		expect(output).not.toContain("raw:2-2,4-5");
	});

	it("keeps the bound on numbered streamed continuations", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), hugeArtifact());

		// A bare `:N` means "from N onward": the recovery page for `1-300` must
		// carry its end, or following it reads past line 300.
		const result = await tool.execute("call-streamed-bound", { path: "artifact://0:1-300" });
		const output = getTextOutput(result);

		expect(output).toMatch(/Use artifact:\/\/0:\d+-300 to continue/);
	});

	it("ends the page when a streamed range stops incomplete", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), hugeArtifact());

		// The first window stops ~line 47 and names `47-100,200-200`. Visiting
		// line 200 next with less than a line of budget left appended a second
		// `200-200` hint whose follow-up skips 47-100.
		const result = await tool.execute("call-streamed-stop", { path: "artifact://0:1-100,200-200" });
		const output = getTextOutput(result);

		expect(output).toContain("47-100,200-200");
		expect(output).not.toContain("Use artifact://0:200-200 to continue");
		expect(output).not.toContain("line-00200");
	});
});
