import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import {
	findServerRoot,
	getServersForFile,
	loadConfig,
	resolveServersForFile,
} from "@oh-my-pi/pi-coding-agent/lsp/config";
import { formatContent, getDiagnosticsForFile } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import type { ExecutedWorkspaceChange } from "@oh-my-pi/pi-coding-agent/lsp/edits";
import { discoverStartupLspServers } from "@oh-my-pi/pi-coding-agent/lsp/servers";
import type { LinterClient, LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { createLspWritethrough } from "@oh-my-pi/pi-coding-agent/lsp/writethrough";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

const settings = Settings.isolated();

function makeLspSession(cwd: string, additionalDirectories?: string[]): ToolSession {
	return { cwd, additionalDirectories, settings } as ToolSession;
}

function mockLspClient(config: ServerConfig, cwd: string): LspClient {
	return {
		name: config.command,
		cwd: config.resolvedRoot ?? cwd,
		config,
		proc: {} as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
		serverCapabilities: { hoverProvider: true },
	} as unknown as LspClient;
}

function writePythonProject(
	root: string,
	relativeDir: string,
	fileName: string,
): { projectRoot: string; filePath: string } {
	const projectRoot = path.join(root, relativeDir);
	const srcDir = path.join(projectRoot, "src");
	fs.mkdirSync(srcDir, { recursive: true });
	fs.writeFileSync(path.join(projectRoot, "pyproject.toml"), '[project]\nname = "nested"\n');
	const filePath = path.join(srcDir, fileName);
	fs.writeFileSync(filePath, "def example():\n    return 1\n");
	return { projectRoot, filePath };
}

function writeLocalPythonServer(projectRoot: string, command = "basedpyright-langserver"): string {
	const binDir = path.join(projectRoot, ".venv", process.platform === "win32" ? "Scripts" : "bin");
	fs.mkdirSync(binDir, { recursive: true });
	const resolved = process.platform === "win32" ? path.join(binDir, `${command}.exe`) : path.join(binDir, command);
	fs.writeFileSync(resolved, "");
	fs.chmodSync(resolved, 0o755);
	return resolved;
}

let homeOverride: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
	originalHome = process.env.HOME;
	homeOverride = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lsp-nested-home-"));
	process.env.HOME = homeOverride;
	vi.spyOn(os, "homedir").mockReturnValue(homeOverride);
});

afterEach(async () => {
	await lspClient.shutdownAll();
	vi.restoreAllMocks();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (homeOverride) fs.rmSync(homeOverride, { recursive: true, force: true });
	homeOverride = undefined;
});

