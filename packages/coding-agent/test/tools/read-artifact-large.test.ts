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

/** Same scale, but the first line alone is 70 KB: wider than any per-range cap. */
function streamedOversizedFirstLineArtifact(): string {
	return [`oversized-first ${"x".repeat(70_000)}`, streamedMultiRangeArtifact()].join("\n");
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
});
