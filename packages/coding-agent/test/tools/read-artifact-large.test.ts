import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { formatTruncationMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta-format";
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

describe("read tool large spill handling", () => {
	let testDir: string;
	let artifactDir: string;
	let tool: ReadTool;

	beforeEach(async () => {
		// Real path: local:// locates through symlinks (macOS `/var` → `/private/var`).
		testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "read-spill-large-")));
		artifactDir = path.join(testDir, "session", "local");
		await fs.mkdir(artifactDir, { recursive: true });
		await Bun.write(path.join(artifactDir, "0.log"), largeArtifactText());
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("preserves a single-line JSON spill within the byte budget in default and raw reads while capping non-spill local files", async () => {
		const json = JSON.stringify({ payload: "x".repeat(15_000), tail: "complete-json" });
		await Bun.write(path.join(artifactDir, "0.log"), json);
		await Bun.write(path.join(artifactDir, "notes.txt"), json);

		const defaultResult = await tool.execute("call-json-default", { path: "local://0.log" });
		const defaultOutput = getTextOutput(defaultResult);
		expect(defaultOutput).toContain(json);
		expect(defaultResult.details?.meta?.truncation).toBeUndefined();

		const rawResult = await tool.execute("call-json-raw", { path: "local://0.log:raw" });
		expect(getTextOutput(rawResult)).toBe(json);
		expect(rawResult.details?.meta?.truncation).toBeUndefined();

		const scratchResult = await tool.execute("call-scratch-default", { path: "local://notes.txt" });
		expect(getTextOutput(scratchResult)).not.toContain("complete-json");
		expect(scratchResult.details?.meta?.limits?.columnTruncated?.maxColumn).toBeGreaterThan(0);
	});

	it("preserves distinct long JSON lines in a multi-range spill read", async () => {
		const first = JSON.stringify({ payload: "a".repeat(15_000), tail: "first-json-tail" });
		const last = JSON.stringify({ payload: "z".repeat(15_000), tail: "last-json-tail" });
		await Bun.write(path.join(artifactDir, "0.log"), `${first}\nmiddle\n${last}`);

		const result = await tool.execute("call-json-multi-range", { path: "local://0.log:1-1,3-3" });
		const output = getTextOutput(result);
		expect(output).toContain(first);
		expect(output).toContain(last);
		expect(result.details?.meta?.truncation).toBeUndefined();
	});

	it("bounds oversized selected lines in buffered multi-range spills and reports omission", async () => {
		await Bun.write(path.join(artifactDir, "0.log"), `${"a".repeat(1_900_000)}\nmiddle\n${"z".repeat(1_900_000)}`);

		const result = await tool.execute("call-budget-multi", { path: "local://0.log:1-1,3-3" });
		const output = getTextOutput(result);
		expect(Buffer.byteLength(output)).toBeLessThan(110_000);
		expect(output).toContain("Line 1");
		expect(output).toContain("Line 3");
		expect(output).toContain("50.0KB");
		expect(output).toContain("local://0.log:raw:1-1");
		expect(output).toContain("local://0.log:raw:3-3");
		const truncation = result.details?.meta?.truncation;
		expect(truncation).toBeDefined();
		expect(truncation?.nextOffset).toBeUndefined();
		if (!truncation) throw new Error("expected truncation metadata");
		expect(formatTruncationMetaNotice(truncation)).not.toContain("to continue");
	});

	it("clips oversized enclosing context without clipping selected spill lines", async () => {
		const selected = JSON.stringify({ item: "x".repeat(15_000), tail: "selected-tail" });
		await Bun.write(
			path.join(artifactDir, "0.log"),
			[
				`{"payload":"${"p".repeat(1_000_000)}","items":[`,
				...Array.from({ length: 520 }, (_, index) => (index === 519 ? `${selected},` : `{"item":${index}},`)),
				"{}]}",
			].join("\n"),
		);

		for (const selector of ["520-522", "2-2,521-522"]) {
			const result = await tool.execute(`call-budget-context-${selector}`, { path: `local://0.log:${selector}` });
			const output = getTextOutput(result);
			expect(Buffer.byteLength(output)).toBeLessThan(50_000);
			expect(output).toContain(selected);
			expect(output).toContain('{"payload":"');
			expect(result.details?.meta?.limits?.columnTruncated?.maxColumn).toBeGreaterThan(0);
		}
	});

	it("blocks unbounded raw reads and points to bounded artifact workflows", async () => {
		const result = await tool.execute("call-raw", { path: "local://0.log:raw" });
		const output = getTextOutput(result);

		// The notice must name the artifact file so it can be searched or copied.
		// Only the directory prefix varies by host (a Windows temp dir sits under
		// `%USERPROFILE%` and is displayed shortened), so match the path tail.
		expect(output).toMatch(/local[/\\]0\.log/);
		expect(output).not.toContain("line-001");
	});

	it("streams bounded artifact reads and points large artifacts at paging and search workflows", async () => {
		const result = await tool.execute("call-range", { path: "local://0.log:1-3" });
		const output = getTextOutput(result);

		expect(output).toContain("line-001");
		expect(output).toContain("line-003");
		expect(output).not.toContain("line-400");
		// A large artifact page surfaces its backing file for search/copy workflows.
		expect(output).toMatch(/local[/\\]0\.log/);
		expect(result.details?.meta?.source).toEqual({ type: "internal", value: "local://0.log" });
	});

	it("keeps bounded raw artifact chunks verbatim (no workflow notice appended)", async () => {
		const result = await tool.execute("call-raw-range", { path: "local://0.log:raw:1-2" });
		const output = getTextOutput(result);

		// Raw chunks stay verbatim so copy/paste workflows never absorb the notice.
		expect(output).toBe(`${largeArtifactText().split("\n").slice(0, 2).join("\n")}\n`);
		expect(output).not.toMatch(/0\.log/);
	});

	it("returns exactly the requested raw artifact range without context padding", async () => {
		const result = await tool.execute("call-raw-exact", { path: "local://0.log:raw:31-31" });
		const output = getTextOutput(result);

		expect(output).toContain("line-031");
		expect(output).not.toContain("line-030");
		expect(output).not.toContain("line-032");
	});

	it("records the source line count for an open-ended artifact range that reaches EOF", async () => {
		const result = await tool.execute("call-raw-tail", { path: "local://0.log:raw:301-" });

		expect(result.details?.totalLines).toBe(400);
	});

	it("keeps the continuation when the byte budget stops inside requested artifact content", async () => {
		await Bun.write(path.join(artifactDir, "0.log"), byteLimitedRangeArtifact());

		const result = await tool.execute("call-byte-limited-range", { path: "local://0.log:1-100" });
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
		expect(formatTruncationMetaNotice(truncation)).toContain(`Use :${truncation.nextOffset}- to continue`);
	});

	it("reports an oversized selected line instead of sending a looping continuation selector", async () => {
		await Bun.write(path.join(artifactDir, "0.log"), oversizedSelectedLineArtifact());

		// Uncapped, so the line is charged its full size rather than its column-cut display.
		const uncapped = new ReadTool({
			...makeSession(testDir),
			settings: Settings.isolated({ "tools.outputMaxColumns": 0 }),
		});
		const result = await uncapped.execute("call-oversized-selected", { path: "local://0.log:2-2" });
		const output = getTextOutput(result);

		expect(output).toContain("leading-context");
		expect(output).toContain("Line 2 is 68.4KB");
		expect(output).toContain("50.0KB read budget");
		expect(output).toContain("local://0.log:raw:2-2");
		const truncation = result.details?.meta?.truncation;
		expect(truncation?.totalBytes).toBeGreaterThan(70_000);
		expect(truncation?.nextOffset).toBeUndefined();
		if (!truncation) throw new Error("expected truncation metadata");
		expect(formatTruncationMetaNotice(truncation)).not.toContain("Use :2- to continue");
	});

	it("still returns the oversized selected line when a wider range raises the byte budget", async () => {
		await Bun.write(path.join(artifactDir, "0.log"), oversizedSelectedLineArtifact());

		const result = await tool.execute("call-wide-oversized-selected", { path: "local://0.log:2-142" });
		const output = getTextOutput(result);

		expect(output).toContain("oversized-");
		expect(output).toContain("trailing-two");
		expect(output).not.toContain("could not fit after preceding context");
		expect(result.details?.meta?.truncation).toBeUndefined();
	});

	it("keeps raw oversized-line reads context-free and byte-capped", async () => {
		await Bun.write(path.join(artifactDir, "0.log"), oversizedSelectedLineArtifact());

		const result = await tool.execute("call-raw-oversized-selected", { path: "local://0.log:raw:2-2" });
		const output = getTextOutput(result);

		expect(output).toStartWith("oversized-");
		expect(output).not.toContain("leading-context");
		expect(output).not.toContain("trailing-one");
		expect(result.details?.meta?.truncation?.partialLine).toBe(true);
		expect(result.details?.meta?.truncation?.shownRange).toEqual({ start: 2, end: 2 });
	});

	it("tails an artifact with :-N by counting lines first, then streaming only that window", async () => {
		const output = getTextOutput(await tool.execute("call-tail", { path: "local://0.log:-3" }));

		// One leading context line joins the requested 398-400 window.
		expect(output).not.toContain("line-396");
		expect(output).toContain("line-397");
		expect(output).toContain("line-398");
		expect(output).toContain("line-400");

		const raw = getTextOutput(await tool.execute("call-raw-tail-n", { path: "local://0.log:raw:-2" }));
		expect(raw).toStartWith("line-399");
		expect(raw).not.toContain("line-398");
		expect(raw).toContain("line-400");
	});

	it("pages a spill past local://'s 1 MiB inline cap through its backing file", async () => {
		const lines = Array.from({ length: 5_000 }, (_, i) => `row-${String(i + 1).padStart(4, "0")} ${"y".repeat(300)}`);
		await Bun.write(path.join(artifactDir, "7.log"), lines.join("\n"));

		const head = getTextOutput(await tool.execute("call-mib-head", { path: "local://7.log" }));
		expect(head).toContain("row-0001");
		expect(head).not.toContain("row-5000");
		expect(head).not.toContain("full internal resolution is blocked");

		const raw = await tool.execute("call-mib-raw", { path: "local://7.log:raw:1-3000" });
		expect(getTextOutput(raw)).toBe(`${lines.slice(0, 3_000).join("\n")}\n`);
		expect(raw.details?.meta?.truncation).toBeUndefined();
	});

	it("shortens artifact paths under the user's home dir instead of leaking the absolute path", async () => {
		const homeSpy = spyOn(os, "homedir").mockReturnValue(testDir);
		try {
			const result = await tool.execute("call-raw-home", { path: "local://0.log:raw" });
			const output = getTextOutput(result);
			// artifactDir sits under the (mocked) home, so the notice must display it
			// as `~`-relative (with `/` separators) and must NOT leak the absolute
			// artifact path. Assert the exact displayed path rather than recomputing
			// it with the production shortener.
			expect(output).toContain("~/session/local/0.log");
			expect(output).not.toContain(artifactDir);
		} finally {
			homeSpy.mockRestore();
		}
	});
});
