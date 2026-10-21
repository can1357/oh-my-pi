import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const files: Record<string, string> = {};

// Remote-backed like ssh://: the read renders the handler's text in memory, with no backing file.
const remoteHandler: ProtocolHandler = {
	scheme: "remote",
	spec: {
		backing: "remote",
		selectors: "lines",
		immutable: false,
		write: { via: "handler", payload: "text", scope: "workspace", tier: () => "write" },
	},
	resolve: async url => ({ url: url.href, content: files[url.pathname.slice(1)] ?? "", contentType: "text/plain" }),
	write: async () => {},
};

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

// Rows are `N:` in hashline mode and `N|` with plain line numbers (`PI_EDIT_VARIANT` picks the mode).
function shownLines(output: string): number[] {
	return [...output.matchAll(/^(\d+)[:|]/gm)].map(match => Number(match[1]));
}

describe("in-memory range reads keep the requested lines", () => {
	let tmpDir: string;
	let read: (target: string) => Promise<string>;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-in-memory-range-"));
		InternalUrlRouter.resetForTests();
		InternalUrlRouter.instance().register(remoteHandler);
		const session: ToolSession = {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(tmpDir, "artifact-1.log") }),
			settings: Settings.isolated({ readLineNumbers: true }),
			enableLsp: false,
		};
		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		read = async target => textOutput(await tool.execute("read", { path: target }));
	});

	afterEach(async () => {
		InternalUrlRouter.resetForTests();
		await removeWithRetries(tmpDir);
	});

	it("drops a leading context line that would push the requested start past the byte budget", async () => {
		files["six.txt"] = ["l1", "l2", "A".repeat(30_000), "B".repeat(30_000), "C".repeat(30_000), "l6", ""].join("\n");

		const output = await read("remote://host/six.txt:4-6");

		expect(shownLines(output)).toEqual([4]);
		expect(output).not.toContain("AAAA");
		// The continuation moves past the requested start instead of re-reading it.
		expect(output).toContain("[Showing lines 4-4 of 6 (50.0KB limit). Use :5 to continue]");
	});

	it("drops a leading context line that alone exceeds the byte budget", async () => {
		files["wide-context.txt"] = ["l1", "A".repeat(60_000), "wanted-3", "wanted-4", ""].join("\n");

		const output = await read("remote://host/wide-context.txt:3-4");

		expect(shownLines(output)).toEqual([3, 4]);
		expect(output).not.toContain("Line 2 is");
	});

	it("keeps the leading context line when the requested start still fits", async () => {
		files["fits.txt"] = ["l1", "A".repeat(30_000), "wanted-3", "wanted-4", ""].join("\n");

		expect(shownLines(await read("remote://host/fits.txt:3-4"))).toEqual([2, 3, 4]);
	});

	it("reports the byte budget as the limit of a byte-truncated page", async () => {
		files["rows.txt"] = Array.from({ length: 200 }, (_, index) => `row-${index + 1} ${"x".repeat(1_000)}`).join("\n");

		const output = await read("remote://host/rows.txt:1-200");

		expect(output).toMatch(/\[Showing lines 1-\d+ of 200 \(50\.0KB limit\)\. Use :\d+ to continue\]/);
	});
});
