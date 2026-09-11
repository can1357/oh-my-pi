import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

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

describe("read tool directory listings honor line selectors (regression: was silently dropping offset)", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-dir-range-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		for (let i = 1; i <= 60; i++) {
			fs.writeFileSync(path.join(testDir, `file-${String(i).padStart(3, "0")}.txt`), "");
		}
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("returns the full listing when no selector is given", async () => {
		const result = await tool.execute("call-bare", { path: testDir });
		const output = getTextOutput(result);

		expect(result.details?.isDirectory).toBe(true);
		expect(output).toContain("file-001.txt");
		expect(output).toContain("file-060.txt");
	});

	it("returns a slice of the listing for `:start-end`", async () => {
		const result = await tool.execute("call-range", { path: `${testDir}:30-40` });
		const output = getTextOutput(result);
		const lines = output.split("\n").filter(line => line.includes("file-"));

		// 11-line window (30..40 inclusive) — every line in the slice must be a file row.
		expect(lines.length).toBeLessThanOrEqual(11);
		// "Use :N to continue" pagination hint when more entries remain.
		expect(output).toContain("more lines in listing");
		expect(output).toContain("Use :41 to continue");
	});

	it("returns from offset to end for `:start`", async () => {
		const result = await tool.execute("call-offset", { path: `${testDir}:30` });
		const output = getTextOutput(result);
		const lines = output.split("\n").filter(line => line.includes("file-"));

		// 60 files + a header line; offset 30 leaves roughly 31 trailing lines.
		expect(lines.length).toBeGreaterThan(10);
		// No "continue" footer when we reach EOF.
		expect(output).not.toContain("Use :");
	});

	it("returns the last N listing lines for `:-N`", async () => {
		const full = getTextOutput(await tool.execute("call-full", { path: testDir })).split("\n");
		const output = getTextOutput(await tool.execute("call-tail", { path: `${testDir}:-5` }));

		expect(output.split("\n")).toEqual(full.slice(-5));
		expect(output).not.toContain("Use :");
	});

	it("emits a clear `beyond end` notice instead of returning an empty body", async () => {
		const result = await tool.execute("call-beyond", { path: `${testDir}:9999` });
		const output = getTextOutput(result);

		expect(output).toMatch(/Line 9999 is beyond end of listing/);
		expect(output).toMatch(/lines total/);
	});
});
