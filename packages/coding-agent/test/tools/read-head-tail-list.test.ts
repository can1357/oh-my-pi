import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { parseSel, resolveTailSelector } from "@oh-my-pi/pi-coding-agent/tools/read-selector";
import { splitInternalUrlSel, splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";

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

/** Lines `row-1` … `row-N`, each marker unique so presence checks cannot match a neighbour. */
function rows(count: number): string {
	return `${Array.from({ length: count }, (_, index) => `row-${index + 1}.`).join("\n")}\n`;
}

describe("comma line lists with a tail chunk", () => {
	it("keeps the listed ranges next to the last N lines", () => {
		const parsed = parseSel("1-12,-15");
		expect(resolveTailSelector(parsed, 100)).toEqual({
			kind: "lines",
			ranges: [
				{ startLine: 1, endLine: 12 },
				{ startLine: 86, endLine: 100 },
			],
			raw: undefined,
		});
	});

	it("reads a bare number in the list as that one line", () => {
		expect(resolveTailSelector(parseSel("19,-5"), 100)).toMatchObject({
			ranges: [
				{ startLine: 19, endLine: 19 },
				{ startLine: 96, endLine: 100 },
			],
		});
	});

	it("merges every listed range with the tail", () => {
		expect(resolveTailSelector(parseSel("1-12,-15"), 20)).toMatchObject({ ranges: [{ startLine: 1, endLine: 20 }] });
		expect(resolveTailSelector(parseSel("90-,-5"), 100)).toMatchObject({
			ranges: [{ startLine: 90, endLine: undefined }],
		});
		// A range inside the tail must not cut off an open-ended range after it.
		expect(resolveTailSelector(parseSel("1-2,90-92,95-,-15"), 100)).toMatchObject({
			ranges: [
				{ startLine: 1, endLine: 2 },
				{ startLine: 86, endLine: undefined },
			],
		});
		// A disjoint range past EOF stays, so the reader can report it.
		expect(resolveTailSelector(parseSel("1-2,500-510,-3"), 100)).toMatchObject({
			ranges: [
				{ startLine: 1, endLine: 2 },
				{ startLine: 98, endLine: 100 },
				{ startLine: 500, endLine: 510 },
			],
		});
	});

	it("keeps raw on a list combined with raw", () => {
		expect(resolveTailSelector(parseSel("raw:1-2,-2"), 10)).toEqual({
			kind: "lines",
			ranges: [
				{ startLine: 1, endLine: 2 },
				{ startLine: 9, endLine: 10 },
			],
			raw: true,
		});
	});
});

describe("splitting a list that repeats its colon", () => {
	it("folds the repeated colon in either raw order", () => {
		expect(splitPathAndSel("a.txt:1-30,:-30")).toEqual({ path: "a.txt", sel: "1-30,-30" });
		expect(splitPathAndSel("a.txt:1-3,:5-6,:-3:raw")).toEqual({ path: "a.txt", sel: "1-3,5-6,-3:raw" });
		expect(splitPathAndSel("a.txt:raw:1-3,:-3")).toEqual({ path: "a.txt", sel: "raw:1-3,-3" });
		expect(splitPathAndSel("a.txt:1-30,:-30", { foldListColons: false })).toEqual({
			path: "a.txt:1-30,",
			sel: "-30",
		});
		const linesSpec = () => ({ selectors: "lines" as const });
		expect(splitInternalUrlSel("artifact://7:1-3,:-3:raw", linesSpec)).toEqual({
			path: "artifact://7",
			sel: "1-3,-3:raw",
		});
	});

	it("handles long lists in one pass", () => {
		const list = `1${",:1".repeat(6400)}`;
		expect(splitPathAndSel(`a.txt:${list}`).path).toBe("a.txt");
		expect(splitPathAndSel(`a.txt:${list}x`)).toEqual({ path: `a.txt:${list}x` });
	});
});

describe("read tool head+tail selectors", () => {
	let testDir: string;
	let filePath: string;
	let unregisterArtifactsDir: (() => void) | undefined;
	let tool: ReadTool;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-head-tail-"));
		filePath = path.join(testDir, "data.txt");
		await Bun.write(filePath, rows(200));
		const artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		await Bun.write(path.join(artifactDir, "7.bash.log"), rows(200));
		resetRegisteredArtifactDirsForTests();
		unregisterArtifactsDir = registerArtifactsDir(artifactDir);
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(async () => {
		unregisterArtifactsDir?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	for (const selector of ["1-3,-3", "1-3,:-3", "1-3,:-3:raw", "raw:1-3,:-3"]) {
		it(`reads the first and last lines of a file for :${selector}`, async () => {
			const output = getTextOutput(await tool.execute("head-tail", { path: `${filePath}:${selector}` }));

			expect(output).not.toContain("interpreted as 2 paths");
			for (const line of [1, 2, 3, 198, 199, 200]) expect(output).toContain(`row-${line}.`);
		});
	}

	for (const selector of ["1-12,-15", "1-12,:-15:raw"]) {
		it(`reads the first and last lines of an artifact for :${selector}`, async () => {
			const output = getTextOutput(await tool.execute("head-tail-artifact", { path: `artifact://7:${selector}` }));

			for (const line of [1, 12, 186, 200]) expect(output).toContain(`row-${line}.`);
			expect(output).not.toContain("row-100.");
		});
	}

	it("reads the tail of an existing file named like the list's head", async () => {
		await Bun.write(`${filePath}:1-3,`, "literal-1.\nliteral-2.\nliteral-3.\n");
		const output = getTextOutput(await tool.execute("literal-base", { path: `${filePath}:1-3,:-1` }));

		expect(output).toContain("literal-3.");
		expect(output).not.toContain("row-1.");
	});
});
