import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const BRIDGE_CONTENT = "// content from editor buffer\nexport function greet() { return 'bridge'; }\n";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string, bridge?: ClientBridge): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: bridge ? () => bridge : undefined,
	};
}

describe("read tool ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-acp-fs-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("routes plain text reads through the bridge and does not call Bun.file().text()", async () => {
		// .ts file so summarize would normally run (read.summarize.enabled defaults to true)
		const filePath = path.join(tmpDir, "example.ts");
		await fs.writeFile(filePath, "export function greet() { return 'disk'; }\n");

		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => BRIDGE_CONTENT,
		};
		const bridgeSpy = spyOn(bridge, "readTextFile");

		// Wrap Bun.file() to detect any .text() calls
		let textCallCount = 0;
		const origBunFile = Bun.file.bind(Bun);
		const bunFileSpy = spyOn(Bun, "file").mockImplementation(
			(arg: string | URL | Uint8Array | ArrayBufferLike | number, opts?: BlobPropertyBag) => {
				const bunFile = origBunFile(arg as string, opts);
				const origText = bunFile.text.bind(bunFile);
				bunFile.text = async () => {
					textCallCount++;
					return origText();
				};
				return bunFile;
			},
		);

		try {
			const session = createSession(tmpDir, bridge);
			const tool = new ReadTool(session);

			const result = await tool.execute("call-1", { path: filePath });
			const text = textOutput(result);

			// Bridge content should appear in output
			expect(text).toContain("content from editor buffer");
			// Bridge readTextFile was invoked
			expect(bridgeSpy).toHaveBeenCalled();
			// Bun.file().text() must not have been called — bridge is source of truth
			expect(textCallCount).toBe(0);
		} finally {
			bunFileSpy.mockRestore();
		}
	});

	it("applies requested line ranges to bridge content exactly once", async () => {
		const filePath = path.join(tmpDir, "range.txt");
		await fs.writeFile(filePath, "disk one\ndisk two\ndisk three\n");
		const bridgeContent = "bridge one\nbridge two\nbridge three\n";
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async params => {
				if (typeof params.line !== "number") return bridgeContent;
				const lines = bridgeContent.split("\n");
				const start = Math.max(0, params.line - 1);
				return lines.slice(start, params.limit === undefined ? undefined : start + params.limit).join("\n");
			},
		};

		const session = createSession(tmpDir, bridge);
		const tool = new ReadTool(session);

		const result = await tool.execute("call-range", { path: `${filePath}:2+1` });
		const text = textOutput(result);

		expect(text).toContain("bridge two");
		expect(text).not.toContain("Line 2 is beyond end");
		expect(text).not.toContain("disk two");
	});

	it("reports the bridge-buffer oversized-line preview as partial with matching stats", async () => {
		// Regression #10774: the ACP/editor-backed route renders the
		// in-memory byte-capped preview, so its stats must describe the
		// delivered snippet instead of outputLines=0/outputBytes=0 and
		// lastLinePartial=false.
		const filePath = path.join(tmpDir, "oversized-bridge.txt");
		const bigLine = "x".repeat(70_000);
		const bridgeContent = `first\n${bigLine}\nlast`;
		await fs.writeFile(filePath, "first\ndisk oversized line\nlast\n");
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => bridgeContent,
		};
		const bridgeSpy = spyOn(bridge, "readTextFile");

		const session = createSession(tmpDir, bridge);
		const tool = new ReadTool(session);

		const result = await tool.execute("call-oversized-bridge", { path: `${filePath}:raw:2-2` });
		const body = textOutput(result);

		expect(bridgeSpy).toHaveBeenCalled();
		expect(body).toBe(bigLine.slice(0, DEFAULT_MAX_BYTES));
		expect(result.details?.displayContent?.text).toBe(bigLine.slice(0, DEFAULT_MAX_BYTES));
		const truncation = result.details?.truncation;
		expect(truncation).toBeDefined();
		if (!truncation) throw new Error("expected truncation details");
		expect(truncation.firstLineExceedsLimit).toBe(true);
		expect(truncation.lastLinePartial).toBe(true);
		expect(truncation.outputLines).toBe(1);
		expect(truncation.outputBytes).toBe(DEFAULT_MAX_BYTES);
		expect(truncation.totalBytes).toBe(70_000);
	});
});
