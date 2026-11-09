import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ShellFsFileType } from "@oh-my-pi/pi-natives";
import * as capability from "../../src/capability";
import type { CapabilityResult } from "../../src/capability/types";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { joinUrlPath } from "../../src/internal-urls/url-filesystem";
import * as fileTransfer from "../../src/ssh/file-transfer";
import type { ToolSession } from "../../src/tools";
import { GrepTool } from "../../src/tools/grep";
import { fakeSshTransport } from "../helpers/fake-ssh-transport";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

// The fake remote is the local filesystem behind a POSIX shell.
describe.skipIf(process.platform === "win32")("grep ssh:// directory scopes", () => {
	let fixture: string;
	let root: string;
	let tool: GrepTool;
	const unusual = "line\nbreak #?%.txt";

	beforeEach(async () => {
		fixture = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-grep-"));
		root = `ssh://fixture${fixture}`;
		await Bun.write(path.join(fixture, "a.txt"), "NEEDLE direct\n");
		await Bun.write(path.join(fixture, "sub", "b.txt"), "NEEDLE nested\n");
		await Bun.write(path.join(fixture, "two words.txt"), "NEEDLE spaced\n");
		await Bun.write(path.join(fixture, unusual), "NEEDLE unusual\n");
		await Bun.write(path.join(fixture, ".hidden.txt"), "NEEDLE hidden\n");
		await Bun.write(path.join(fixture, "ignored.txt"), "NEEDLE ignored\n");
		await Bun.write(path.join(fixture, ".gitignore"), "ignored.txt\n");
		await fs.symlink(fixture, path.join(fixture, "sub", "loop"));
		await fs.symlink(path.join(fixture, "a.txt"), path.join(fixture, "alias.txt"));
		vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<unknown>);
		fakeSshTransport(() => fixture);
		InternalUrlRouter.resetForTests();
		const session: ToolSession = {
			cwd: fixture,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		};
		tool = new GrepTool(session);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		InternalUrlRouter.resetForTests();
		await fs.rm(fixture, { recursive: true, force: true });
	});

	it("recurses through remote entries with URL identities, ignore rules and no symlink loops", async () => {
		const result = await tool.execute("remote-dir", { pattern: "NEEDLE", path: `${root}/` });
		expect(result.details?.files?.toSorted()).toEqual(
			[
				joinUrlPath(root, ".hidden.txt"),
				joinUrlPath(root, "a.txt"),
				joinUrlPath(root, unusual),
				joinUrlPath(root, "sub/b.txt"),
				joinUrlPath(root, "two words.txt"),
			].toSorted(),
		);
		expect(textOf(result)).toContain("NEEDLE nested");
		expect(textOf(result)).not.toContain("NEEDLE ignored");
	});

	it("applies direct-child glob scopes without including nested or ignored files", async () => {
		const result = await tool.execute("remote-direct", { pattern: "NEEDLE", path: `${root}/*.txt` });
		expect(result.details?.files).toContain(joinUrlPath(root, "a.txt"));
		expect(result.details?.files).not.toContain(joinUrlPath(root, "sub/b.txt"));
		expect(result.details?.files).not.toContain(joinUrlPath(root, "ignored.txt"));
		const withoutIgnores = await tool.execute("remote-no-ignore", {
			pattern: "NEEDLE",
			path: root,
			gitignore: false,
		});
		expect(withoutIgnores.details?.files).toContain(joinUrlPath(root, "ignored.txt"));
	});

	it("keeps explicit file scopes searchable and refuses oversized remote files", async () => {
		const result = await tool.execute("remote-file", { pattern: "NEEDLE", path: `${root}/a.txt` });
		expect(result.details?.files).toEqual([`${root}/a.txt`]);
		await Bun.write(path.join(fixture, "large.txt"), "x".repeat(1024 * 1024 + 1));
		await expect(tool.execute("remote-large", { pattern: "x", path: `${root}/large.txt` })).rejects.toThrow(/1 MiB/);
	});

	it("surfaces missing and unreadable remote directory errors instead of searching a local path", async () => {
		await expect(tool.execute("remote-missing", { pattern: "NEEDLE", path: `${root}/missing` })).rejects.toThrow(
			/No such file|not found/i,
		);
		vi.spyOn(fileTransfer, "listRemoteDir").mockRejectedValue(new Error("remote directory: Permission denied"));
		await expect(tool.execute("remote-unreadable", { pattern: "NEEDLE", path: root })).rejects.toThrow(
			/Permission denied|PermissionDenied|Input\/output error|I\/O error/i,
		);
	});

	it("never substitutes a local directory when the remote namespace exists only through the transport", async () => {
		const remote = `ssh://fixture/not-local-${crypto.randomUUID()}`;
		vi.spyOn(fileTransfer, "statRemotePath").mockImplementation(async (_target, remotePath) => {
			if (remotePath === remote.slice("ssh://fixture".length)) return "directory";
			if (remotePath.endsWith("/only.txt")) return "file";
			return "missing";
		});
		vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([{ name: "only.txt", fileType: ShellFsFileType.File }]);
		vi.spyOn(fileTransfer, "readRemoteFile").mockImplementation(async (_target, remotePath) => {
			if (!remotePath.endsWith("/only.txt")) throw new Error("No such remote file");
			return { bytes: new TextEncoder().encode("NEEDLE virtual remote\n"), truncated: false };
		});
		const result = await tool.execute("remote-only", { pattern: "NEEDLE", path: remote });
		expect(result.details?.files).toEqual([`${remote}/only.txt`]);
	});

	it("propagates a remote directory transport failure", async () => {
		vi.spyOn(fileTransfer, "listRemoteDir").mockRejectedValue(new Error("SSH transport disconnected"));
		await expect(tool.execute("remote-disconnected", { pattern: "NEEDLE", path: root })).rejects.toThrow(
			/SSH transport disconnected|Input\/output error|I\/O error/i,
		);
	});

	it("cancels directory traversal through the caller's signal", async () => {
		const controller = new AbortController();
		vi.spyOn(fileTransfer, "listRemoteDir").mockImplementation(async (_target, _remotePath, options) => {
			controller.abort(new Error("remote directory cancelled"));
			expect(options?.signal?.aborted).toBe(true);
			options?.signal?.throwIfAborted();
			throw new Error("missing cancellation signal");
		});
		await expect(tool.execute("remote-cancel", { pattern: "NEEDLE", path: root }, controller.signal)).rejects.toThrow(
			/cancel|abort/i,
		);
	});
});
