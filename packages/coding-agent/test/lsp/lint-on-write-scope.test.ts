import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BiomeClient } from "@oh-my-pi/pi-coding-agent/lsp/clients/biome-client";
import { runLinterCli } from "@oh-my-pi/pi-coding-agent/lsp/clients/cli-process";
import { filterLintersForFile, getConfig, loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { DeferredDiagnostics } from "@oh-my-pi/pi-coding-agent/lsp/deferred-diagnostics";
import { formatContent, getDiagnosticsForFile } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { writeFakeExecutable } from "../helpers/fake-executable";

/**
 * Lint-on-write runs CLI linters (Biome, SwiftLint) after every write. These
 * tests pin three properties with real processes:
 *
 * 1. A linter runs only for a file whose own project root (found from the file)
 *    selects it: the session cwd's Biome never lints another repository's file.
 * 2. It runs from that root, with that root's executable, on that file only.
 * 3. Its process tree dies on abort and on its deadline, even
 *    when the executable is a launcher (npm's `.bin/biome` is a Node script that
 *    runs the native binary as a grandchild).
 */

let temp: TempDir;
let root: string;
const strayPids: number[] = [];

beforeEach(() => {
	temp = TempDir.createSync("@omp-lint-scope-");
	root = fs.realpathSync(temp.path());
});

afterEach(async () => {
	for (const pid of strayPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	await temp.remove();
});

function write(file: string, content: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/**
 * A fake `node_modules/.bin/biome` for the repository at `repo`. Each run
 * appends `{ self, cwd, argv }` to `log`; `lint` reports one diagnostic whose
 * message names `self`, `format` leaves the file as it is.
 */
function installRecordingBiome(repo: string, self: string, log: string): string {
	const bin = path.join(repo, "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	return writeFakeExecutable(
		bin,
		"biome",
		`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ self: ${JSON.stringify(self)}, cwd: process.cwd(), argv: process.argv.slice(2) }) + "\\n");
if (process.argv[2] === "lint") {
	const file = process.argv[process.argv.length - 1];
	process.stdout.write(JSON.stringify({ diagnostics: [{ category: "lint/fake/rule", severity: "error", message: "from ${self}", location: { path: file, start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }] }));
	process.exit(1);
}
`,
	);
}

function readLog(log: string): Array<{ self: string; cwd: string; argv: string[] }> {
	try {
		return fs
			.readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line));
	} catch {
		return [];
	}
}

/** A JS repository with a biome.json and its own Biome, as the session cwd. */
function makeSessionRepo(log: string): { repo: string; biome: ServerConfig } {
	const repo = path.join(root, "repo-a");
	write(path.join(repo, "package.json"), '{"name":"repo-a"}\n');
	write(path.join(repo, "biome.json"), "{}\n");
	const command = installRecordingBiome(repo, "A", log);
	const biome = getConfig(repo).servers.biome;
	// The session's Biome is repo-a's own executable.
	expect(biome?.resolvedCommand).toBe(command);
	return { repo, biome: biome as ServerConfig };
}

/**
 * A launcher-shaped linter: it runs a grandchild synchronously and does not
 * forward signals (as npm's Node `bin/biome` does). The grandchild writes its
 * pid to `pidFile` and then runs until killed.
 */
function installLauncherLinter(dir: string, pidFile: string): string {
	return writeFakeExecutable(
		dir,
		"launcher-linter",
		`const grandchild = ${JSON.stringify(
			`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30);`,
		)};
const result = Bun.spawnSync([process.execPath, "-e", grandchild], { stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode ?? 1);
`,
	);
}

// The waits below poll real processes (a pid file another process writes, a
// pid's exit): no fake clock can stand in for the kernel. Each returns as soon
// as its condition holds.
async function waitForPid(pidFile: string): Promise<number> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const pid = Number(fs.readFileSync(pidFile, "utf8"));
			if (pid > 0) {
				strayPids.push(pid);
				return pid;
			}
		} catch {}
		await Bun.sleep(20);
	}
	throw new Error("grandchild never started");
}

/** Running and not yet a zombie (an exited orphan waits for its reaper). */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		return state !== "Z" && state !== "X";
	} catch {
		return process.platform !== "linux";
	}
}

