import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

// Minimal ToolSession stub (block-images.test.ts shape). Approval functions are
// pure over their args, and the write-execute selector reject throws before any
// session/SSH access, so no real cwd/fs is needed.
function createTestToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function callApproval(tool: { approval?: unknown }, args: unknown): string {
	const approval = tool.approval;
	if (typeof approval !== "function") throw new Error("expected a dynamic approval function");
	return approval(args) as string;
}

describe("ssh:// tools require exec-tier approval", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("read: ssh:// targets are exec, local paths stay read", () => {
		const tool = new ReadTool(createTestToolSession(os.tmpdir()));
		expect(callApproval(tool, { path: "ssh://icaro/etc/hostname" })).toBe("exec");
		expect(callApproval(tool, { path: "/etc/hostname" })).toBe("read");
		expect(callApproval(tool, { path: "local://notes" })).toBe("read");
		expect(callApproval(tool, {})).toBe("read");
	});

	it("grep: an ssh:// entry flattened into a delimited path still trips exec", () => {
		const tool = new GrepTool(createTestToolSession(os.tmpdir()));
		// The delimited string is one entry at approval time (expansion happens
		// later), so an anchored check would miss it — the substring scan must not.
		expect(callApproval(tool, { paths: "src,ssh://icaro/etc/hosts" })).toBe("exec");
		expect(callApproval(tool, { paths: ["src", "ssh://icaro/etc/hosts"] })).toBe("exec");
		expect(callApproval(tool, { paths: ["src", "lib"] })).toBe("read");
		expect(callApproval(tool, { paths: "src" })).toBe("read");
		expect(callApproval(tool, {})).toBe("read");
	});

	it("write: ssh:// is exec even when wrapped in a hashline header", () => {
		const tool = new WriteTool(createTestToolSession(os.tmpdir()));
		expect(callApproval(tool, { path: "ssh://icaro/tmp/x" })).toBe("exec");
		// A pasted `[path#TAG]` wrapper must not let an ssh write dodge the exec tier.
		expect(callApproval(tool, { path: "[ssh://icaro/tmp/x#ABCD]" })).toBe("exec");
		expect(callApproval(tool, { path: "/tmp/local-file.txt" })).toBe("write");
	});
});

describe("write rejects ssh:// line-range/malformed selectors before connecting", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("execute throws on a line-range or malformed selector without any SSH op", async () => {
		const tool = new WriteTool(createTestToolSession(os.tmpdir()));
		await expect(tool.execute("w-range", { path: "ssh://icaro/tmp/f:1-20", content: "x" })).rejects.toThrow(
			/whole file/,
		);
		await expect(tool.execute("w-malformed", { path: "ssh://icaro/tmp/f:-10", content: "x" })).rejects.toThrow(
			/whole file/,
		);
	});
});