describe("nested LSP project roots", () => {
	it("does not auto-detect a nested language project at session cwd", () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-startup-");
		try {
			writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			expect(config.servers.basedpyright).toBeUndefined();
			expect(config.definitions?.basedpyright).toBeDefined();
			expect(discoverStartupLspServers(tempDir.path()).map(server => server.name)).not.toContain("basedpyright");
		} finally {
			tempDir.removeSync();
		}
	});

	it("resolves a nested python project from a concrete file", () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-python-");
		try {
			const { projectRoot, filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			const resolved = resolveServersForFile(config, filePath, [tempDir.path()]);
			const basedpyright = resolved.find(server => server.name === "basedpyright");
			expect(basedpyright?.root).toBe(projectRoot);
			expect(basedpyright?.config.resolvedRoot).toBe(projectRoot);
			expect(basedpyright?.config.resolvedCommand).toBe("/usr/bin/basedpyright-langserver");
		} finally {
			tempDir.removeSync();
		}
	});

	it("prefers a nested project-local executable over PATH", () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-venv-");
		try {
			const { projectRoot, filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			const localBin = writeLocalPythonServer(projectRoot);
			vi.spyOn(piUtils, "$which").mockReturnValue("/usr/bin/basedpyright-langserver");

			const config = loadConfig(tempDir.path());
			const resolved = resolveServersForFile(config, filePath, [tempDir.path()]);
			expect(resolved.find(server => server.name === "basedpyright")?.config.resolvedCommand).toBe(localBin);
			expect(piUtils.$which).not.toHaveBeenCalledWith("basedpyright-langserver");
		} finally {
			tempDir.removeSync();
		}
	});

	it("uses a hoisted workspace executable for a nested project", () => {
		const tempDir = TempDir.createSync("@omp-lsp-hoisted-bin-");
		try {
			fs.writeFileSync(path.join(tempDir.path(), "package.json"), "{}\n");
			const nested = path.join(tempDir.path(), "packages", "app");
			fs.mkdirSync(path.join(nested, "src"), { recursive: true });
			fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
			const filePath = path.join(nested, "src", "index.ts");
			fs.writeFileSync(filePath, "export const value = 1;\n");
			const binDir = path.join(tempDir.path(), "node_modules", ".bin");
			fs.mkdirSync(binDir, { recursive: true });
			const hoistedBin = path.join(binDir, "typescript-language-server");
			fs.writeFileSync(hoistedBin, "");
			fs.chmodSync(hoistedBin, 0o755);
			vi.spyOn(piUtils, "$which").mockReturnValue(null);

			const config = loadConfig(tempDir.path());
			expect(config.servers["typescript-language-server"]?.resolvedCommand).toBe(hoistedBin);
			const resolved = resolveServersForFile(config, filePath, [tempDir.path()]);
			const typescript = resolved.find(server => server.name === "typescript-language-server");
			expect(typescript?.root).toBe(nested);
			expect(typescript?.config.resolvedCommand).toBe(hoistedBin);
		} finally {
			tempDir.removeSync();
		}
	});

	it("does not reuse the primary workspace executable for an additional workspace", () => {
		const primary = TempDir.createSync("@omp-lsp-primary-bin-");
		const additional = TempDir.createSync("@omp-lsp-additional-bin-");
		try {
			fs.writeFileSync(path.join(primary.path(), "package.json"), "{}\n");
			const binDir = path.join(primary.path(), "node_modules", ".bin");
			fs.mkdirSync(binDir, { recursive: true });
			const primaryBin = path.join(binDir, "typescript-language-server");
			fs.writeFileSync(primaryBin, "");
			fs.chmodSync(primaryBin, 0o755);

			const nested = path.join(additional.path(), "packages", "app");
			fs.mkdirSync(path.join(nested, "src"), { recursive: true });
			fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
			const filePath = path.join(nested, "src", "index.ts");
			fs.writeFileSync(filePath, "export const value = 1;\n");
			vi.spyOn(piUtils, "$which").mockReturnValue(null);

			const config = loadConfig(primary.path());
			expect(config.servers["typescript-language-server"]?.resolvedCommand).toBe(primaryBin);
			const resolved = resolveServersForFile(config, filePath, [primary.path(), additional.path()]);
			expect(resolved.find(server => server.name === "typescript-language-server")).toBeUndefined();
		} finally {
			primary.removeSync();
			additional.removeSync();
		}
	});

	it("roots dot-marker server definitions at the containing workspace", () => {
		const tempDir = TempDir.createSync("@omp-lsp-dot-marker-");
		try {
			const fileA = path.join(tempDir.path(), "src", "a.ts");
			const fileB = path.join(tempDir.path(), "test", "b.ts");
			fs.mkdirSync(path.dirname(fileA), { recursive: true });
			fs.mkdirSync(path.dirname(fileB), { recursive: true });
			fs.writeFileSync(fileA, "export const a = 1;\n");
			fs.writeFileSync(fileB, "export const b = 1;\n");
			const server: ServerConfig = {
				command: "plugin-lsp",
				fileTypes: ["ts"],
				rootMarkers: ["."],
			};
			const config = { servers: {}, definitions: { plugin: server } };
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "plugin-lsp" ? "/usr/bin/plugin-lsp" : null,
			);

			const resolvedA = resolveServersForFile(config, fileA, [tempDir.path()]);
			const resolvedB = resolveServersForFile(config, fileB, [tempDir.path()]);
			expect(resolvedA[0]?.root).toBe(tempDir.path());
			expect(resolvedB[0]?.root).toBe(tempDir.path());
		} finally {
			tempDir.removeSync();
		}
	});

	it("selects the nearest nested root over a parent project", () => {
		const tempDir = TempDir.createSync("@omp-lsp-nearest-root-");
		try {
			fs.writeFileSync(path.join(tempDir.path(), "pyproject.toml"), '[project]\nname = "root"\n');
			const nested = writePythonProject(tempDir.path(), "nested", "foo.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			expect(config.servers.basedpyright).toBeDefined();
			const resolved = resolveServersForFile(config, nested.filePath, [tempDir.path()]);
			expect(resolved.find(server => server.name === "basedpyright")?.root).toBe(nested.projectRoot);
		} finally {
			tempDir.removeSync();
		}
	});

	it("roots the same language server separately for sibling projects", () => {
		const tempDir = TempDir.createSync("@omp-lsp-multi-root-");
		try {
			const a = writePythonProject(tempDir.path(), "a", "a.py");
			const b = writePythonProject(tempDir.path(), "b", "b.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			const resolvedA = resolveServersForFile(config, a.filePath, [tempDir.path()]);
			const resolvedB = resolveServersForFile(config, b.filePath, [tempDir.path()]);
			expect(resolvedA.find(server => server.name === "basedpyright")?.root).toBe(a.projectRoot);
			expect(resolvedB.find(server => server.name === "basedpyright")?.root).toBe(b.projectRoot);
		} finally {
			tempDir.removeSync();
		}
	});

	it("keeps root-level auto-detect unchanged", () => {
		const tempDir = TempDir.createSync("@omp-lsp-root-level-");
		try {
			fs.writeFileSync(path.join(tempDir.path(), "pyproject.toml"), '[project]\nname = "root"\n');
			const filePath = path.join(tempDir.path(), "src", "foo.py");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "x = 1\n");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const config = loadConfig(tempDir.path());
			expect(config.servers.basedpyright?.resolvedCommand).toBe("/usr/bin/basedpyright-langserver");
			const resolved = resolveServersForFile(config, filePath, [tempDir.path()]);
			expect(resolved.find(server => server.name === "basedpyright")?.root).toBe(tempDir.path());
		} finally {
			tempDir.removeSync();
		}
	});

	it("routes a not-yet-created file when the workspace was opened through a symlink", () => {
		const tempDir = TempDir.createSync("@omp-lsp-symlink-new-file-");
		const realRoot = tempDir.path();
		const linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
		fs.symlinkSync(realRoot, linkRoot);
		try {
			writePythonProject(realRoot, "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const newFile = path.join(linkRoot, "python", "src", "new.py");
			const config = loadConfig(linkRoot);
			const resolved = resolveServersForFile(config, newFile, [linkRoot]);
			expect(resolved.find(server => server.name === "basedpyright")?.root).toBe(path.join(linkRoot, "python"));
		} finally {
			fs.rmSync(linkRoot, { force: true });
			tempDir.removeSync();
		}
	});

	it("reuses one nested client when the same root is addressed through a symlink", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-symlink-client-identity-");
		const realRoot = tempDir.path();
		const linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
		fs.symlinkSync(realRoot, linkRoot);
		try {
			const nested = writePythonProject(realRoot, "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			let spawnCount = 0;
			vi.spyOn(piUtils.ptree, "spawn").mockImplementation((() => {
				spawnCount++;
				const { promise: exited, resolve } = Promise.withResolvers<number>();
				return {
					stdin: { write: () => Promise.reject(new Error("identity probe")), flush: () => Promise.resolve() },
					stdout: new ReadableStream<Uint8Array>(),
					stderr: new ReadableStream<Uint8Array>(),
					exited,
					exitCode: null,
					kill: () => resolve(1),
					peekStderr: () => "",
				};
			}) as unknown as typeof piUtils.ptree.spawn);
			const config = loadConfig(linkRoot);
			const viaLink = resolveServersForFile(config, path.join(linkRoot, "python", "src", "example.py"), [linkRoot]);
			const viaReal = resolveServersForFile(config, nested.filePath, [linkRoot]);
			const linkServer = viaLink.find(server => server.name === "basedpyright");
			const realServer = viaReal.find(server => server.name === "basedpyright");
			expect(linkServer?.root).toBe(path.join(linkRoot, "python"));
			expect(realServer?.root).toBe(nested.projectRoot);
			expect(linkServer?.root).not.toBe(realServer?.root);
			await expect(lspClient.getOrCreateClient(linkServer!.config, linkRoot)).rejects.toThrow("identity probe");
			await expect(lspClient.getOrCreateClient(realServer!.config, linkRoot)).rejects.toThrow(
				"failed to initialize recently",
			);
			expect(spawnCount).toBe(1);
		} finally {
			fs.rmSync(linkRoot, { force: true });
			tempDir.removeSync();
		}
	});

	it("reuses one nested client when a project-local executable is reached through a symlink", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-symlink-exec-identity-");
		const realRoot = tempDir.path();
		const linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
		fs.symlinkSync(realRoot, linkRoot);
		try {
			const nested = writePythonProject(realRoot, "python", "example.py");
			const realBin = writeLocalPythonServer(nested.projectRoot);
			const linkBin = path.join(linkRoot, path.relative(realRoot, realBin));
			vi.spyOn(piUtils, "$which").mockReturnValue(null);
			let spawnCount = 0;
			vi.spyOn(piUtils.ptree, "spawn").mockImplementation((() => {
				spawnCount++;
				const { promise: exited, resolve } = Promise.withResolvers<number>();
				return {
					stdin: { write: () => Promise.reject(new Error("identity probe")), flush: () => Promise.resolve() },
					stdout: new ReadableStream<Uint8Array>(),
					stderr: new ReadableStream<Uint8Array>(),
					exited,
					exitCode: null,
					kill: () => resolve(1),
					peekStderr: () => "",
				};
			}) as unknown as typeof piUtils.ptree.spawn);
			const config = loadConfig(linkRoot);
			const viaLink = resolveServersForFile(config, path.join(linkRoot, "python", "src", "example.py"), [linkRoot]);
			const viaReal = resolveServersForFile(config, nested.filePath, [linkRoot]);
			const linkServer = viaLink.find(server => server.name === "basedpyright");
			const realServer = viaReal.find(server => server.name === "basedpyright");
			expect(linkServer?.config.resolvedCommand).toBe(linkBin);
			expect(realServer?.config.resolvedCommand).toBe(realBin);
			expect(linkServer?.config.resolvedCommand).not.toBe(realServer?.config.resolvedCommand);
			await expect(lspClient.getOrCreateClient(linkServer!.config, linkRoot)).rejects.toThrow("identity probe");
			await expect(lspClient.getOrCreateClient(realServer!.config, linkRoot)).rejects.toThrow(
				"failed to initialize recently",
			);
			expect(spawnCount).toBe(1);
		} finally {
			fs.rmSync(linkRoot, { force: true });
			tempDir.removeSync();
		}
	});

	it("emits the canonical document URI for a file addressed through a symlink", () => {
		const tempDir = TempDir.createSync("@omp-lsp-symlink-doc-uri-");
		const realRoot = tempDir.path();
		const linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
		fs.symlinkSync(realRoot, linkRoot);
		try {
			const nested = writePythonProject(realRoot, "python", "example.py");
			const viaLink = path.join(linkRoot, "python", "src", "example.py");
			expect(fileToUri(viaLink)).toBe(fileToUri(nested.filePath));
			expect(fileToUri(viaLink)).toBe(Bun.pathToFileURL(nested.filePath).href);
		} finally {
			fs.rmSync(linkRoot, { force: true });
			tempDir.removeSync();
		}
	});

	it("keeps a leaf symlink document URI inside the workspace", () => {
		const tempDir = TempDir.createSync("@omp-lsp-leaf-symlink-doc-uri-");
		const shared = TempDir.createSync("@omp-lsp-leaf-symlink-shared-");
		try {
			const nested = writePythonProject(tempDir.path(), "python", "example.py");
			const sharedFile = path.join(shared.path(), "shared.py");
			fs.writeFileSync(sharedFile, "def shared():\n    return 1\n");
			const alias = path.join(nested.projectRoot, "src", "alias.py");
			fs.symlinkSync(sharedFile, alias);
			expect(fileToUri(alias)).toBe(Bun.pathToFileURL(path.resolve(alias)).href);
			expect(fileToUri(alias)).not.toBe(fileToUri(sharedFile));
			expect(fileToUri(alias)).not.toBe(Bun.pathToFileURL(sharedFile).href);
			const viaWorkspaceLinkParent = path.join(
				path.dirname(tempDir.path()),
				`${path.basename(tempDir.path())}-link`,
			);
			fs.symlinkSync(tempDir.path(), viaWorkspaceLinkParent);
			try {
				const viaLink = path.join(viaWorkspaceLinkParent, "python", "src", "alias.py");
				expect(fileToUri(viaLink)).toBe(fileToUri(alias));
			} finally {
				fs.rmSync(viaWorkspaceLinkParent, { force: true });
			}
		} finally {
			tempDir.removeSync();
			shared.removeSync();
		}
	});

	it("routes a leaf symlink file to the containing nested project", () => {
		const tempDir = TempDir.createSync("@omp-lsp-leaf-symlink-route-");
		const shared = TempDir.createSync("@omp-lsp-leaf-symlink-route-shared-");
		try {
			const nested = writePythonProject(tempDir.path(), "python", "example.py");
			const sharedFile = path.join(shared.path(), "shared.py");
			fs.writeFileSync(sharedFile, "def shared():\n    return 1\n");
			const alias = path.join(nested.projectRoot, "src", "alias.py");
			fs.symlinkSync(sharedFile, alias);
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const config = loadConfig(tempDir.path());
			const resolved = resolveServersForFile(config, alias, [tempDir.path()]);
			expect(resolved.find(server => server.name === "basedpyright")?.root).toBe(nested.projectRoot);
		} finally {
			tempDir.removeSync();
			shared.removeSync();
		}
	});

	it("routes a file through an in-workspace directory symlink", () => {
		const tempDir = TempDir.createSync("@omp-lsp-dir-symlink-route-");
		const shared = TempDir.createSync("@omp-lsp-dir-symlink-route-shared-");
		try {
			const nested = writePythonProject(tempDir.path(), "python", "example.py");
			const sharedSrc = path.join(shared.path(), "src");
			fs.mkdirSync(sharedSrc, { recursive: true });
			const sharedFile = path.join(sharedSrc, "linked.py");
			fs.writeFileSync(sharedFile, "def linked():\n    return 1\n");
			const aliasDir = path.join(nested.projectRoot, "linked-src");
			fs.symlinkSync(sharedSrc, aliasDir);
			const alias = path.join(aliasDir, "linked.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const config = loadConfig(tempDir.path());
			const resolved = resolveServersForFile(config, alias, [tempDir.path()]);
			expect(resolved.find(server => server.name === "basedpyright")?.root).toBe(nested.projectRoot);
		} finally {
			tempDir.removeSync();
			shared.removeSync();
		}
	});

	it("keeps a directory-symlink document URI inside the workspace", () => {
		const tempDir = TempDir.createSync("@omp-lsp-dir-symlink-doc-uri-");
		const shared = TempDir.createSync("@omp-lsp-dir-symlink-doc-uri-shared-");
		try {
			const nested = writePythonProject(tempDir.path(), "python", "example.py");
			const sharedSrc = path.join(shared.path(), "src");
			fs.mkdirSync(sharedSrc, { recursive: true });
			const sharedFile = path.join(sharedSrc, "linked.py");
			fs.writeFileSync(sharedFile, "def linked():\n    return 1\n");
			const aliasDir = path.join(nested.projectRoot, "linked-src");
			fs.symlinkSync(sharedSrc, aliasDir);
			const alias = path.join(aliasDir, "linked.py");
			expect(fileToUri(alias, nested.projectRoot)).toBe(Bun.pathToFileURL(path.resolve(alias)).href);
			expect(fileToUri(alias, nested.projectRoot)).not.toBe(fileToUri(sharedFile, nested.projectRoot));
			expect(fileToUri(alias, nested.projectRoot)).not.toBe(Bun.pathToFileURL(sharedFile).href);
		} finally {
			tempDir.removeSync();
			shared.removeSync();
		}
	});

	it("queries diagnostics with each client's document URI across a directory symlink", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-dir-symlink-diag-uri-");
		const shared = TempDir.createSync("@omp-lsp-dir-symlink-diag-uri-shared-");
		try {
			const sharedProject = path.join(shared.path(), "project");
			fs.mkdirSync(sharedProject, { recursive: true });
			const sharedFile = path.join(sharedProject, "foo.ts");
			fs.writeFileSync(sharedFile, "export const foo = 1;\n");
			const aliasDir = path.join(tempDir.path(), "link");
			fs.symlinkSync(sharedProject, aliasDir);
			const alias = path.join(aliasDir, "foo.ts");
			const outerUri = fileToUri(alias, tempDir.path());
			const innerUri = fileToUri(alias, sharedProject);
			expect(outerUri).not.toBe(innerUri);

			const range = {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 3 },
			};
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => {
				const client = mockLspClient(config, cwd);
				const uri = fileToUri(alias, config.resolvedRoot ?? cwd);
				client.diagnostics.set(uri, {
					diagnostics: [{ message: `${config.command} finding`, range }],
					version: 1,
				});
				client.diagnosticsVersion = 1;
				return client;
			});

			const result = await getDiagnosticsForFile(
				alias,
				tempDir.path(),
				[
					[
						"outer-lsp",
						{ command: "outer-lsp", fileTypes: ["ts"], rootMarkers: [], resolvedRoot: tempDir.path() },
					],
					["inner-lsp", { command: "inner-lsp", fileTypes: ["ts"], rootMarkers: [], resolvedRoot: sharedProject }],
				],
				{ timeoutMs: 1_000, pipelineBudgetMs: 3_000 },
			);

			expect(result?.server).toContain("outer-lsp");
			expect(result?.server).toContain("inner-lsp");
			expect(result?.messages.some(message => message.includes("outer-lsp finding"))).toBe(true);
			expect(result?.messages.some(message => message.includes("inner-lsp finding"))).toBe(true);
		} finally {
			tempDir.removeSync();
			shared.removeSync();
		}
	});

	it("rename_file asks one nested server when symlink and canonical roots both match", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-symlink-rename-key-");
		const realRoot = tempDir.path();
		const linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
		fs.symlinkSync(realRoot, linkRoot);
		try {
			const nested = writePythonProject(realRoot, "python", "example.py");
			const destViaReal = path.join(nested.projectRoot, "src", "renamed.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const willRenameRequests: unknown[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => mockLspClient(config, cwd));
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method, params) => {
				if (method === "workspace/willRenameFiles") willRenameRequests.push(params);
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue(undefined);

			const sourceViaLink = path.join(linkRoot, "python", "src", "example.py");
			const tool = new LspTool(makeLspSession(linkRoot));
			const result = await tool.execute("symlink-rename-key", {
				action: "rename_file",
				file: sourceViaLink,
				new_name: destViaReal,
				timeout: 5,
			});

			expect(result.details).toMatchObject({ action: "rename_file", success: true });
			expect(willRenameRequests).toHaveLength(1);
			expect(fs.existsSync(sourceViaLink)).toBe(false);
			expect(fs.existsSync(destViaReal)).toBe(true);
		} finally {
			fs.rmSync(linkRoot, { force: true });
			tempDir.removeSync();
		}
	});

	it("rename_file reports the symlink alias, not its target, for willRenameFiles", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-symlink-entry-rename-");
		try {
			const nested = writePythonProject(tempDir.path(), "python", "example.py");
			const alias = path.join(nested.projectRoot, "src", "alias.py");
			const dest = path.join(nested.projectRoot, "src", "renamed-alias.py");
			fs.symlinkSync(nested.filePath, alias);
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const willRenameRequests: unknown[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => mockLspClient(config, cwd));
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method, params) => {
				if (method === "workspace/willRenameFiles") willRenameRequests.push(params);
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue(undefined);

			const result = await new LspTool(makeLspSession(tempDir.path())).execute("symlink-entry-rename", {
				action: "rename_file",
				file: alias,
				new_name: dest,
				timeout: 5,
			});

			expect(result.details).toMatchObject({ action: "rename_file", success: true });
			expect(willRenameRequests).toEqual([
				{
					files: [
						{
							oldUri: Bun.pathToFileURL(path.resolve(alias)).href,
							newUri: Bun.pathToFileURL(path.resolve(dest)).href,
						},
					],
				},
			]);
			expect(Bun.pathToFileURL(path.resolve(alias)).href).not.toBe(fileToUri(nested.filePath));
			expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
			expect(fs.existsSync(nested.filePath)).toBe(true);
		} finally {
			tempDir.removeSync();
		}
	});

	it("rename_file reconciles canonical overlays when the workspace is a symlink", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-symlink-workspace-rename-overlay-");
		const realRoot = tempDir.path();
		const linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
		fs.symlinkSync(realRoot, linkRoot);
		try {
			const nested = writePythonProject(realRoot, "python", "example.py");
			const sourceViaLink = path.join(linkRoot, "python", "src", "example.py");
			const destViaLink = path.join(linkRoot, "python", "src", "renamed.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const client = mockLspClient(
				{
					command: "basedpyright-langserver",
					fileTypes: [".py"],
					rootMarkers: ["pyproject.toml"],
					resolvedRoot: nested.projectRoot,
				},
				nested.projectRoot,
			);
			client.openFiles.set(fileToUri(sourceViaLink), { version: 1, languageId: "python" });
			const willRenameRequests: unknown[] = [];
			const closedUris: string[] = [];
			const reconciled: ExecutedWorkspaceChange[][] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method, params) => {
				if (method === "workspace/willRenameFiles") willRenameRequests.push(params);
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockImplementation(async (_client, method, params) => {
				if (method !== "textDocument/didClose" || !params || typeof params !== "object") return;
				if (!("textDocument" in params)) return;
				const textDocument = params.textDocument;
				if (!textDocument || typeof textDocument !== "object" || !("uri" in textDocument)) return;
				if (typeof textDocument.uri === "string") closedUris.push(textDocument.uri);
			});
			vi.spyOn(lspClient, "reconcileExecutedChanges").mockImplementation(async executed => {
				reconciled.push(executed);
			});

			const result = await new LspTool(makeLspSession(linkRoot)).execute("symlink-workspace-rename-overlay", {
				action: "rename_file",
				file: sourceViaLink,
				new_name: destViaLink,
				timeout: 5,
			});

			expect(result.details).toMatchObject({ action: "rename_file", success: true });
			expect(willRenameRequests).toEqual([
				{
					files: [
						{
							oldUri: Bun.pathToFileURL(path.resolve(sourceViaLink)).href,
							newUri: Bun.pathToFileURL(path.resolve(destViaLink)).href,
						},
					],
				},
			]);
			expect(reconciled).toEqual([
				[{ kind: "rename", oldUri: fileToUri(sourceViaLink), newUri: fileToUri(destViaLink) }],
			]);
			expect(closedUris).toEqual([fileToUri(sourceViaLink)]);
			expect(client.openFiles.has(fileToUri(sourceViaLink))).toBe(false);
		} finally {
			fs.rmSync(linkRoot, { force: true });
			tempDir.removeSync();
		}
	});

	it("rename_file keeps extra-root directory-symlink edit URIs", async () => {
		const cwdDir = TempDir.createSync("@omp-lsp-extra-root-rename-cwd-");
		const extraDir = TempDir.createSync("@omp-lsp-extra-root-rename-extra-");
		const shared = TempDir.createSync("@omp-lsp-extra-root-rename-shared-");
		try {
			const extraRoot = extraDir.path();
			const extraProject = writePythonProject(extraRoot, "python", "example.py");
			const extraSource = extraProject.filePath;
			const extraDest = path.join(extraProject.projectRoot, "src", "renamed.py");
			fs.symlinkSync(shared.path(), path.join(extraRoot, "link"));
			fs.mkdirSync(path.join(extraRoot, "link", "src"), { recursive: true });
			const extraAliasFile = path.join(extraRoot, "link", "src", "alias.py");
			fs.writeFileSync(extraAliasFile, "def alias():\n    return 1\n");
			const extraAliasUri = fileToUri(extraAliasFile, extraRoot);
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const client = mockLspClient(
				{
					command: "basedpyright-langserver",
					fileTypes: [".py"],
					rootMarkers: ["pyproject.toml"],
					resolvedRoot: extraRoot,
				},
				extraRoot,
			);
			const reconciled: ExecutedWorkspaceChange[][] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method) => {
				if (method === "workspace/willRenameFiles") {
					return {
						changes: {
							[extraAliasUri]: [
								{
									range: {
										start: { line: 0, character: 0 },
										end: { line: 0, character: 9 },
									},
									newText: "def renamed",
								},
							],
						},
					};
				}
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue(undefined);
			vi.spyOn(lspClient, "reconcileExecutedChanges").mockImplementation(async executed => {
				reconciled.push(executed);
			});

			const result = await new LspTool(makeLspSession(cwdDir.path(), [extraRoot])).execute(
				"extra-root-dir-symlink-rename-uri",
				{
					action: "rename_file",
					file: extraSource,
					new_name: extraDest,
					timeout: 5,
				},
			);

			expect(result.details).toMatchObject({ action: "rename_file", success: true });
			expect(fileToUri(extraAliasFile, cwdDir.path())).not.toBe(extraAliasUri);
			expect(reconciled).toEqual([
				[
					{ kind: "edit", uri: extraAliasUri },
					{
						kind: "rename",
						oldUri: fileToUri(extraSource, extraRoot),
						newUri: fileToUri(extraDest, extraRoot),
					},
				],
			]);
			expect(fs.readFileSync(extraAliasFile, "utf8")).toBe("def renamed():\n    return 1\n");
			expect(fs.existsSync(extraSource)).toBe(false);
			expect(fs.existsSync(extraDest)).toBe(true);
		} finally {
			cwdDir.removeSync();
			extraDir.removeSync();
			shared.removeSync();
		}
	});

	it("rename_file sends each nested server only the pairs under its root", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-dir-rename-sibling-");
		try {
			const pkgs = path.join(tempDir.path(), "pkgs");
			const a = writePythonProject(pkgs, "a", "a.py");
			const b = writePythonProject(pkgs, "b", "b.py");
			const dest = path.join(tempDir.path(), "moved");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const willRenameByRoot = new Map<string, unknown>();
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => mockLspClient(config, cwd));
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (client, method, params) => {
				if (method === "workspace/willRenameFiles") willRenameByRoot.set(client.cwd, params);
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue(undefined);

			const result = await new LspTool(makeLspSession(tempDir.path())).execute("sibling-dir-rename", {
				action: "rename_file",
				file: pkgs,
				new_name: dest,
				timeout: 5,
			});

			expect(result.details).toMatchObject({ action: "rename_file", success: true });
			expect(willRenameByRoot.size).toBeGreaterThanOrEqual(2);
			const aParams = willRenameByRoot.get(a.projectRoot) as { files: Array<{ oldUri: string }> } | undefined;
			const bParams = willRenameByRoot.get(b.projectRoot) as { files: Array<{ oldUri: string }> } | undefined;
			expect(aParams?.files.every(pair => pair.oldUri.includes("/a/"))).toBe(true);
			expect(bParams?.files.every(pair => pair.oldUri.includes("/b/"))).toBe(true);
			expect(aParams?.files.some(pair => pair.oldUri.includes("/b/"))).toBe(false);
			expect(bParams?.files.some(pair => pair.oldUri.includes("/a/"))).toBe(false);
		} finally {
			tempDir.removeSync();
		}
	});

	it("rename_file keeps a leaf symlink pair on the containing nested server", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-leaf-symlink-rename-pairs-");
		const shared = TempDir.createSync("@omp-lsp-leaf-symlink-rename-pairs-shared-");
		try {
			const nested = writePythonProject(tempDir.path(), "python", "example.py");
			const sharedFile = path.join(shared.path(), "shared.py");
			fs.writeFileSync(sharedFile, "def shared():\n    return 1\n");
			const alias = path.join(nested.projectRoot, "src", "alias.py");
			const dest = path.join(nested.projectRoot, "src", "renamed-alias.py");
			fs.symlinkSync(sharedFile, alias);
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const willRenameRequests: unknown[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => mockLspClient(config, cwd));
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method, params) => {
				if (method === "workspace/willRenameFiles") willRenameRequests.push(params);
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue(undefined);

			const result = await new LspTool(makeLspSession(tempDir.path())).execute("leaf-symlink-rename-pairs", {
				action: "rename_file",
				file: alias,
				new_name: dest,
				timeout: 5,
			});

			expect(result.details).toMatchObject({ action: "rename_file", success: true });
			expect(willRenameRequests).toEqual([
				{
					files: [
						{
							oldUri: Bun.pathToFileURL(path.resolve(alias)).href,
							newUri: Bun.pathToFileURL(path.resolve(dest)).href,
						},
					],
				},
			]);
			expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
			expect(fs.existsSync(sharedFile)).toBe(true);
		} finally {
			tempDir.removeSync();
			shared.removeSync();
		}
	});

	it("does not use the primary cwd executable for a nested additional workspace under a long symlink", () => {
		const tempDir = TempDir.createSync("@omp-lsp-symlink-rank-exec-");
		const realOuter = tempDir.path();
		fs.writeFileSync(path.join(realOuter, "package.json"), "{}\n");
		const nested = path.join(realOuter, "pkg");
		fs.mkdirSync(path.join(nested, "src"), { recursive: true });
		fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
		const filePath = path.join(nested, "src", "index.ts");
		fs.writeFileSync(filePath, "export const value = 1;\n");
		const binDir = path.join(realOuter, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		const primaryBin = path.join(binDir, "typescript-language-server");
		fs.writeFileSync(primaryBin, "");
		fs.chmodSync(primaryBin, 0o755);
		const linkRoot = path.join(path.dirname(realOuter), `${path.basename(realOuter)}-very-long-symlink-alias`);
		fs.symlinkSync(realOuter, linkRoot);
		try {
			expect(linkRoot.length).toBeGreaterThan(nested.length);
			vi.spyOn(piUtils, "$which").mockReturnValue(null);
			const config = loadConfig(linkRoot);
			expect(config.servers["typescript-language-server"]?.resolvedCommand).toBe(
				path.join(linkRoot, "node_modules", ".bin", "typescript-language-server"),
			);
			const resolved = resolveServersForFile(config, filePath, [linkRoot, nested]);
			expect(resolved.find(server => server.name === "typescript-language-server")).toBeUndefined();
		} finally {
			fs.rmSync(linkRoot, { force: true });
			tempDir.removeSync();
		}
	});

	it("does not use the primary cwd executable for a lexically nested symlink additional workspace", () => {
		const cwdDir = TempDir.createSync("@omp-lsp-lexical-cwd-");
		const targetDir = TempDir.createSync("@omp-lsp-lexical-target-");
		const cwd = path.join(cwdDir.path(), "very-long-session-cwd-alias");
		fs.mkdirSync(cwd);
		fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
		const binDir = path.join(cwd, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		const primaryBin = path.join(binDir, "typescript-language-server");
		fs.writeFileSync(primaryBin, "");
		fs.chmodSync(primaryBin, 0o755);
		const nestedLink = path.join(cwd, "pkg");
		fs.symlinkSync(targetDir.path(), nestedLink);
		fs.mkdirSync(path.join(targetDir.path(), "src"), { recursive: true });
		fs.writeFileSync(path.join(targetDir.path(), "package.json"), "{}\n");
		const filePath = path.join(nestedLink, "src", "index.ts");
		fs.writeFileSync(path.join(targetDir.path(), "src", "index.ts"), "export const value = 1;\n");
		try {
			expect(piUtils.resolveEquivalentPath(nestedLink).length).toBeLessThan(path.resolve(cwd).length);
			vi.spyOn(piUtils, "$which").mockReturnValue(null);
			const config = loadConfig(cwd);
			expect(config.servers["typescript-language-server"]?.resolvedCommand).toBe(primaryBin);
			const resolved = resolveServersForFile(config, filePath, [cwd, nestedLink]);
			expect(resolved.find(server => server.name === "typescript-language-server")).toBeUndefined();
		} finally {
			cwdDir.removeSync();
			targetDir.removeSync();
		}
	});

	it("does not walk ancestors above the session workspace", () => {
		const tempDir = TempDir.createSync("@omp-lsp-boundary-");
		try {
			fs.writeFileSync(path.join(tempDir.path(), "pyproject.toml"), '[project]\nname = "outside"\n');
			const workspace = path.join(tempDir.path(), "workspace");
			const filePath = path.join(workspace, "src", "foo.py");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "x = 1\n");

			expect(findServerRoot(filePath, ["pyproject.toml"], [workspace])).toBeNull();
			const config = loadConfig(workspace);
			expect(
				resolveServersForFile(config, filePath, [workspace]).find(server => server.name === "basedpyright"),
			).toBeUndefined();
		} finally {
			tempDir.removeSync();
		}
	});

	it("starts a nested server from a concrete lsp tool call", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-tool-");
		try {
			const { projectRoot, filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const roots: string[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => {
				roots.push(config.resolvedRoot ?? cwd);
				return mockLspClient(config, cwd);
			});
			vi.spyOn(lspClient, "ensureFileOpen").mockResolvedValue();
			vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
				contents: { kind: "markdown", value: "nested-root-hover" },
			});

			const tool = new LspTool(makeLspSession(tempDir.path()));
			const result = await tool.execute("nested-hover", {
				action: "hover",
				file: filePath,
				line: 1,
				symbol: "example",
			});
			const text = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			expect(text).toContain("nested-root-hover");
			expect(roots).toContain(projectRoot);
			expect(discoverStartupLspServers(tempDir.path()).map(s => s.name)).not.toContain("basedpyright");
		} finally {
			tempDir.removeSync();
		}
	});

	it("routes nested edit/write diagnostics through the nested project root", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-write-");
		try {
			const { projectRoot, filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);

			const roots: string[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => {
				roots.push(config.resolvedRoot ?? cwd);
				return mockLspClient(config, cwd);
			});

			const writethrough = createLspWritethrough(tempDir.path(), { enableDiagnostics: true, enableFormat: false });
			await writethrough(filePath, "def example():\n    return 2\n");
			expect(roots).toContain(projectRoot);
		} finally {
			tempDir.removeSync();
		}
	});

	it("routes writes through directories added after write-tool construction", async () => {
		const primary = TempDir.createSync("@omp-lsp-add-dir-primary-");
		const additional = TempDir.createSync("@omp-lsp-add-dir-extra-");
		try {
			const nested = writePythonProject(additional.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => mockLspClient(config, cwd));
			vi.spyOn(lspClient, "syncContent").mockResolvedValue();
			vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
			vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();
			const extraDirs: string[] = [];
			const session = {
				cwd: primary.path(),
				get additionalDirectories() {
					return extraDirs.length > 0 ? extraDirs : undefined;
				},
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({
					"lsp.formatOnWrite": false,
					"lsp.diagnosticsOnWrite": true,
				}),
				enableLsp: true,
			} as ToolSession;
			const tool = new WriteTool(session);
			extraDirs.push(additional.path());
			const getServers = vi.spyOn(lspConfig, "getServersForFile");

			await tool.execute("add-dir-write", {
				path: nested.filePath,
				content: "def example():\n    return 2\n",
			});

			expect(getServers.mock.calls.some(call => call[2]?.includes(additional.path()))).toBe(true);
		} finally {
			primary.removeSync();
			additional.removeSync();
		}
	});

	it("routes writes through a cwd changed after write-tool construction", async () => {
		const original = TempDir.createSync("@omp-lsp-move-cwd-original-");
		const moved = TempDir.createSync("@omp-lsp-move-cwd-moved-");
		try {
			const nested = writePythonProject(moved.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async (config, cwd) => mockLspClient(config, cwd));
			vi.spyOn(lspClient, "syncContent").mockResolvedValue();
			vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
			vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();
			const session = {
				cwd: original.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({
					"lsp.formatOnWrite": false,
					"lsp.diagnosticsOnWrite": true,
				}),
				enableLsp: true,
			} as ToolSession;
			const tool = new WriteTool(session);
			session.cwd = moved.path();
			const getServers = vi.spyOn(lspConfig, "getServersForFile");

			await tool.execute("move-cwd-write", {
				path: nested.filePath,
				content: "def example():\n    return 2\n",
			});

			expect(getServers.mock.calls.some(call => call[2]?.includes(moved.path()))).toBe(true);
			expect(
				getServers.mock.calls.every(call => !call[2]?.includes(original.path()) || call[2]?.includes(moved.path())),
			).toBe(true);
		} finally {
			original.removeSync();
			moved.removeSync();
		}
	});

	it("registers a lazy session owner on write-through client creation", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-lazy-owner-write-");
		try {
			const { filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const owner = lspClient.createLspClientOwner();
			const createdOwners: unknown[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(
				async (config, cwd, _timeout, _signal, clientOwner) => {
					createdOwners.push(clientOwner);
					return mockLspClient(config, cwd);
				},
			);
			vi.spyOn(lspClient, "syncContent").mockResolvedValue();
			vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
			vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();
			const session = {
				cwd: tempDir.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getLspClientOwner: () => owner,
				settings: Settings.isolated({
					"lsp.formatOnWrite": false,
					"lsp.diagnosticsOnWrite": true,
				}),
				enableLsp: true,
			} as ToolSession;

			await new WriteTool(session).execute("lazy-owner-write", {
				path: filePath,
				content: "def example():\n    return 2\n",
			});

			expect(createdOwners).toContain(owner);
		} finally {
			tempDir.removeSync();
		}
	});

	it("assigns a reusable fallback owner when write-through has no session owner", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-fallback-owner-write-");
		try {
			const { filePath } = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const createdOwners: unknown[] = [];
			vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(
				async (config, cwd, _timeout, _signal, clientOwner) => {
					createdOwners.push(clientOwner);
					return mockLspClient(config, cwd);
				},
			);
			vi.spyOn(lspClient, "syncContent").mockResolvedValue();
			vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
			vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();
			const session = {
				cwd: tempDir.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({
					"lsp.formatOnWrite": false,
					"lsp.diagnosticsOnWrite": true,
				}),
				enableLsp: true,
			} as ToolSession;

			await new WriteTool(session).execute("fallback-owner-write", {
				path: filePath,
				content: "def example():\n    return 2\n",
			});

			expect(createdOwners.length).toBeGreaterThan(0);
			expect(new Set(createdOwners)).toEqual(new Set([lspClient.fallbackLspClientOwner(session)]));
		} finally {
			tempDir.removeSync();
		}
	});

	it("roots custom linter diagnostics and formatting at each nested project", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-linter-");
		try {
			const projectA = path.join(tempDir.path(), "a");
			const projectB = path.join(tempDir.path(), "b");
			fs.mkdirSync(projectA);
			fs.mkdirSync(projectB);
			const fileA = path.join(projectA, "a.ts");
			const fileB = path.join(projectB, "b.ts");
			fs.writeFileSync(fileA, "const a = 1;\n");
			fs.writeFileSync(fileB, "const b = 1;\n");
			const createdRoots: string[] = [];
			const createClient = (_config: ServerConfig, cwd: string): LinterClient => {
				createdRoots.push(cwd);
				return {
					format: async (_filePath, content) => `${content}// ${path.basename(cwd)}\n`,
					lint: async () => [],
				};
			};
			const server: ServerConfig = {
				command: "nested-linter",
				fileTypes: ["ts"],
				rootMarkers: [],
				createClient,
			};
			const serverA: ServerConfig = { ...server, resolvedRoot: projectA };
			const serverB: ServerConfig = { ...server, resolvedRoot: projectB };

			await getDiagnosticsForFile(fileA, tempDir.path(), [["nested-linter", serverA]]);
			const formattedA = await formatContent(fileA, "const a = 1;\n", tempDir.path(), [["nested-linter", serverA]]);
			const formattedB = await formatContent(fileB, "const b = 1;\n", tempDir.path(), [["nested-linter", serverB]]);

			expect(createdRoots).toEqual([projectA, projectB]);
			expect(formattedA.content).toContain("// a");
			expect(formattedB.content).toContain("// b");
		} finally {
			tempDir.removeSync();
		}
	});

	it("clears a nested initialization failure using the resolved root identity", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-reload-failure-");
		try {
			const nestedRoot = path.join(tempDir.path(), "python");
			fs.mkdirSync(nestedRoot);
			const config: ServerConfig = {
				command: "broken-nested-lsp",
				fileTypes: ["py"],
				rootMarkers: [],
				resolvedRoot: nestedRoot,
			};
			let spawnCount = 0;
			vi.spyOn(piUtils.ptree, "spawn").mockImplementation((() => {
				spawnCount++;
				const { promise: exited, resolve } = Promise.withResolvers<number>();
				return {
					stdin: {
						write: () => Promise.reject(new Error("nested init failed")),
						flush: () => Promise.resolve(),
					},
					stdout: new ReadableStream<Uint8Array>(),
					stderr: new ReadableStream<Uint8Array>(),
					exited,
					exitCode: null,
					kill: () => resolve(1),
					peekStderr: () => "",
				};
			}) as unknown as typeof piUtils.ptree.spawn);
			await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toThrow("nested init failed");
			await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toThrow(
				"failed to initialize recently",
			);
			expect(spawnCount).toBe(1);

			lspClient.clearInitializationFailure(config, tempDir.path());
			await expect(lspClient.getOrCreateClient(config, tempDir.path())).rejects.toThrow("nested init failed");
			expect(spawnCount).toBe(2);
		} finally {
			tempDir.removeSync();
		}
	});

	it("workspace reload clears nested initialization failures owned by that session", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-nested-workspace-reload-failure-");
		try {
			const nested = writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			let spawnCount = 0;
			vi.spyOn(piUtils.ptree, "spawn").mockImplementation((() => {
				spawnCount++;
				const { promise: exited, resolve } = Promise.withResolvers<number>();
				return {
					stdin: {
						write: () => Promise.reject(new Error("nested init failed")),
						flush: () => Promise.resolve(),
					},
					stdout: new ReadableStream<Uint8Array>(),
					stderr: new ReadableStream<Uint8Array>(),
					exited,
					exitCode: null,
					kill: () => resolve(1),
					peekStderr: () => "",
				};
			}) as unknown as typeof piUtils.ptree.spawn);

			const owner = lspClient.createLspClientOwner();
			const tool = new LspTool(makeLspSession(tempDir.path()), owner);
			const firstFailure = await tool.execute("nested-failure", {
				action: "hover",
				file: nested.filePath,
				line: 1,
				symbol: "example",
			});
			expect(firstFailure.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("nested init failed"),
			});
			expect(spawnCount).toBe(1);
			await tool.execute("nested-workspace-reload", { action: "reload", file: "*" });
			const retryFailure = await tool.execute("nested-retry", {
				action: "hover",
				file: nested.filePath,
				line: 1,
				symbol: "example",
			});
			expect(retryFailure.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("nested init failed"),
			});
			expect(spawnCount).toBe(2);
		} finally {
			tempDir.removeSync();
		}
	});

	it("workspace reload clears nested failures when the session cwd is a symlink", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-symlink-reload-failure-");
		const realRoot = tempDir.path();
		const linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
		fs.symlinkSync(realRoot, linkRoot);
		try {
			const nested = writePythonProject(realRoot, "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			let spawnCount = 0;
			vi.spyOn(piUtils.ptree, "spawn").mockImplementation((() => {
				spawnCount++;
				const { promise: exited, resolve } = Promise.withResolvers<number>();
				return {
					stdin: {
						write: () => Promise.reject(new Error("nested init failed")),
						flush: () => Promise.resolve(),
					},
					stdout: new ReadableStream<Uint8Array>(),
					stderr: new ReadableStream<Uint8Array>(),
					exited,
					exitCode: null,
					kill: () => resolve(1),
					peekStderr: () => "",
				};
			}) as unknown as typeof piUtils.ptree.spawn);

			const owner = lspClient.createLspClientOwner();
			const tool = new LspTool(makeLspSession(linkRoot), owner);
			const firstFailure = await tool.execute("symlink-nested-failure", {
				action: "hover",
				file: nested.filePath,
				line: 1,
				symbol: "example",
			});
			expect(firstFailure.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("nested init failed"),
			});
			expect(spawnCount).toBe(1);
			await tool.execute("symlink-nested-workspace-reload", { action: "reload", file: "*" });
			const retryFailure = await tool.execute("symlink-nested-retry", {
				action: "hover",
				file: nested.filePath,
				line: 1,
				symbol: "example",
			});
			expect(retryFailure.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("nested init failed"),
			});
			expect(spawnCount).toBe(2);
		} finally {
			fs.rmSync(linkRoot, { force: true });
			tempDir.removeSync();
		}
	});

	it("does not change cwd-only getServersForFile matching", () => {
		const tempDir = TempDir.createSync("@omp-lsp-cwd-api-");
		try {
			writePythonProject(tempDir.path(), "python", "example.py");
			vi.spyOn(piUtils, "$which").mockImplementation(command =>
				command === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null,
			);
			const config = loadConfig(tempDir.path());
			expect(getServersForFile(config, path.join(tempDir.path(), "python", "src", "example.py"))).toEqual([]);
		} finally {
			tempDir.removeSync();
		}
	});
});
