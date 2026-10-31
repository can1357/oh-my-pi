import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ShellFsFileType, ShellFsOp } from "@oh-my-pi/pi-natives";
import * as capability from "../../src/capability";
import { Settings } from "../../src/config/settings";
import { EditTool, getEditStore } from "../../src/edit";
import * as autoRepair from "../../src/edit/auto-repair";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { InternalUrlFilesystem } from "../../src/internal-urls/url-filesystem";
import { createLspWritethrough, flushLspWritethroughBatch } from "../../src/lsp";
import * as lspConfig from "../../src/lsp/config";
import type { LinterClient, ServerConfig } from "../../src/lsp/types";
import type { ToolSession } from "../../src/tools";
import { ReadTool } from "../../src/tools/read";
import { GrepTool } from "../../src/tools/grep";
import * as fileTransfer from "../../src/ssh/file-transfer";

const URL = "ssh://oracle/tmp/edit-repro.txt";
let remoteText: string;
let session: ToolSession;
let readRemote: Mock<typeof fileTransfer.readRemoteFile>;
let writeRemote: Mock<typeof fileTransfer.writeRemoteFile>;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function headerOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const header = textOf(result).match(/^\[[a-z][a-z0-9+.-]*:\/\/[^\n]+#[0-9A-Fa-f]{4}\]/m)?.[0];
	expect(header).toBeDefined();
	return header!;
}

beforeEach(() => {
	remoteText = "alpha\nbeta\ngamma\n";
	session = {
		cwd: os.tmpdir(),
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "edit.mode": "hashline" }),
	};
	vi.spyOn(capability, "loadCapability").mockResolvedValue({ items: [], all: [], warnings: [], providers: [] });
	vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
	readRemote = vi.spyOn(fileTransfer, "readRemoteFile").mockImplementation(async () => ({
		bytes: new TextEncoder().encode(remoteText),
		truncated: false,
	}));
	writeRemote = vi.spyOn(fileTransfer, "writeRemoteFile").mockImplementation(async (_target, _path, bytes) => {
		remoteText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
	});
});

afterEach(() => vi.restoreAllMocks());

