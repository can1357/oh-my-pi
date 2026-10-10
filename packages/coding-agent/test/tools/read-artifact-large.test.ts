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
		expect(output).toContain("32.0KB read budget");
		expect(output).toContain("artifact://0:raw:2-2");
		const truncation = result.details?.meta?.truncation;
		expect(truncation?.totalBytes).toBeGreaterThan(70_000);
		expect(truncation?.nextOffset).toBeUndefined();
		if (!truncation) throw new Error("expected truncation metadata");
		expect(formatTruncationMetaNotice(truncation)).not.toContain("Use :2 to continue");
	});

	it("cuts a wide artifact range at the per-call page budget instead of raising it past it", async () => {
		await Bun.write(path.join(artifactDir, "0.mcp.log"), oversizedSelectedLineArtifact());

		const result = await tool.execute("call-wide-oversized-selected", { path: "artifact://0:2-142" });
		const output = getTextOutput(result);

		// The page budget bounds the window even when the requested range would
		// scale the byte budget above it, so the oversized line stays behind the
		// raw-range hint rather than being widened back into the page.
		expect(output).toContain("leading-context");
		expect(output).toContain("32.0KB read budget");
		expect(output).toContain("artifact://0:raw:2-2");
		expect(output).not.toContain("trailing-two");
		expect(result.details?.meta?.truncation).toBeDefined();
	});

	it("bounds one artifact range at the per-call page budget and names the next line", async () => {
		// 300 lines of ~265 B ≈ 79 KB; the 32 KB page budget cuts at a line
		// boundary instead of the line-scaled ~150 KB the range would otherwise get.
		const result = await tool.execute("call-page-budget-range", { path: "artifact://0:1-300" });
		const output = getTextOutput(result);
		const truncation = result.details?.meta?.truncation;

		expect(output).toContain("line-001");
		expect(output).toContain("line-123");
		expect(output).not.toContain("line-124");
		expect(output).not.toContain("line-300");
		expect(truncation).toBeDefined();
		if (!truncation) throw new Error("expected truncation metadata");
		expect(truncation.truncatedBy).toBe("bytes");
		expect(truncation.shownRange).toEqual({ start: 1, end: 123 });
		expect(truncation.nextOffset).toBe(124);
		expect(truncation.outputBytes).toBeLessThanOrEqual(32 * 1024);
		expect(formatTruncationMetaNotice(truncation)).toContain("Use :124 to continue");
	});

	it("bounds a multi-range artifact read at one per-call page budget", async () => {
		const result = await tool.execute("call-page-budget-multi", { path: "artifact://0:1-100,200-300" });
		const output = getTextOutput(result);

		// The first range consumes most of the 32 KB budget; the second is cut at
		// a line boundary and the notice names where to continue on the artifact.
		expect(output).toContain("line-001");
		expect(output).toContain("line-100");
		expect(output).toContain("line-200");
		expect(output).toContain("line-222");
		expect(output).not.toContain("line-223");
		expect(output).not.toContain("line-300");
		expect(output).toContain("Read page budget (32.0KB) reached after lines 200-222");
		expect(output).toContain("use artifact://0:223 to continue");
	});

	it("bounds a raw multi-range artifact read at the same per-call page budget", async () => {
		const result = await tool.execute("call-page-budget-raw-multi", { path: "artifact://0:raw:1-100,200-300" });
		const output = getTextOutput(result);

		expect(output).toContain("line-001");
		expect(output).toContain("line-100");
		expect(output).toContain("line-200");
		expect(output).toContain("line-222");
		expect(output).not.toContain("line-223");
		expect(output).toContain("Read page budget (32.0KB) reached after lines 200-222");
		expect(output).toContain("use artifact://0:223 to continue");
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
