import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
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

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

// Only the deterministic, fast disk reads — plain file line/range reads and
// directory listings — are non-abortable: a turn interrupt that fires mid-read
// must not surface "Operation aborted" on a read that would have completed
// instantly. Non-deterministic reads (archive, sqlite, document conversion,
// image decode, structural summary, conflict scan) stay cancellable.
describe("plain-file and directory reads ignore an already-aborted signal", () => {
	let testDir: string;
	let tool: ReadTool;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-fs-noabort-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		tool = new ReadTool(makeSession(testDir));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("returns a plain-file line range with an aborted signal", async () => {
		const filePath = path.join(testDir, "range.txt");
		fs.writeFileSync(filePath, Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n"));

		const result = await tool.execute("call-range", { path: `${filePath}:20-22` }, abortedSignal());
		const output = getTextOutput(result);

		expect(result.isError).toBeFalsy();
		expect(output).toContain("line-20");
		expect(output).toContain("line-22");
	});

	it("returns a multi-range plain-file read with an aborted signal", async () => {
		const filePath = path.join(testDir, "multi.txt");
		fs.writeFileSync(filePath, Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n"));

		const result = await tool.execute("call-multi", { path: `${filePath}:2-3,30-31` }, abortedSignal());
		const output = getTextOutput(result);

		expect(result.isError).toBeFalsy();
		expect(output).toContain("line-2");
		expect(output).toContain("line-30");
	});

	it("returns a directory listing with an aborted signal", async () => {
		for (let i = 1; i <= 5; i++) {
			fs.writeFileSync(path.join(testDir, `f-${i}.txt`), "");
		}

		const result = await tool.execute("call-dir", { path: testDir }, abortedSignal());
		const output = getTextOutput(result);

		expect(result.isError).toBeFalsy();
		expect(result.details?.isDirectory).toBe(true);
		expect(output).toContain("f-1.txt");
		expect(output).toContain("f-5.txt");
	});

	// Boundary: non-deterministic reads must remain cancellable. The conflict
	// scan honors the abort signal, so an already-aborted read still fails fast
	// instead of being forced to run to completion like a plain file read.
	it("still aborts a non-plain read (`:conflicts`) when the signal is aborted", async () => {
		const filePath = path.join(testDir, "conflicted.txt");
		fs.writeFileSync(filePath, "hello\nworld\n");

		await expect(
			tool.execute("call-conflicts", { path: `${filePath}:conflicts` }, abortedSignal()),
		).rejects.toBeInstanceOf(ToolAbortError);
	});
});