describe("SSH read/edit snapshots (#12125)", () => {
	it("edits a declared content-backed scheme without an SSH-specific route", async () => {
		remoteText = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		const original = remoteText;
		const router = InternalUrlRouter.instance();
		const url = "testremote://account/notes.txt";
		const resolve = vi.fn(async () => ({ url, content: remoteText, contentType: "text/plain" as const }));
		const write = vi.fn(async (_url: unknown, content: string) => {
			remoteText = content;
		});
		router.register({
			scheme: "testremote",
			spec: {
				backing: "remote",
				selectors: "lines",
				immutable: false,
				editVia: "content",
				write: { via: "handler", payload: "text", scope: "workspace", tier: () => "exec" },
			},
			resolve,
			write,
		});
		try {
			const read = new ReadTool(session);
			const before = await read.execute("read-other-scheme", { path: `${url}:10-10,60-60` });
			const header = headerOf(before);
			const edit = new EditTool(session, "hashline");
			const params = { input: `${header}\nPUT 40.=40:\n+BETA` };
			const unseen = await edit.execute("unseen-other-scheme", params);
			expect(unseen.isError).toBe(true);
			expect(remoteText).toBe(original);
			const raw = await read.execute("raw-other-scheme", { path: `${url}:raw:40-40` });
			expect(textOf(raw)).toBe("line 40");
			const edited = await edit.execute("edit-other-scheme", params);
			expect(edited.isError, textOf(edited)).not.toBe(true);
			expect(remoteText).toBe(original.replace("line 40\n", "BETA\n"));
			expect(fileTransfer.readRemoteFile).not.toHaveBeenCalled();
			expect(fileTransfer.writeRemoteFile).not.toHaveBeenCalled();
		} finally {
			router.unregister("testremote");
		}
	});

	it("edits the selected SSH line, preserving external changes and refreshing its snapshot", async () => {
		const url = "ssh://user@[::1]:2222/tmp/edit%20repro%23draft%3A2.txt";
		const read = new ReadTool(session);
		const before = await read.execute("read", { path: url });
		const header = headerOf(before);
		remoteText = "delta\nbeta\ngamma\n";
		const edited = await new EditTool(session, "hashline").execute("edit", {
			input: `${header}\nPUT 2.=2:\n+BETA`,
		});
		expect(edited.isError, textOf(edited)).not.toBe(true);
		expect(remoteText).toBe("delta\nBETA\ngamma\n");
		expect(readRemote.mock.calls.at(-1)?.[1]).toBe("/tmp/edit repro#draft:2.txt");
		expect(writeRemote.mock.calls[0]?.[1]).toBe("/tmp/edit repro#draft:2.txt");
		const after = await read.execute("read-after", { path: url });
		expect(headerOf(after)).not.toBe(header);
		expect(textOf(after)).toContain("2:BETA");
	});

	it("edits a HOME-relative SSH file at the remote account's path with the regular-file guard", async () => {
		vi.spyOn(fileTransfer, "remoteHomeDirectory").mockResolvedValue("/home/remote");
		const url = "ssh://oracle/~/notes.txt";
		const before = await new ReadTool(session).execute("read-home", { path: url });
		const edited = await new EditTool(session, "hashline").execute("edit-home", {
			input: `${headerOf(before)}\nPUT 2.=2:\n+BETA`,
		});
		expect(edited.isError, textOf(edited)).not.toBe(true);
		expect(remoteText).toBe("alpha\nBETA\ngamma\n");
		expect(readRemote.mock.calls.at(-1)?.[1]).toBe("/home/remote/notes.txt");
		expect(writeRemote.mock.calls[0]?.[1]).toBe("/home/remote/notes.txt");
		expect(writeRemote.mock.calls[0]?.[3].requireRegularFile).toBe(true);
	});

	it.each([
		["plain", ""],
		["BOM-only", "\uFEFF"],
	])("provides an empty %s file's snapshot and preserves its encoding on append", async (_name, bom) => {
		remoteText = bom;
		const before = await new ReadTool(session).execute("read", { path: URL });
		expect(textOf(before)).toContain("resource is empty");
		const edited = await new EditTool(session, "hashline").execute("edit", {
			input: `${headerOf(before)}\nPUT >$:\n+first line`,
		});
		expect(edited.isError, textOf(edited)).not.toBe(true);
		expect(remoteText).toBe(`${bom}first line`);
	});

	it("records remote syntax regressions and warns without using local auto-repair", async () => {
		await using agentDir = await TempDir.create("@omp-ssh-blackbox-");
		session.settings = await Settings.loadIsolated({
			cwd: session.cwd,
			agentDir: agentDir.path(),
			inMemory: true,
			overrides: { "edit.blackbox.enabled": true },
		});
		const sourceUrl = URL.replace(".txt", ".ts");
		remoteText = "const value = 1;\n";
		const original = remoteText;
		const repair = vi.spyOn(autoRepair, "attemptEditAutoRepair");
		const edited = await new EditTool(session, "replace").execute("edit", {
			path: sourceUrl,
			old_string: "1",
			new_string: "",
		});
		expect(edited.isError, textOf(edited)).not.toBe(true);
		expect(remoteText).toBe("const value = ;\n");
		expect(textOf(edited)).toContain("no longer parses");
		expect(repair).not.toHaveBeenCalled();
		const lines = (await Bun.file(agentDir.join("edit-blackbox.jsonl")).text()).trim().split("\n");
		expect(lines.map(line => JSON.parse(line))).toEqual([
			{
				prev: original,
				new: remoteText,
				model: "unknown",
				variant: "replace",
				arg: { path: sourceUrl, old_string: "1", new_string: "" },
			},
		]);
	});

	it("refuses changed remote anchors without overwriting the external change", async () => {
		const before = await new ReadTool(session).execute("read", { path: URL });
		remoteText = "alpha\nchanged externally\ngamma\n";
		const edited = await new EditTool(session, "hashline").execute("edit", {
			input: `${headerOf(before)}\nPUT 2.=2:\n+BETA`,
		});
		expect(edited.isError).toBe(true);
		expect(remoteText).toBe("alpha\nchanged externally\ngamma\n");
		expect(fileTransfer.writeRemoteFile).not.toHaveBeenCalled();
	});

	it("keeps BOM out of read/search/virtual views and preserves BOM/CRLF on a first-line edit", async () => {
		remoteText = "\uFEFFalpha\r\nbeta\r\n";
		const resource = await InternalUrlRouter.instance().resolve(URL, { cwd: session.cwd });
		expect(resource.content).toBe("alpha\r\nbeta\r\n");
		expect(resource.bom).toBe(true);
		const filesystem = new InternalUrlFilesystem({ context: { cwd: session.cwd }, tier: "exec" });
		const opened = await filesystem.handle({
			op: ShellFsOp.Open,
			path: URL,
			open: { read: true, write: false, append: false, truncate: false, create: false, createNew: false },
		});
		expect(opened.error).toBeUndefined();
		try {
			const viewed = await filesystem.handle({
				op: ShellFsOp.Read,
				handle: opened.handle,
				offset: 0n,
				length: 1024,
			});
			expect(viewed.data).toEqual(new TextEncoder().encode("alpha\r\nbeta\r\n"));
		} finally {
			await filesystem.handle({ op: ShellFsOp.Close, handle: opened.handle });
		}
		const matches = await new GrepTool(session).execute("grep-bom", { path: URL, pattern: "^alpha" });
		expect(matches.details?.files).toContain(URL);
		const read = new ReadTool(session);
		const raw = await read.execute("raw", { path: `${URL}:raw` });
		expect(textOf(raw)).toBe("alpha\r\nbeta\r\n");
		const before = await read.execute("read", { path: URL });
		expect(textOf(before)).toContain("\n1:alpha");
		expect(textOf(before)).not.toContain("\uFEFF");
		const edited = await new EditTool(session, "hashline").execute("edit", {
			input: `${headerOf(before)}\nPUT 1.=1:\n+ALPHA`,
		});
		expect(edited.isError, textOf(edited)).not.toBe(true);
		expect(remoteText).toBe("\uFEFFALPHA\r\nbeta\r\n");
	});

	it.each([
		["replace", "apply"],
		["patch", "apply"],
		["apply_patch", "apply"],
		["sloppy", "apply"],
		["hashline", "apply"],
		["hashline", "cancel"],
	] as const)("keeps %s previews offline before %s", async (mode, action) => {
		const localDir = mode === "apply_patch" ? TempDir.createSync("@pi-ssh-preview-batch-") : undefined;
		const localPath = localDir ? path.join(localDir.path(), "local.txt") : undefined;
		if (localPath) await Bun.write(localPath, "before\n");
		const tool = new EditTool(session, mode);
		const header =
			mode === "hashline" ? `[${URL}#${getEditStore(session).recordSnapshot(URL, remoteText, [1, 2, 3])}]` : "";
		const params =
			mode === "replace"
				? { path: URL, old_string: "beta", new_string: "BETA" }
				: mode === "hashline"
					? {
							input: `${header}\nPUT 2.=2:\n+BETA`,
						}
					: mode === "patch"
						? {
								path: URL,
								edits: [{ op: "update" as const, diff: "@@ -2,1 +2,1 @@\n-beta\n+BETA" }],
							}
						: {
								input:
									mode === "apply_patch"
										? `*** Begin Patch\n*** Update File: ${URL}\n@@\n-beta\n+BETA\n*** Update File: ${localPath}\n@@\n-before\n+after\n*** End Patch`
										: `*** Edit File: ${URL}\n*** Find\nbeta\n*** Replace\nBETA\n`,
							};
		const preview = Promise.withResolvers<void>();
		const previewErrors: string[] = [];
		const stream = tool.openArgStream({
			toolCallId: "stream",
			toolName: "edit",
			emit: update => {
				if (update && typeof update === "object" && "streaming" in update && update.streaming === false) {
					if ("files" in update && Array.isArray(update.files)) {
						for (const file of update.files) if (file.error) previewErrors.push(file.error);
					}
					preview.resolve();
				}
			},
		});
		try {
			stream.push(JSON.stringify(params));
			stream.end(params);
			await preview.promise;
			expect(fileTransfer.statRemotePath).not.toHaveBeenCalled();
			expect(readRemote).not.toHaveBeenCalled();
			expect(writeRemote).not.toHaveBeenCalled();
			expect(previewErrors).toEqual([]);
			if (action === "cancel") return; // Exercise cancellation in finally.
			remoteText = "delta\nbeta\ngamma\n";
			const signal = new AbortController().signal;
			const edited = await tool.execute("stream", params, signal);
			expect(edited.isError, textOf(edited)).not.toBe(true);
			expect(remoteText).toBe("delta\nBETA\ngamma\n");
			if (localPath) expect(await Bun.file(localPath).text()).toBe("after\n");
			expect(readRemote.mock.calls.at(-1)?.[2].signal).toBe(signal);
			expect(writeRemote.mock.calls[0]?.[3].signal).toBe(signal);
			if (mode === "hashline") {
				const after = await new ReadTool(session).execute("read-after-preview", { path: URL });
				expect(headerOf(after)).not.toBe(header);
				expect(textOf(after)).toContain("2:BETA");
			}
		} finally {
			stream.cancel();
			localDir?.removeSync();
		}
	});

	it("keeps the original snapshot usable when SSH persistence fails", async () => {
		const before = await new ReadTool(session).execute("read", { path: URL });
		writeRemote.mockRejectedValueOnce(new Error("Permission denied"));
		const tool = new EditTool(session, "hashline");
		const args = { input: `${headerOf(before)}\nPUT 2.=2:\n+BETA` };
		const failed = await tool.execute("failed-write", args);
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("Permission denied");
		expect(remoteText).toBe("alpha\nbeta\ngamma\n");
		const retry = await tool.execute("retry", args);
		expect(retry.isError, textOf(retry)).not.toBe(true);
		expect(remoteText).toBe("alpha\nBETA\ngamma\n");
	});

	it("flushes earlier local formatting when an SSH edit finishes the batch", async () => {
		const tempDir = TempDir.createSync("@omp-ssh-edit-batch-");
		session.cwd = tempDir.path();
		const localPath = path.join(session.cwd, "local.ts");
		const batchId = `ssh-final-${crypto.randomUUID()}`;
		const formatter: ServerConfig = {
			command: "test-formatter",
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: () =>
				({
					format: async (_filePath, content) => content.replace("=1", " = 1;"),
					lint: async () => [],
				}) satisfies LinterClient,
		};
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["formatter", formatter]]);
		try {
			const writethrough = createLspWritethrough(session.cwd, { enableFormat: true, enableDiagnostics: false });
			await writethrough(localPath, "const value=1\n", undefined, undefined, { id: batchId, flush: false });
			expect(await Bun.file(localPath).text()).toBe("const value=1\n");
			const edited = await new EditTool(session, "replace").execute(
				"remote-final",
				{ path: URL, old_string: "beta", new_string: "BETA" },
				undefined,
				undefined,
				{
					toolCall: {
						batchId,
						index: 1,
						total: 2,
						toolCalls: [
							{ id: "local-first", name: "write" },
							{ id: "remote-final", name: "edit" },
						],
					},
				} as AgentToolContext,
			);
			expect(edited.isError, textOf(edited)).not.toBe(true);
			expect(remoteText).toBe("alpha\nBETA\ngamma\n");
			expect(await Bun.file(localPath).text()).toBe("const value = 1;\n");
		} finally {
			await flushLspWritethroughBatch(batchId, session.cwd);
			tempDir.removeSync();
		}
	});

	it("rejects partial selectors before connecting for an edit", async () => {
		const edited = await new EditTool(session, "replace").execute("selector", {
			path: `${URL}:2-2`,
			old_string: "beta",
			new_string: "BETA",
		});
		expect(edited.isError).toBe(true);
		expect(textOf(edited)).toContain("does not accept the trailing selector");
		expect(fileTransfer.readRemoteFile).not.toHaveBeenCalled();
		expect(fileTransfer.writeRemoteFile).not.toHaveBeenCalled();
	});

	it("edits remote notebook JSON in the same text view returned by read", async () => {
		const notebookUrl = URL.replace(".txt", ".ipynb");
		remoteText = '{"cells": [], "nbformat": 4, "nbformat_minor": 4}\n';
		const before = await new ReadTool(session).execute("read", { path: notebookUrl });
		const edited = await new EditTool(session, "hashline").execute("edit", {
			input: `${headerOf(before)}\nPUT 1.=1:\n+{"cells": [], "nbformat": 4, "nbformat_minor": 5}`,
		});
		expect(edited.isError).not.toBe(true);
		expect(remoteText).toBe('{"cells": [], "nbformat": 4, "nbformat_minor": 5}\n');
	});

	it.each(["remote", "local"] as const)(
		"preserves the %s notebook view across nonadjacent updates",
		async location => {
			await using dir = await TempDir.create("@omp-notebook-batch-");
			session.cwd = dir.path();
			const notebook = {
				cells: [{ cell_type: "markdown", metadata: { keep: true }, source: ["alpha\n"] }],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5,
			};
			const original = JSON.stringify(notebook);
			const notebookPath = location === "remote" ? URL.replace(".txt", ".ipynb") : dir.join("notebook.ipynb");
			if (location === "remote") remoteText = `${original}\n`;
			else await Bun.write(notebookPath, `${original}\n`);
			const otherPath = dir.join("other.txt");
			await Bun.write(otherPath, "before\n");
			const before = location === "remote" ? original : "alpha";
			const middle = before.replace("alpha", "beta");
			const after = before.replace("alpha", "gamma");
			const result = await new EditTool(session, "apply_patch").execute("notebook-batch", {
				input: `*** Begin Patch\n*** Update File: ${notebookPath}\n@@\n-${before}\n+${middle}\n*** Update File: ${otherPath}\n@@\n-before\n+after\n*** Update File: ${notebookPath}\n@@\n-${middle}\n+${after}\n*** End Patch`,
			});
			expect(result.isError, textOf(result)).not.toBe(true);
			const updated: typeof notebook = JSON.parse(
				location === "remote" ? remoteText : await Bun.file(notebookPath).text(),
			);
			expect(updated.cells[0]?.source).toEqual(["gamma\n"]);
			expect(updated.cells[0]?.metadata).toEqual({ keep: true });
			expect(await Bun.file(otherPath).text()).toBe("after\n");
		},
	);

	it("keeps directory listings uneditable and without a snapshot header", async () => {
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([
			{ name: "notes.txt", fileType: ShellFsFileType.File },
		]);
		const listing = await new ReadTool(session).execute("read", { path: URL });
		expect(textOf(listing)).not.toMatch(/#[0-9A-Fa-f]{4}\]/);
		const edited = await new EditTool(session, "replace").execute("edit", {
			path: URL,
			old_string: "notes.txt",
			new_string: "changed.txt",
		});
		expect(edited.isError).toBe(true);
		expect(fileTransfer.writeRemoteFile).not.toHaveBeenCalled();
	});

	it("records only displayed remote lines, including disjoint raw ranges", async () => {
		remoteText = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
		const read = new ReadTool(session);
		const before = await read.execute("read", { path: `${URL}:10-10,60-60` });
		const header = headerOf(before);
		const edit = new EditTool(session, "hashline");
		const unseen = await edit.execute("unseen", { input: `${header}\nPUT 40.=40:\n+unseen` });
		expect(unseen.isError).toBe(true);
		expect(fileTransfer.writeRemoteFile).not.toHaveBeenCalled();
		const raw = await read.execute("raw", { path: `${URL}:raw:40-40,70-70,100-100` });
		expect(textOf(raw)).toBe("line 40\nline 70");
		expect(raw.details?.notes?.join("\n")).toContain("beyond end");
		const seen = await edit.execute("seen", { input: `${header}\nPUT 40.=40:\n+seen` });
		expect(seen.isError).not.toBe(true);
		expect(remoteText.split("\n")[39]).toBe("seen");
	});

	it.each(["REM", `MV ${URL}.moved`])("refuses unsupported remote operation %s before writing", async operation => {
		const before = await new ReadTool(session).execute("read", { path: URL });
		const edited = await new EditTool(session, "hashline").execute("unsupported", {
			input: `${headerOf(before)}\n${operation}`,
		});
		expect(edited.isError).toBe(true);
		expect(textOf(edited)).toContain("updating existing files only");
		expect(remoteText).toBe("alpha\nbeta\ngamma\n");
		expect(fileTransfer.writeRemoteFile).not.toHaveBeenCalled();
	});

	it("refuses SSH edits in plan mode without writing to the remote file", async () => {
		session.getPlanModeState = () => ({ enabled: true, planFilePath: "local://PLAN.md" });
		const tool = new EditTool(session, "replace");
		const args = { path: URL, old_string: "beta", new_string: "BETA" };
		const edited = await tool.execute("plan", args);
		expect(edited.isError).toBe(true);
		expect(fileTransfer.writeRemoteFile).not.toHaveBeenCalled();
	});

	it("surfaces SSH read failures without attempting a write", async () => {
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(new Error("SSH connection lost"));
		const edited = await new EditTool(session, "replace").execute("disconnect", {
			path: URL,
			old_string: "beta",
			new_string: "BETA",
		});
		expect(edited.isError).toBe(true);
		expect(textOf(edited)).toContain("SSH connection lost");
		expect(fileTransfer.writeRemoteFile).not.toHaveBeenCalled();
	});
});
