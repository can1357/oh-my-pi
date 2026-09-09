import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	InternalUrlRouter,
	parseInternalUrl,
	parseVaultUrl,
	resolveVaultUrlToPath,
	VaultProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as vaultProtocol from "@oh-my-pi/pi-coding-agent/internal-urls/vault-protocol";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

function resourceUrl(input: string) {
	return parseInternalUrl(input);
}

function testHandler(spawn: typeof vaultProtocol.spawnObsidian, binary = "/test/obsidian"): VaultProtocolHandler {
	return new VaultProtocolHandler({
		spawnObsidian: spawn,
		resolveObsidianBinary: () => binary,
	});
}

describe("VaultProtocolHandler", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		VaultProtocolHandler.resetForTests();
		InternalUrlRouter.resetForTests();
		// vault.enabled defaults to false (opt-in); existing tests pre-date the gate and
		// assume the handler is active. Force-enable per-test; the dedicated "disabled"
		// case toggles this off via its own spy.
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		VaultProtocolHandler.resetForTests();
		InternalUrlRouter.resetForTests();
	});

	it("parses every supported vault:// URL shape", () => {
		const cases: Record<string, string> = {
			list: "vault://",
			info: "vault://Work",
			activeFile: "vault://_/foo.md",
			folder: "vault://Work/folder/",
			fileOp: "vault://Work/foo.md?op=outline",
			vaultOp: "vault://Work?op=search&q=x",
		};
		const parsed: Record<string, vaultProtocol.ParsedVaultUrl> = {};
		for (const name in cases) {
			parsed[name] = parseVaultUrl(cases[name]);
		}

		expect(parsed).toEqual({
			list: { kind: "list-vaults", url: "vault://", params: {} },
			info: {
				kind: "vault-info",
				url: "vault://Work",
				ref: { vault: "Work", active: false, forwardVault: true, display: "Work" },
				params: {},
			},
			activeFile: {
				kind: "fs-file",
				url: "vault://_/foo.md",
				ref: { vault: null, active: true, forwardVault: false, display: "_" },
				relativePath: "foo.md",
				params: {},
			},
			folder: {
				kind: "fs-dir",
				url: "vault://Work/folder/",
				ref: { vault: "Work", active: false, forwardVault: true, display: "Work" },
				relativePath: "folder",
				params: {},
			},
			fileOp: {
				kind: "file-op",
				url: "vault://Work/foo.md?op=outline",
				ref: { vault: "Work", active: false, forwardVault: true, display: "Work" },
				relativePath: "foo.md",
				op: "outline",
				params: { op: "outline" },
			},
			vaultOp: {
				kind: "vault-op",
				url: "vault://Work?op=search&q=x",
				ref: { vault: "Work", active: false, forwardVault: true, display: "Work" },
				op: "search",
				params: { op: "search", q: "x" },
			},
		});

		expect(() => parseVaultUrl("vault://Work/foo.md?op=eval")).toThrow("Unsupported vault:// file op: eval");
		expect(() => parseVaultUrl("vault://Work?op=eval")).toThrow("Unsupported vault:// vault op: eval");
	});

	it("rejects traversal and symlink escapes for reads and writes", async () => {
		await withTempDir(async tempDir => {
			const root = path.join(tempDir, "vault");
			await fs.mkdir(root, { recursive: true });
			VaultProtocolHandler.setVaultDirectoryForTests({ Work: root });
			const handler = new VaultProtocolHandler({ resolveObsidianBinary: () => null });

			await expect(handler.resolve(resourceUrl("vault://Work/../secret.md"))).rejects.toThrow(
				"Path traversal (..) is not allowed in vault:// URLs",
			);
			await expect(handler.resolve(resourceUrl("vault://Work/%2E%2E/secret.md"))).rejects.toThrow(
				"Path traversal (..) is not allowed in vault:// URLs",
			);
			await expect(handler.write(resourceUrl("vault://Work//absolute.md"), "x")).rejects.toThrow(
				"Absolute paths are not allowed in vault:// URLs",
			);

			if (process.platform === "win32") return;

			const outside = path.join(tempDir, "outside");
			await fs.mkdir(outside, { recursive: true });
			await Bun.write(path.join(outside, "secret.md"), "secret");
			await fs.symlink(outside, path.join(root, "linked"));

			await expect(handler.resolve(resourceUrl("vault://Work/linked/secret.md"))).rejects.toThrow(
				"vault:// URL escapes vault root",
			);
			await expect(handler.write(resourceUrl("vault://Work/linked/new.md"), "new")).rejects.toThrow(
				"vault:// URL escapes vault root",
			);
		});
	});

	it("reads markdown files from the cached vault root without spawning obsidian", async () => {
		await withTempDir(async tempDir => {
			const root = path.join(tempDir, "vault");
			const note = path.join(root, "Folder", "note.md");
			await fs.mkdir(path.dirname(note), { recursive: true });
			await Bun.write(note, "# Note\nbody");
			VaultProtocolHandler.setVaultDirectoryForTests({ Work: root });
			const spawnSpy = vi.spyOn(vaultProtocol, "spawnObsidian").mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});
			const handler = testHandler(vaultProtocol.spawnObsidian);

			const resource = await handler.resolve(resourceUrl("vault://Work/Folder/note.md"));

			expect(resource.content).toBe("# Note\nbody");
			expect(resource.contentType).toBe("text/markdown");
			expect(resource.sourcePath).toBe(await fs.realpath(note));
			expect(spawnSpy).not.toHaveBeenCalled();
		});
	});

	it("resolves active-vault filesystem paths from obsidian vault info output", async () => {
		await withTempDir(async tempDir => {
			const root = path.join(tempDir, "active-vault");
			await fs.mkdir(root, { recursive: true });
			await Bun.write(path.join(root, "note.md"), "active note");
			const spawnSpy = vi.spyOn(vaultProtocol, "spawnObsidian").mockResolvedValue({
				stdout: `name\tObsidian\npath\t${root}\nfiles\t1\n`,
				stderr: "",
				exitCode: 0,
			});
			const handler = testHandler(vaultProtocol.spawnObsidian);

			const resource = await handler.resolve(resourceUrl("vault://_/note.md"));
			const second = await handler.resolve(resourceUrl("vault://_/note.md"));

			expect(resource.content).toBe("active note");
			expect(second.content).toBe("active note");
			expect(spawnSpy).toHaveBeenCalledTimes(1);
			expect(spawnSpy.mock.calls[0][1]).toEqual(["vault", "info", "path"]);
		});
	});

	it("targets a named vault by prepending vault= before the vault info subcommand", async () => {
		await withTempDir(async tempDir => {
			const root = path.join(tempDir, "work-vault");
			await fs.mkdir(root, { recursive: true });
			await Bun.write(path.join(root, "note.md"), "note");
			VaultProtocolHandler.setVaultDirectoryForTests({ Work: root });
			const spawnSpy = vi.spyOn(vaultProtocol, "spawnObsidian").mockResolvedValue({
				stdout: `name\tWork\npath\t${root}\n`,
				stderr: "",
				exitCode: 0,
			});
			const handler = testHandler(vaultProtocol.spawnObsidian);

			await handler.resolve(resourceUrl("vault://Work"));

			expect(spawnSpy).toHaveBeenCalledTimes(1);
			expect(spawnSpy.mock.calls[0][1]).toEqual(["vault=Work", "vault", "info"]);
		});
	});
	it("writes files through the protocol hook and resolves cached vault paths for edit plumbing", async () => {
		await withTempDir(async tempDir => {
			const root = path.join(tempDir, "vault");
			await fs.mkdir(root, { recursive: true });
			VaultProtocolHandler.setVaultDirectoryForTests({ Work: root });
			const spawnSpy = vi.spyOn(vaultProtocol, "spawnObsidian").mockResolvedValue({
				stdout: "",
				stderr: "",
				exitCode: 0,
			});
			const handler = testHandler(vaultProtocol.spawnObsidian);

			await handler.write(resourceUrl("vault://Work/scratch.md"), "new body");
			const resource = await handler.resolve(resourceUrl("vault://Work/scratch.md"));

			expect(await Bun.file(path.join(root, "scratch.md")).text()).toBe("new body");
			expect(resource.content).toBe("new body");
			expect(resolveVaultUrlToPath("vault://Work/scratch.md")).toBe(
				await fs.realpath(path.join(root, "scratch.md")),
			);
			expect(spawnSpy).not.toHaveBeenCalled();
		});
	});

	it("lists folder entries as markdown vault links", async () => {
		await withTempDir(async tempDir => {
			const root = path.join(tempDir, "vault");
			await fs.mkdir(path.join(root, "Folder", "Sub"), { recursive: true });
			await Bun.write(path.join(root, "Folder", "note.md"), "note");
			VaultProtocolHandler.setVaultDirectoryForTests({ Work: root });
			const handler = new VaultProtocolHandler({ resolveObsidianBinary: () => null });

			const resource = await handler.resolve(resourceUrl("vault://Work/Folder/"));

			expect(resource.contentType).toBe("text/markdown");
			expect(resource.sourcePath).toBe(await fs.realpath(path.join(root, "Folder")));
			expect(resource.content).toContain("[note.md](vault://Work/Folder/note.md)");
			expect(resource.content).toContain("[Sub/](vault://Work/Folder/Sub/)");
		});
	});

	it("lists existing folder paths even without a trailing slash", async () => {
		await withTempDir(async tempDir => {
			const root = path.join(tempDir, "vault");
			await fs.mkdir(path.join(root, "Folder", "Sub"), { recursive: true });
			await Bun.write(path.join(root, "Folder", "note.md"), "note");
			VaultProtocolHandler.setVaultDirectoryForTests({ Work: root });
			const handler = new VaultProtocolHandler({ resolveObsidianBinary: () => null });

			const resource = await handler.resolve(resourceUrl("vault://Work/Folder"));

			expect(resource.contentType).toBe("text/markdown");
			expect(resource.sourcePath).toBe(await fs.realpath(path.join(root, "Folder")));
			expect(resource.content).toContain("[note.md](vault://Work/Folder/note.md)");
			expect(resource.content).toContain("[Sub/](vault://Work/Folder/Sub/)");
		});
	});

	it("reports the documented binary-missing error for CLI-backed operations", async () => {
		const handler = new VaultProtocolHandler({ resolveObsidianBinary: () => null });

		await expect(handler.resolve(resourceUrl("vault://Work?op=search&q=plan"))).rejects.toThrow(
			/Checked PATH entry 'obsidian'.*\/Applications\/Obsidian\.app\/Contents\/MacOS\/obsidian.*https:\/\/obsidian\.md/,
		);
	});

	it("constructs exact obsidian argv for supported CLI operations", async () => {
		const calls: Record<string, string[]> = {};
		const spawnSpy = vi.spyOn(vaultProtocol, "spawnObsidian").mockImplementation(async () => {
			return { stdout: "ok", stderr: "", exitCode: 0 };
		});
		const handler = testHandler(vaultProtocol.spawnObsidian);
		const cases: Record<string, string> = {
			outline: "vault://Work/Note.md?op=outline",
			backlinks: "vault://Work/Note.md?op=backlinks",
			links: "vault://Work/Note.md?op=links",
			fileTags: "vault://Work/Note.md?op=tags",
			fileProperties: "vault://Work/Note.md?op=properties",
			fileTasks: "vault://Work/Note.md?op=tasks",
			wordcount: "vault://Work/Note.md?op=wordcount",
			history: "vault://Work/Note.md?op=history",
			base: "vault://Work/Note.md?op=base&view=Main",
			search: "vault://Work?op=search&q=plan&path=Folder&limit=5&case",
			daily: "vault://Work?op=daily",
			dailyPath: "vault://Work?op=daily-path",
			vaultTags: "vault://Work?op=tags",
			tag: "vault://Work?op=tag&name=%23todo",
			vaultTasks: "vault://Work?op=tasks",
			orphans: "vault://Work?op=orphans",
			unresolved: "vault://Work?op=unresolved",
			deadends: "vault://Work?op=deadends",
			bases: "vault://Work?op=bases",
			bookmarks: "vault://Work?op=bookmarks",
			recents: "vault://Work?op=recents",
			templates: "vault://Work?op=templates",
			aliases: "vault://Work?op=aliases",
			vaultProperties: "vault://Work?op=properties",
			property: "vault://Work?op=property&name=status&path=Note.md",
		};

		for (const name in cases) {
			const before = spawnSpy.mock.calls.length;
			await handler.resolve(resourceUrl(cases[name]));
			calls[name] = spawnSpy.mock.calls[before][1];
		}

		expect(calls).toEqual({
			outline: ["vault=Work", "outline", "path=Note.md", "format=md"],
			backlinks: ["vault=Work", "backlinks", "path=Note.md", "counts", "format=tsv"],
			links: ["vault=Work", "links", "path=Note.md"],
			fileTags: ["vault=Work", "tags", "path=Note.md", "counts", "format=json"],
			fileProperties: ["vault=Work", "properties", "path=Note.md", "format=yaml"],
			fileTasks: ["vault=Work", "tasks", "path=Note.md", "verbose", "format=json"],
			wordcount: ["vault=Work", "wordcount", "path=Note.md"],
			history: ["vault=Work", "history", "path=Note.md"],
			base: ["vault=Work", "base:query", "path=Note.md", "view=Main", "format=md"],
			search: ["vault=Work", "search:context", "query=plan", "path=Folder", "limit=5", "case", "format=json"],
			daily: ["vault=Work", "daily:read"],
			dailyPath: ["vault=Work", "daily:path"],
			vaultTags: ["vault=Work", "tags", "counts", "format=json"],
			tag: ["vault=Work", "tag", "name=#todo", "verbose"],
			vaultTasks: ["vault=Work", "tasks", "todo", "verbose", "format=json"],
			orphans: ["vault=Work", "orphans"],
			unresolved: ["vault=Work", "unresolved", "counts", "verbose", "format=json"],
			deadends: ["vault=Work", "deadends"],
			bases: ["vault=Work", "bases"],
			bookmarks: ["vault=Work", "bookmarks", "verbose", "format=json"],
			recents: ["vault=Work", "recents"],
			templates: ["vault=Work", "templates"],
			aliases: ["vault=Work", "aliases", "verbose", "format=json"],
			vaultProperties: ["vault=Work", "properties", "counts", "format=yaml"],
			property: ["vault=Work", "property:read", "name=status", "path=Note.md"],
		});
	});

	it("surfaces obsidian stdout error text even when the CLI exits zero", async () => {
		const spawnSpy = vi.spyOn(vaultProtocol, "spawnObsidian").mockResolvedValue({
			stdout: 'Error: File "NOPE" not found.\n',
			stderr: "",
			exitCode: 0,
		});
		const handler = testHandler(vaultProtocol.spawnObsidian);

		await expect(handler.resolve(resourceUrl("vault://Work/NOPE.md?op=outline"))).rejects.toThrow(
			'vault://outline failed: Error: File "NOPE" not found.',
		);
		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces obsidian stderr on non-zero exit", async () => {
		const spawnSpy = vi.spyOn(vaultProtocol, "spawnObsidian").mockResolvedValue({
			stdout: "",
			stderr: 'Error: File "NOPE" not found.\n',
			exitCode: 1,
		});
		const handler = testHandler(vaultProtocol.spawnObsidian);

		await expect(handler.resolve(resourceUrl("vault://Work/NOPE.md?op=outline"))).rejects.toThrow(
			'vault://outline failed: Error: File "NOPE" not found.',
		);
		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it("aborts an in-flight spawn when the AbortSignal is cancelled", async () => {
		const sleep = $which("sleep");
		if (!sleep) return;
		const controller = new AbortController();
		const promise = vaultProtocol.spawnObsidian(sleep, ["10"], controller.signal, 30_000);

		await Bun.sleep(20);
		controller.abort();

		await expect(promise).rejects.toThrow("obsidian command cancelled");
	});

	it("does not forward vault= for active or empty-host sentinel CLI URLs", async () => {
		const calls: string[][] = [];
		const spawnSpy = vi.spyOn(vaultProtocol, "spawnObsidian").mockImplementation(async (_bin, args) => {
			calls.push(args);
			return { stdout: "ok", stderr: "", exitCode: 0 };
		});
		const handler = testHandler(vaultProtocol.spawnObsidian);

		await handler.resolve(resourceUrl("vault://_?op=search&q=plan"));
		await handler.resolve(resourceUrl("vault://?op=search&q=plan"));

		expect(calls).toEqual([
			["search:context", "query=plan", "format=json"],
			["search:context", "query=plan", "format=json"],
		]);
		expect(spawnSpy).toHaveBeenCalledTimes(2);
	});

	it("marks plain vault file resources editable through the router", async () => {
		await withTempDir(async tempDir => {
			const root = path.join(tempDir, "vault");
			await fs.mkdir(root, { recursive: true });
			await Bun.write(path.join(root, "scratch.md"), "body");
			VaultProtocolHandler.setVaultDirectoryForTests({ Work: root });

			const resource = await InternalUrlRouter.instance().resolve("vault://Work/scratch.md");

			expect(resource.content).toBe("body");
			expect(resource.immutable).toBe(false);
		});
	});

	it("refuses resolve, write, and path resolution when vault.enabled is false", async () => {
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(false);
		const handler = testHandler(vaultProtocol.spawnObsidian);

		await expect(handler.resolve(resourceUrl("vault://Work/foo.md"))).rejects.toThrow(
			vaultProtocol.VaultDisabledError,
		);
		await expect(handler.write(resourceUrl("vault://Work/foo.md"), "body")).rejects.toThrow(
			vaultProtocol.VaultDisabledError,
		);
		expect(() => resolveVaultUrlToPath("vault://Work/foo.md")).toThrow(vaultProtocol.VaultDisabledError);
	});

	it("reports hasObsidian() as false when the gate is off, even if the binary is on disk", () => {
		// hasObsidian feeds Handlebars `{{#if hasObsidian}}` in the system prompt.
		// Disabling the gate MUST hide vault:// from the prompt regardless of binary presence.
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(false);
		vi.spyOn(vaultProtocol, "resolveObsidianBinary").mockReturnValue("/test/obsidian");

		expect(vaultProtocol.hasObsidian()).toBe(false);
	});

	it("reports hasObsidian() as true only when both the gate is on and the binary exists", () => {
		vi.spyOn(vaultProtocol, "isVaultEnabled").mockReturnValue(true);
		vi.spyOn(vaultProtocol, "resolveObsidianBinary").mockReturnValue("/test/obsidian");
		expect(vaultProtocol.hasObsidian()).toBe(true);

		vi.spyOn(vaultProtocol, "resolveObsidianBinary").mockReturnValue(null);
		expect(vaultProtocol.hasObsidian()).toBe(false);
	});
});