/** Polls briefly: a reaped grandchild is gone at once, a leaked one stays. */
async function aliveAfter(pid: number, ms = 1_500): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return false;
		await Bun.sleep(25);
	}
	return isAlive(pid);
}

describe("lint-on-write scope", () => {
	it("never runs the session cwd's Biome on a file of a repository without a Biome root", async () => {
		const log = path.join(root, "runs.log");
		const { repo, biome } = makeSessionRepo(log);
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "pyproject.toml"), '[project]\nname = "simsci"\n');
		const target = write(path.join(otherRepo, "tools", "simsci", "helper.js"), "debugger;\n");

		const diagnostics = await getDiagnosticsForFile(target, repo, [["biome", biome]]);
		const formatted = await formatContent(target, "debugger;\n", repo, [["biome", biome]]);

		expect(diagnostics).toBeUndefined();
		expect(formatted).toEqual({ content: "debugger;\n", failed: false, unsupported: true });
		expect(readLog(log)).toEqual([]);
	}, 20_000);

	it("runs the file's own root's Biome, from that root, on that file only", async () => {
		const log = path.join(root, "runs.log");
		const { repo, biome } = makeSessionRepo(log);
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "package.json"), '{"name":"repo-b"}\n');
		write(path.join(otherRepo, "biome.json"), "{}\n");
		installRecordingBiome(otherRepo, "B", log);
		const target = write(path.join(otherRepo, "src", "deep", "file.ts"), "export const x = 1;\n");

		const diagnostics = await getDiagnosticsForFile(target, repo, [["biome", biome]]);

		expect(diagnostics?.messages.join("\n")).toContain("from B");
		expect(readLog(log)).toEqual([{ self: "B", cwd: otherRepo, argv: ["lint", "--reporter=json", target] }]);
	}, 20_000);

	it("finds the root, executable and argv from the file's physical location through symlinks", async () => {
		const log = path.join(root, "runs.log");
		const { repo, biome } = makeSessionRepo(log);
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "package.json"), '{"name":"repo-b"}\n');
		write(path.join(otherRepo, "biome.json"), "{}\n");
		installRecordingBiome(otherRepo, "B", log);
		const real = write(path.join(otherRepo, "src", "x.ts"), "export const x = 1;\n");
		const leafLink = path.join(repo, "src", "foreign.ts");
		fs.mkdirSync(path.dirname(leafLink), { recursive: true });
		fs.symlinkSync(real, leafLink);
		fs.symlinkSync(path.join(otherRepo, "src"), path.join(repo, "linked"));

		const viaLeaf = await getDiagnosticsForFile(leafLink, repo, [["biome", biome]]);
		const viaDirectory = await getDiagnosticsForFile(path.join(repo, "linked", "x.ts"), repo, [["biome", biome]]);

		expect(viaLeaf?.messages.join("\n")).toContain("from B");
		expect(viaDirectory?.messages.join("\n")).toContain("from B");
		const run = { self: "B", cwd: otherRepo, argv: ["lint", "--reporter=json", real] };
		expect(readLog(log)).toEqual([run, run]);
	}, 20_000);

	it("runs a root's own node_modules/.bin linter when the root has no package.json", async () => {
		const log = path.join(root, "runs.log");
		const { repo, biome } = makeSessionRepo(log);
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "biome.json"), "{}\n");
		installRecordingBiome(otherRepo, "B", log);
		const target = write(path.join(otherRepo, "x.ts"), "export const x = 1;\n");

		const diagnostics = await getDiagnosticsForFile(target, repo, [["biome", biome]]);

		expect(diagnostics?.messages.join("\n")).toContain("from B");
		expect(readLog(log)).toEqual([{ self: "B", cwd: otherRepo, argv: ["lint", "--reporter=json", target] }]);
	}, 20_000);

	it("follows a dangling symlink to the repository its target will be created in", async () => {
		const log = path.join(root, "runs.log");
		const { repo, biome } = makeSessionRepo(log);
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "package.json"), '{"name":"repo-b"}\n');
		write(path.join(otherRepo, "biome.json"), "{}\n");
		installRecordingBiome(otherRepo, "B", log);
		const target = path.join(otherRepo, "src", "new.ts");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const link = path.join(repo, "new.ts");
		fs.symlinkSync(target, link);

		const formatted = await formatContent(link, "export const x = 1;\n", repo, [["biome", biome]]);

		expect(formatted.unsupported).toBe(false);
		expect(readLog(log)).toEqual([{ self: "B", cwd: otherRepo, argv: ["format", "--write", target] }]);
	}, 20_000);

	it("applies a link target's `..` to the physical directory, as the kernel creates the file", async () => {
		const log = path.join(root, "runs.log");
		const { repo, biome } = makeSessionRepo(log);
		const makeRepo = (name: string, self: string) => {
			const dir = path.join(root, name);
			write(path.join(dir, "package.json"), `{"name":"${name}"}\n`);
			write(path.join(dir, "biome.json"), "{}\n");
			installRecordingBiome(dir, self, log);
			return dir;
		};
		const repoB = makeRepo("repo-b", "B");
		const repoC = makeRepo("repo-c", "C");
		// A/alias -> B/sub, and B/sub/link.ts -> ../new.ts (dangling): created as B/new.ts.
		fs.mkdirSync(path.join(repoB, "sub"));
		fs.symlinkSync(path.join(repoB, "sub"), path.join(repo, "alias"));
		fs.symlinkSync("../new.ts", path.join(repoB, "sub", "link.ts"));
		// A/door.ts -> B/door/../made.ts with B/door -> C/sub: created as C/made.ts.
		fs.mkdirSync(path.join(repoC, "sub"));
		fs.symlinkSync(path.join(repoC, "sub"), path.join(repoB, "door"));
		// A literal `..` (path.join would apply it lexically and drop the door).
		fs.symlinkSync([repoB, "door", "..", "made.ts"].join(path.sep), path.join(repo, "door.ts"));

		await formatContent(path.join(repo, "alias", "link.ts"), "export const x = 1;\n", repo, [["biome", biome]]);
		await formatContent(path.join(repo, "door.ts"), "export const y = 1;\n", repo, [["biome", biome]]);

		expect(readLog(log)).toEqual([
			{ self: "B", cwd: repoB, argv: ["format", "--write", path.join(repoB, "new.ts")] },
			{ self: "C", cwd: repoC, argv: ["format", "--write", path.join(repoC, "made.ts")] },
		]);
	}, 20_000);

	it("gives the linter the same physical file it chose the root from when the path has `..` after a link", async () => {
		const log = path.join(root, "runs.log");
		const { repo, biome } = makeSessionRepo(log);
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "package.json"), '{"name":"repo-b"}\n');
		write(path.join(otherRepo, "biome.json"), "{}\n");
		installRecordingBiome(otherRepo, "B", log);
		fs.mkdirSync(path.join(otherRepo, "sub"));
		fs.symlinkSync(path.join(otherRepo, "sub"), path.join(repo, "link"));
		const physical = write(path.join(otherRepo, "file.ts"), "export const b = 1;\n");
		write(path.join(repo, "file.ts"), "export const decoy = 1;\n");
		// A/link/../file.ts is B/file.ts to the kernel; a lexical `..` would make it A/file.ts.
		const throughLink = [repo, "link", "..", "file.ts"].join(path.sep);

		const diagnostics = await getDiagnosticsForFile(throughLink, repo, [["biome", biome]]);
		const formatted = await formatContent(throughLink, "export const b = 2;\n", repo, [["biome", biome]]);

		expect(diagnostics?.messages.join("\n")).toContain("from B");
		expect(formatted.content).toBe("export const b = 2;\n");
		expect(fs.readFileSync(path.join(repo, "file.ts"), "utf8")).toBe("export const decoy = 1;\n");
		expect(readLog(log)).toEqual([
			{ self: "B", cwd: otherRepo, argv: ["lint", "--reporter=json", physical] },
			{ self: "B", cwd: otherRepo, argv: ["format", "--write", physical] },
		]);
	}, 20_000);

	it.skipIf(process.platform === "win32")(
		"treats a backslash as part of a POSIX filename",
		async () => {
			const log = path.join(root, "runs.log");
			const { biome } = makeSessionRepo(log);
			// A /bin/sh recorder: `bun <script>` itself rewrites a backslash in its script path.
			const makeRepo = (dir: string, self: string) => {
				write(path.join(dir, "package.json"), '{"name":"r"}\n');
				write(path.join(dir, "biome.json"), "{}\n");
				const launcher = write(
					path.join(dir, "node_modules", ".bin", "biome"),
					`#!/bin/sh\nprintf '%s|%s|%s\\n' '${self}' "$PWD" "$*" >> '${log}'\nprintf '{"diagnostics":[]}'\n`,
				);
				fs.chmodSync(launcher, 0o755);
			};
			const backslashRepo = path.join(root, "A\\sub");
			makeRepo(backslashRepo, "backslash");
			makeRepo(path.join(root, "A", "sub"), "slash");
			const target = write(path.join(backslashRepo, "file.ts"), "export const x = 1;\n");
			// The same file reached through a link whose target spells the backslash.
			const linked = path.join(root, "linked.ts");
			fs.symlinkSync(target, linked);

			await getDiagnosticsForFile(target, path.join(root, "session"), [["biome", biome]]);
			await getDiagnosticsForFile(linked, path.join(root, "session"), [["biome", biome]]);

			const run = `backslash|${backslashRepo}|lint --reporter=json ${target}`;
			expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([run, run]);
		},
		20_000,
	);

	it("runs an explicit linter command path from the file's root, never a local-bin lookalike", async () => {
		const log = path.join(root, "runs.log");
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "package.json"), '{"name":"repo-b"}\n');
		write(path.join(otherRepo, "biome.json"), "{}\n");
		const recorder = (self: string) =>
			`require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ self: ${JSON.stringify(self)}, cwd: process.cwd(), argv: process.argv.slice(2) }) + "\\n");
process.stdout.write(JSON.stringify({ diagnostics: [] }));
`;
		const toolsDir = path.join(otherRepo, "tools");
		fs.mkdirSync(toolsDir, { recursive: true });
		const intended = writeFakeExecutable(toolsDir, "biome", recorder("B"));
		// Lookalikes a local-bin prefix would find: node_modules/.bin/tools/biome and
		// node_modules/.bin/<absolute path>.
		for (const shadowDir of [
			path.join(otherRepo, "node_modules", ".bin", "tools"),
			path.join(otherRepo, "node_modules", ".bin", path.dirname(intended)),
		]) {
			fs.mkdirSync(shadowDir, { recursive: true });
			writeFakeExecutable(shadowDir, "biome", recorder("SHADOW"));
		}
		const target = write(path.join(otherRepo, "x.ts"), "export const x = 1;\n");
		const linter = (command: string): ServerConfig => ({
			command,
			fileTypes: [".ts"],
			rootMarkers: ["biome.json"],
			isLinter: true,
			createClient: BiomeClient.create,
		});
		const session = path.join(root, "session");

		// Relative: resolved against the root, not the process cwd.
		const viaRelative = await getDiagnosticsForFile(target, session, [["rel", linter("./tools/biome")]]);
		const viaAbsolute = await getDiagnosticsForFile(target, session, [["abs", linter(intended)]]);

		expect(viaRelative?.summary).toBe("OK");
		expect(viaAbsolute?.summary).toBe("OK");
		const run = { self: "B", cwd: otherRepo, argv: ["lint", "--reporter=json", target] };
		expect(readLog(log)).toEqual([run, run]);
	}, 20_000);

	it("resolves a session's relative server command against the session cwd, not the process cwd", () => {
		const session = path.join(root, "repo-b");
		write(path.join(session, "biome.json"), "{}\n");
		write(path.join(session, "lsp.json"), JSON.stringify({ servers: { biome: { command: "./tools/biome" } } }));
		fs.mkdirSync(path.join(session, "tools"), { recursive: true });
		const intended = writeFakeExecutable(path.join(session, "tools"), "biome", "process.exit(0);\n");

		const resolved = loadConfig(session).servers.biome?.resolvedCommand;

		expect(resolved && fs.realpathSync(resolved)).toBe(fs.realpathSync(intended));
	});

	it("follows links that a `..` reaches back to after a directory still to be created", async () => {
		const log = path.join(root, "runs.log");
		const { repo, biome } = makeSessionRepo(log);
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "package.json"), '{"name":"repo-b"}\n');
		write(path.join(otherRepo, "biome.json"), "{}\n");
		installRecordingBiome(otherRepo, "B", log);
		fs.mkdirSync(path.join(otherRepo, "sub"));
		fs.symlinkSync(path.join(otherRepo, "sub"), path.join(repo, "link"));
		// A/missing does not exist; a writer creates it, then A/link/.. is B.
		const input = [repo, "missing", "..", "link", "..", "file.ts"].join(path.sep);

		await formatContent(input, "export const x = 1;\n", repo, [["biome", biome]]);

		const physical = path.join(otherRepo, "file.ts");
		expect(readLog(log)).toEqual([{ self: "B", cwd: otherRepo, argv: ["format", "--write", physical] }]);
	}, 20_000);

	it("never takes another repository's executable from an empty or relative PATH entry", async () => {
		const log = path.join(root, "runs.log");
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "biome.json"), "{}\n");
		installRecordingBiome(otherRepo, "B", log);
		// Reachable only through an empty entry (the root) or a relative one (`tools`).
		fs.renameSync(path.join(otherRepo, "node_modules", ".bin", "biome"), path.join(otherRepo, "biome"));
		fs.mkdirSync(path.join(otherRepo, "tools"));
		fs.copyFileSync(path.join(otherRepo, "biome"), path.join(otherRepo, "tools", "biome"));
		fs.chmodSync(path.join(otherRepo, "tools", "biome"), 0o755);
		const target = write(path.join(otherRepo, "x.ts"), "export const x = 1;\n");
		const biome: ServerConfig = {
			command: "biome",
			fileTypes: [".ts"],
			rootMarkers: ["biome.json"],
			isLinter: true,
			createClient: BiomeClient.create,
		};
		const originalPath = process.env.PATH;
		onTestFinished(() => {
			process.env.PATH = originalPath;
		});
		const absent = path.join(root, "not-present");
		for (const searchPath of [
			`${path.delimiter}${absent}`,
			`${absent}${path.delimiter}`,
			`${absent}${path.delimiter}tools`,
		]) {
			process.env.PATH = searchPath;
			expect(await getDiagnosticsForFile(target, path.join(root, "session"), [["biome", biome]])).toBeUndefined();
		}

		expect(readLog(log)).toEqual([]);
	}, 20_000);

	it("resolves an explicitly named executable without PATH, and a session's own relative PATH entry", async () => {
		const originalPath = process.env.PATH;
		onTestFinished(() => {
			process.env.PATH = originalPath;
		});
		// An ordinary language server, configured in the session's own lsp.json.
		const session = path.join(root, "session");
		write(path.join(session, "marker"), "");
		fs.mkdirSync(path.join(session, "tools"));
		const server = writeFakeExecutable(path.join(session, "tools"), "review-server", "process.exit(0);\n");
		const resolvedFor = (command: string, searchPath: string) => {
			process.env.PATH = searchPath;
			write(
				path.join(session, "lsp.json"),
				JSON.stringify({ servers: { review: { command, rootMarkers: ["marker"], fileTypes: [".review"] } } }),
			);
			const resolved = loadConfig(session).servers.review?.resolvedCommand;
			return resolved && fs.realpathSync(resolved);
		};
		const intended = fs.realpathSync(server);
		expect(resolvedFor(server, "")).toBe(intended);
		expect(resolvedFor("./tools/review-server", "")).toBe(intended);
		expect(resolvedFor("review-server", `tools${path.delimiter}${path.join(root, "not-present")}`)).toBe(intended);

		// A CLI linter named by its absolute path still runs on its own root's file with an empty PATH.
		const log = path.join(root, "runs.log");
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, "biome.json"), "{}\n");
		const linter = installRecordingBiome(otherRepo, "B", log);
		const target = write(path.join(otherRepo, "x.ts"), "export const x = 1;\n");
		process.env.PATH = "";
		const result = await getDiagnosticsForFile(target, session, [
			[
				"abs",
				{
					command: linter,
					fileTypes: [".ts"],
					rootMarkers: ["biome.json"],
					isLinter: true,
					createClient: BiomeClient.create,
				},
			],
		]);

		expect(result?.messages.join("\n")).toContain("from B");
		expect(readLog(log)).toEqual([{ self: "B", cwd: otherRepo, argv: ["lint", "--reporter=json", target] }]);
	}, 20_000);

	it("serves an LSP linter only files whose own root lies inside the session cwd", () => {
		const cwd = path.join(root, "repo-a");
		write(path.join(cwd, ".eslintrc.json"), "{}\n");
		write(path.join(cwd, "packages", "web", ".eslintrc.json"), "{}\n");
		const otherRepo = path.join(root, "repo-b");
		write(path.join(otherRepo, ".eslintrc.json"), "{}\n");
		const eslint: ServerConfig = {
			command: "eslint-lsp",
			fileTypes: [".ts"],
			rootMarkers: [".eslintrc.json"],
			isLinter: true,
		};
		const tsserver: ServerConfig = { command: "tsserver", fileTypes: [".ts"], rootMarkers: ["tsconfig.json"] };
		const servers: Array<[string, ServerConfig]> = [
			["tsserver", tsserver],
			["eslint", eslint],
		];

		const names = (file: string) => filterLintersForFile(servers, file, cwd).map(([name]) => name);

		expect(names(path.join(cwd, "packages", "web", "src", "a.ts"))).toEqual(["tsserver", "eslint"]);
		expect(names(path.join(otherRepo, "src", "a.ts"))).toEqual(["tsserver"]);
		expect(names(path.join(root, "no-root", "a.ts"))).toEqual(["tsserver"]);
		// A link inside the cwd to the other repository's file is that repository's file.
		const foreign = write(path.join(otherRepo, "src", "b.ts"), "export const b = 1;\n");
		fs.symlinkSync(foreign, path.join(cwd, "packages", "web", "link.ts"));
		expect(names(path.join(cwd, "packages", "web", "link.ts"))).toEqual(["tsserver"]);
	});
});

