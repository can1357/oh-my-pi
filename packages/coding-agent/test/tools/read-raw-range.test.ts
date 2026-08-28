import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
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
});
