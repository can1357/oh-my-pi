import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { ShellFsFileType } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as capability from "../../src/capability";
import type { CapabilityResult } from "../../src/capability/types";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import * as fileTransfer from "../../src/ssh/file-transfer";
import { ReadTool } from "../../src/tools/read";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("JSON selectors over SSH resources", () => {
	let tool: ReadTool;

	beforeEach(() => {
		const hosts: CapabilityResult<unknown> = { items: [], all: [], warnings: [], providers: [] };
		vi.spyOn(capability, "loadCapability").mockResolvedValue(hosts);
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		const session: ToolSession = {
			cwd: os.tmpdir(),
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		tool = new ReadTool(session);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("queries a bounded remote JSON file locally, preserving paging and URI identity", async () => {
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode('{"ok":true,"items":[1,2,3]}'),
			truncated: false,
		});
		const uri = "ssh://HOST/tmp/query.json?q=.items&compact=true&limit=2";
		const result = await tool.execute("ssh-array", { path: uri });
		expect(textOf(result)).toBe("[1,2]\n[1 more items; append ?q=.items&compact=true&limit=2&offset=2 to continue]");
		expect(result.details?.meta?.source).toEqual({ type: "internal", value: uri });
		expect(result.details?.resolvedPath).toBeUndefined();
		expect(read.mock.calls[0]?.[1]).toBe("/tmp/query.json");
		expect(read.mock.calls[0]?.[2].maxBytes).toBe(1024 * 1024);
	});

	it("supports raw JSONL paging, modifier-only selectors, and query-output line selectors", async () => {
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode('"first"\n"second"\n"third"\n'),
			truncated: false,
		});
		expect(textOf(await tool.execute("ssh-raw", { path: "ssh://HOST/tmp/a.jsonl?raw=true&limit=2" }))).toBe(
			"first\nsecond\n[more results; append ?q=.&raw=true&limit=2&offset=2 to continue]",
		);
		const result = await tool.execute("ssh-lines", { path: "ssh://HOST/tmp/a.jsonl?q=.&raw=true:raw:2-2" });
		expect(textOf(result)).toContain("second");
		expect(textOf(result)).not.toContain("first");
		expect(textOf(result)).not.toContain("third");
		expect(JSON.stringify(result)).not.toContain("omp-read-json-");
	});

	it("decodes literal %3F in a remote filename without passing filter text to SSH", async () => {
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode('{"n":7}'),
			truncated: false,
		});
		const result = await tool.execute("ssh-literal", {
			path: "ssh://HOST/tmp/a%3Fdraft.json?q=.n % 3 + 1",
		});
		expect(textOf(result)).toBe("2");
		expect(read.mock.calls[0]?.[1]).toBe("/tmp/a?draft.json");
	});

	it("leaves unsupported query strings and URL fragments to the SSH protocol contract", async () => {
		const read = vi.spyOn(fileTransfer, "readRemoteFile");
		for (const suffix of ["?download=1", "?q=.ok&download=1"]) {
			await expect(tool.execute("ssh-unknown", { path: `ssh://HOST/tmp/a.json${suffix}` })).rejects.toThrow(
				/does not support URL query strings/,
			);
		}
		await expect(tool.execute("ssh-fragment", { path: "ssh://HOST/tmp/a.json?q=.ok#draft" })).rejects.toThrow(
			/does not support URL (query strings|fragments)/,
		);
		expect(read).not.toHaveBeenCalled();
	});

	it("preserves the 1 MiB remote read ceiling and original SSH failures", async () => {
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("partial"),
			truncated: true,
		});
		await expect(tool.execute("ssh-too-big", { path: "ssh://HOST/tmp/a.json?q=." })).rejects.toThrow(
			/exceeds the 1 MiB limit/,
		);
		read.mockRejectedValue(new Error("SSH fixture: permission denied"));
		await expect(tool.execute("ssh-denied", { path: "ssh://HOST/tmp/a.json?q=." })).rejects.toThrow(
			/SSH fixture: permission denied/,
		);
	});

	it("reports invalid remote JSON without leaking an owned scratch path", async () => {
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode('{"ok":'),
			truncated: false,
		});
		await using scratch = await TempDir.create("@omp-json-error-test-");
		vi.spyOn(TempDir, "create").mockResolvedValue(scratch);
		await expect(tool.execute("ssh-invalid-json", { path: "ssh://HOST/tmp/a.json?q=." })).rejects.toThrow(
			/Failed to execute JSON query:.*failed to parse/i,
		);
		await expect(fs.stat(scratch.path())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects JSON selectors on remote directories instead of parsing their listings", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([{ name: "a.json", fileType: ShellFsFileType.File }]);
		const read = vi.spyOn(fileTransfer, "readRemoteFile");
		await expect(tool.execute("ssh-directory", { path: "ssh://HOST/tmp/?q=." })).rejects.toThrow(
			/regular SSH file, not a directory/,
		);
		expect(read).not.toHaveBeenCalled();
	});

	it("removes owned query scratch after cancellation during staging", async () => {
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode('{"ok":true}'),
			truncated: false,
		});
		const paths: string[] = [];
		const create = TempDir.create;
		const controller = new AbortController();
		vi.spyOn(TempDir, "create").mockImplementation(async prefix => {
			const dir = await create(prefix);
			paths.push(dir.path());
			controller.abort();
			return dir;
		});
		const result = tool.execute("ssh-cancel", { path: "ssh://HOST/tmp/a.json?q=." }, controller.signal);
		await expect(result).rejects.toThrow(/abort/i);
		expect(paths).toHaveLength(1);
		for (const scratch of paths) await expect(fs.stat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