describe("lint-on-write process lifetime", () => {
	function launcherBiome(): { client: BiomeClient; target: string; pidFile: string } {
		const pidFile = path.join(root, "grandchild.pid");
		const command = installLauncherLinter(root, pidFile);
		const target = write(path.join(root, "a.ts"), "export const a = 1;\n");
		const config: ServerConfig = {
			command: "biome",
			fileTypes: [".ts"],
			rootMarkers: [],
			resolvedCommand: command,
		};
		return { client: new BiomeClient(config, root), target, pidFile };
	}

	it("kills the linter's grandchild when the write's diagnostics are aborted", async () => {
		const { client, target, pidFile } = launcherBiome();
		const controller = new AbortController();
		const linting = client.lint(target, controller.signal);
		const pid = await waitForPid(pidFile);

		controller.abort(new Error("user abort"));

		await expect(linting).rejects.toThrow();
		expect(await aliveAfter(pid)).toBe(false);
	}, 20_000);

	it("kills the linter's grandchild at its deadline when nothing aborts it", async () => {
		const pidFile = path.join(root, "grandchild.pid");
		const command = installLauncherLinter(root, pidFile);
		// 2 s is about 100 times what the grandchild needs to start at a load average
		// of 200 (p90 17 ms); the run's outcome is captured at once, since it may
		// settle before the pid appears.
		const outcome = runLinterCli(command, ["lint"], root, undefined, 2_000).then(
			() => new Error("run finished before its deadline"),
			(error: unknown) => error,
		);
		const pid = await waitForPid(pidFile);

		expect(String(await outcome)).toContain("Timed out");
		expect(await aliveAfter(pid)).toBe(false);
	}, 40_000);

	it("kills the group on abort after its launcher exited while a child still holds the output", async () => {
		const pidFile = path.join(root, "grandchild.pid");
		// The launcher starts a SIGTERM-ignoring child on its own stdout/stderr and exits at once.
		const command = writeFakeExecutable(
			root,
			"exiting-launcher",
			`const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(
				`process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30);`,
			)}], { stdout: "inherit", stderr: "inherit" });
child.unref();
process.exit(0);
`,
		);
		const controller = new AbortController();
		const outcome = runLinterCli(command, ["lint"], root, controller.signal).then(
			() => new Error("run finished without the abort"),
			(error: unknown) => error,
		);
		const pid = await waitForPid(pidFile);
		const abortedAt = Date.now();

		controller.abort(new Error("user abort"));

		expect(String(await outcome)).toContain("user abort");
		// Ended by the abort, not by the 30 s deadline.
		expect(Date.now() - abortedAt).toBeLessThan(10_000);
		expect(await aliveAfter(pid)).toBe(false);
	}, 40_000);

	/**
	 * A launcher that starts a SIGTERM-ignoring child on its own output, then kills
	 * itself with SIGTERM. With `newSession` the child also leaves the launcher's
	 * process group and session, as a daemonizing tool would.
	 */
	function selfSignallingLauncher(pidFile: string, newSession = false): string {
		return writeFakeExecutable(
			root,
			"signalled-launcher",
			`const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(
				`process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30);`,
			)}], { stdout: "inherit", stderr: "inherit", detached: ${newSession} });
child.unref();
setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
setInterval(() => {}, 1 << 30);
`,
		);
	}

	it.skipIf(process.platform !== "linux")(
		"kills a child that left the run's process group and session, once its launcher died",
		async () => {
			const pidFile = path.join(root, "grandchild.pid");
			const command = selfSignallingLauncher(pidFile, true);
			const controller = new AbortController();
			const outcome = runLinterCli(command, ["lint"], root, controller.signal).then(
				() => new Error("run finished without the abort"),
				(error: unknown) => error,
			);
			const pid = await waitForPid(pidFile);

			controller.abort(new Error("user abort"));

			expect(String(await outcome)).toContain("user abort");
			expect(await aliveAfter(pid)).toBe(false);
		},
		40_000,
	);

	it("kills the group on abort after its launcher died from a signal", async () => {
		const pidFile = path.join(root, "grandchild.pid");
		const command = selfSignallingLauncher(pidFile);
		const controller = new AbortController();
		const outcome = runLinterCli(command, ["lint"], root, controller.signal).then(
			() => new Error("run finished without the abort"),
			(error: unknown) => error,
		);
		const pid = await waitForPid(pidFile);
		const abortedAt = Date.now();

		controller.abort(new Error("user abort"));

		expect(String(await outcome)).toContain("user abort");
		expect(Date.now() - abortedAt).toBeLessThan(10_000);
		expect(await aliveAfter(pid)).toBe(false);
	}, 40_000);

	it("kills the group at its deadline after its launcher died from a signal", async () => {
		const pidFile = path.join(root, "grandchild.pid");
		const command = selfSignallingLauncher(pidFile);
		const outcome = runLinterCli(command, ["lint"], root, undefined, 2_000).then(
			() => new Error("run finished before its deadline"),
			(error: unknown) => error,
		);
		const pid = await waitForPid(pidFile);

		expect(String(await outcome)).toContain("Timed out");
		expect(await aliveAfter(pid)).toBe(false);
	}, 40_000);
});

