import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated({ "read.summarize.enabled": false });
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifacts", "artifact-1.log") }),
		settings,
	};
}

const tmpDirs: string[] = [];
afterAll(async () => {
	for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true });
});

// The page's leading context is optional; a file line larger than the byte
// budget there must not abort the whole window and hide the requested lines.
describe("read keeps requested lines when leading context exceeds the byte budget", () => {
	it("hashline mode returns the requested line, not just the oversized-context notice", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-leading-context-"));
		tmpDirs.push(dir);
		const file = path.join(dir, "minified.js");
		await fs.writeFile(file, `${"X".repeat(60_000)}\nwanted-line-2\nwanted-line-3\n`);
		const tool = new ReadTool(createSession(dir));
		for (const selector of ["2", "2-3"]) {
			const text = textOutput(await tool.execute("call", { path: `${file}:${selector}` }));
			expect(text).toContain("wanted-line-2");
		}
	});

	it("line-number mode returns the requested line, not a 50 KB preview of the context line", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-leading-context-plain-"));
		tmpDirs.push(dir);
		const file = path.join(dir, "minified.js");
		await fs.writeFile(file, `${"X".repeat(60_000)}\nwanted-line-2\nwanted-line-3\n`);
		const tool = new ReadTool({
			...createSession(dir),
			settings: Settings.isolated({
				"edit.mode": "replace",
				readLineNumbers: true,
				"read.summarize.enabled": false,
			}),
		});
		const text = textOutput(await tool.execute("call", { path: `${file}:2` }));
		expect(text).toContain("wanted-line-2");
	});
});