describe("deferred diagnostics on session dispose", () => {
	it("aborts a late fetch begun before its write finalized, and every later one", () => {
		const disposeCallbacks: Array<() => void> = [];
		const session = {
			registerDisposeCallback: (callback: () => void) => {
				disposeCallbacks.push(callback);
			},
		} as unknown as ToolSession;
		const deferred = new DeferredDiagnostics(session);
		const inFlight = deferred.begin(path.join(root, "a.ts"));
		const pending = deferred.begin(path.join(root, "b.ts"));
		pending.finalize(undefined);

		for (const callback of disposeCallbacks) callback();

		expect(inFlight.signal.aborted).toBe(true);
		expect(pending.signal.aborted).toBe(true);
		expect(deferred.begin(path.join(root, "c.ts")).signal.aborted).toBe(true);
	});

	it("does not keep handles whose write never finalized", () => {
		const session = { registerDisposeCallback: () => {} } as unknown as ToolSession;
		const deferred = new DeferredDiagnostics(session);
		const refs: Array<WeakRef<AbortSignal>> = [];
		// A write that throws never calls finalize(); its handle must still be collectable.
		for (let i = 0; i < 50; i++) refs.push(new WeakRef(deferred.begin(path.join(root, `f${i}.ts`)).signal));
		Bun.gc(true);

		expect(refs.filter(ref => ref.deref() !== undefined)).toHaveLength(0);
	});
});
