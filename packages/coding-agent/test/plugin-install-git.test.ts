/**
 * Install-from-git tests for `PluginManager.install`.
 *
 * Strategy: spy on the six `@oh-my-pi/pi-utils` plugin-path getters so the
 * manager points at a temp directory tree, then spy on `Bun.spawn` so we can
 * simulate `bun install <git-spec>`'s side effects (writing the dep into
 * `plugins/package.json` under its real name, and dropping a matching
 * `node_modules/<name>/package.json`). This exercises the real
 * `PluginManager.install` end-to-end without hitting the network.
 *
 * `vi.spyOn` + `vi.restoreAllMocks()` is the same pattern used by
 * `test/tools/report-tool-issue.test.ts` (which spies on
 * `piUtils.getInstallId`), so we know namespace spying on `pi-utils` exports
 * propagates through to consumers of the barrel re-exports. The
 * `vi.spyOn(Bun, "spawn")` mock follows `test/git-process-config.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

function textStream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) {
		throw new Error("Failed to create response stream");
	}
	return body;
}

function emptyStream(): ReadableStream<Uint8Array> {
	const body = new Response("").body;
	if (!body) {
		throw new Error("Failed to create empty response stream");
	}
	return body;
}

async function runCommand(command: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(command, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr}`);
	}
	return stdout.trim();
}

describe("PluginManager.install with git sources", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let pluginsNodeModules: string;
	let pluginsPkgJson: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-git-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		pluginsNodeModules = path.join(pluginsDir, "node_modules");
		pluginsPkgJson = path.join(pluginsDir, "package.json");
		await fs.mkdir(pluginsNodeModules, { recursive: true });

		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(pluginsNodeModules);
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(pluginsPkgJson);
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "omp-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	test("installs from github: shorthand and resolves real package name from deps diff", async () => {
		// Seed the plugins manifest so install()'s `depsBefore` snapshot is empty
		// rather than triggering #ensurePackageJson's bootstrap path.
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2),
		);

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			// Verify the manager forwards the spec verbatim to bun install.
			expect(cmd[0]).toBe("bun");
			expect(cmd[1]).toBe("install");
			expect(cmd[2]).toBe("github:foo/bar");

			// Simulate the on-disk side effects bun install produces for a git
			// source: a new dep keyed by the package's own `name` field, plus
			// the corresponding entry under node_modules.
			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{
							name: "omp-plugins",
							private: true,
							dependencies: { "real-name": "github:foo/bar" },
						},
						null,
						2,
					),
				);
				const installedDir = path.join(pluginsNodeModules, "real-name");
				await fs.mkdir(installedDir, { recursive: true });
				await Bun.write(
					path.join(installedDir, "package.json"),
					JSON.stringify({ name: "real-name", version: "0.1.0" }, null, 2),
				);
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("github:foo/bar");

		expect(result.name).toBe("real-name");
		expect(result.version).toBe("0.1.0");
		expect(result.enabled).toBe(true);
		expect(result.path).toBe(path.join(pluginsNodeModules, "real-name"));
	});

	test("normalizes non-GitHub shorthand before invoking bun install", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2),
		);

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd[0]).toBe("bun");
			expect(cmd[1]).toBe("install");
			expect(cmd[2]).toBe("https://gitlab.com/group/sub/project#v1.0.0");

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{
							name: "omp-plugins",
							private: true,
							dependencies: {
								"gitlab-plugin": "git+https://gitlab.com/group/sub/project.git#v1.0.0",
							},
						},
						null,
						2,
					),
				);
				const installedDir = path.join(pluginsNodeModules, "gitlab-plugin");
				await fs.mkdir(installedDir, { recursive: true });
				await Bun.write(
					path.join(installedDir, "package.json"),
					JSON.stringify({ name: "gitlab-plugin", version: "1.0.0" }, null, 2),
				);
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("gitlab:group/sub/project#v1.0.0");

		expect(result.name).toBe("gitlab-plugin");
		expect(result.version).toBe("1.0.0");
	});

	test("refreshes Bun's git cache before updating a re-installed github plugin (#3063)", async () => {
		// Seed plugins/package.json + node_modules with a previously-installed
		// github plugin. `findGitPackageName` matches the new install spec to
		// this existing dep (by repository identity), which is the signal the
		// manager uses to trigger the lockfile-refresh follow-up.
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify(
				{
					name: "omp-plugins",
					private: true,
					dependencies: { "stale-plugin": "github:foo/bar" },
				},
				null,
				2,
			),
		);
		const seedDir = path.join(pluginsNodeModules, "stale-plugin");
		await fs.mkdir(seedDir, { recursive: true });
		await Bun.write(
			path.join(seedDir, "package.json"),
			JSON.stringify({ name: "stale-plugin", version: "0.1.0" }, null, 2),
		);
		const cacheDir = path.join(tmpRoot, "bun-cache");
		await fs.mkdir(cacheDir);

		const spawnedCommands: string[][] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			spawnedCommands.push([...cmd]);
			if (cmd[1] === "install") {
				// `bun install <same spec>` is a no-op on the lockfile pin —
				// the manager must NOT rely on this call to refresh the commit.
				// Leave package.json and node_modules untouched so the test
				// fails loudly if the manager skips the follow-up `bun update`.
				return {
					pid: 1,
					stdout: emptyStream(),
					stderr: emptyStream(),
					exited: Promise.resolve(0),
				} as Subprocess;
			}
			if (cmd[1] === "pm") {
				const stdout = new Response(`${cacheDir}\n`).body;
				if (!stdout) throw new Error("Failed to create cache path stream");
				return {
					pid: 2,
					stdout,
					stderr: emptyStream(),
					exited: Promise.resolve(0),
				} as Subprocess;
			}
			// The follow-up call: simulate bun resolving the upstream HEAD to a
			// newer commit and bumping the on-disk version. The manager should
			// read the new version from package.json after this step returns.
			expect(cmd).toEqual(["bun", "update", "stale-plugin"]);
			const prepare = (async () => {
				await Bun.write(
					path.join(seedDir, "package.json"),
					JSON.stringify({ name: "stale-plugin", version: "0.1.6" }, null, 2),
				);
			})();
			return {
				pid: 3,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("github:foo/bar");

		expect(result.version).toBe("0.1.6");
		expect(spawnedCommands).toEqual([
			["bun", "install", "github:foo/bar"],
			["bun", "pm", "cache"],
			["bun", "update", "stale-plugin"],
		]);
	});

	test("removes an existing pinned git dependency before installing the unpinned source (#4960)", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify(
				{
					name: "omp-plugins",
					private: true,
					dependencies: { "replaced-plugin": "github:foo/bar#v1.0.0" },
				},
				null,
				2,
			),
		);
		const seedDir = path.join(pluginsNodeModules, "replaced-plugin");
		await fs.mkdir(seedDir, { recursive: true });
		await Bun.write(
			path.join(seedDir, "package.json"),
			JSON.stringify({ name: "replaced-plugin", version: "1.0.0" }, null, 2),
		);

		const spawnedCommands: string[][] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			spawnedCommands.push([...cmd]);
			if (cmd[1] === "install") {
				expect(cmd).toEqual(["bun", "install", "github:foo/bar"]);
				const prepare = (async () => {
					const packageJson = await Bun.file(pluginsPkgJson).json();
					expect(packageJson.dependencies?.["replaced-plugin"]).toBeUndefined();

					await Bun.write(
						pluginsPkgJson,
						JSON.stringify(
							{
								name: "omp-plugins",
								private: true,
								dependencies: { "replaced-plugin": "github:foo/bar" },
							},
							null,
							2,
						),
					);
					await Bun.write(
						path.join(seedDir, "package.json"),
						JSON.stringify({ name: "replaced-plugin", version: "1.1.0" }, null, 2),
					);
				})();
				return {
					pid: 1,
					stdout: emptyStream(),
					stderr: emptyStream(),
					exited: prepare.then(() => 0),
				} as Subprocess;
			}

			if (cmd[1] === "pm") {
				expect(cmd).toEqual(["bun", "pm", "cache"]);
				return {
					pid: 3,
					stdout: textStream(path.join(tmpRoot, "no-such-bun-cache")),
					stderr: emptyStream(),
					exited: Promise.resolve(0),
				} as Subprocess;
			}

			expect(cmd).toEqual(["bun", "update", "replaced-plugin"]);
			return {
				pid: 2,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: Promise.resolve(0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		const mgr = new PluginManager(tmpRoot);
		const result = await mgr.install("github:foo/bar");

		expect(result.name).toBe("replaced-plugin");
		expect(result.version).toBe("1.1.0");
		expect(spawnedCommands[0]).toEqual(["bun", "install", "github:foo/bar"]);
		const packageJson = await Bun.file(pluginsPkgJson).json();
		expect(packageJson.dependencies).toEqual({ "replaced-plugin": "github:foo/bar" });
	});

	test("first-time github install does NOT run `bun update` (no existing pin to refresh)", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2),
		);

		const spawnedCommands: string[][] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			spawnedCommands.push([...cmd]);
			expect(cmd[1]).toBe("install");
			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{
							name: "omp-plugins",
							private: true,
							dependencies: { "fresh-plugin": "github:foo/bar" },
						},
						null,
						2,
					),
				);
				const installedDir = path.join(pluginsNodeModules, "fresh-plugin");
				await fs.mkdir(installedDir, { recursive: true });
				await Bun.write(
					path.join(installedDir, "package.json"),
					JSON.stringify({ name: "fresh-plugin", version: "0.1.6" }, null, 2),
				);
			})();
			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		const mgr = new PluginManager(tmpRoot);
		await mgr.install("github:foo/bar");

		expect(spawnedCommands).toEqual([["bun", "install", "github:foo/bar"]]);
	});

	test("drains stdout/stderr concurrently with proc.exited (pipe-buffer deadlock, #4230)", async () => {
		// Model the OS-pipe semantics that caused the deadlock: `exited` cannot
		// resolve until both pipes have been read. Awaiting install directly is
		// sufficient: the test runner's timeout catches a regression.
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2),
		);

		const makeGatedStream = (payload: string): { stream: ReadableStream<Uint8Array>; drained: Promise<void> } => {
			const { promise: drained, resolve: onDrained } = Promise.withResolvers<void>();
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(new TextEncoder().encode(payload));
					controller.close();
					onDrained();
				},
			});
			return { stream, drained };
		};

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "github:foo/bar"]);
			const { stream: stdout, drained: stdoutDrained } = makeGatedStream("progress\n");
			const { stream: stderr, drained: stderrDrained } = makeGatedStream("");
			const exited = Promise.all([stdoutDrained, stderrDrained]).then(async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{
							name: "omp-plugins",
							private: true,
							dependencies: { "real-name": "github:foo/bar" },
						},
						null,
						2,
					),
				);
				const installedDir = path.join(pluginsNodeModules, "real-name");
				await fs.mkdir(installedDir, { recursive: true });
				await Bun.write(
					path.join(installedDir, "package.json"),
					JSON.stringify({ name: "real-name", version: "0.1.0" }, null, 2),
				);
				return 0;
			});
			return { pid: 1, stdout, stderr, exited } as Subprocess;
		}) as typeof Bun.spawn);

		const mgr = new PluginManager(tmpRoot);
		const installed = await mgr.install("github:foo/bar");
		expect(installed.name).toBe("real-name");
	}, 2000);

	test("refreshes Bun's cached git clone before updating an existing plugin (#5401)", async () => {
		const sourceDir = path.join(tmpRoot, "source");
		const httpRoot = path.join(tmpRoot, "http");
		const remoteDir = path.join(httpRoot, "testuser", "remote.git");
		const cacheDir = path.join(tmpRoot, "bun-cache");
		await fs.mkdir(sourceDir, { recursive: true });
		await fs.mkdir(path.dirname(remoteDir), { recursive: true });
		await runCommand(["git", "init", "-b", "main"], sourceDir);
		await Bun.write(
			path.join(sourceDir, "package.json"),
			JSON.stringify({ name: "@test/pi-package", version: "1.0.0" }, null, 2),
		);
		await runCommand(["git", "add", "package.json"], sourceDir);
		await runCommand(
			[
				"git",
				"-c",
				"user.name=Plugin test",
				"-c",
				"user.email=plugin-test@example.com",
				"commit",
				"-m",
				"version A",
			],
			sourceDir,
		);
		await runCommand(["git", "clone", "--bare", sourceDir, remoteDir], tmpRoot);
		await runCommand(["git", "update-server-info"], remoteDir);

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
				const filePath = path.resolve(httpRoot, relativePath);
				if (!filePath.startsWith(`${httpRoot}${path.sep}`)) {
					return new Response("Not found", { status: 404 });
				}
				try {
					return new Response(await Bun.file(filePath).arrayBuffer(), {
						headers: { "Content-Type": "application/octet-stream" },
					});
				} catch {
					return new Response("Not found", { status: 404 });
				}
			},
		});

		try {
			await Bun.write(
				pluginsPkgJson,
				JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }, null, 2),
			);
			await Bun.write(path.join(pluginsDir, "bunfig.toml"), `[install.cache]\ndir = ${JSON.stringify(cacheDir)}\n`);
			const spec = `git+http://127.0.0.1:${server.port}/testuser/remote.git#main`;
			const mgr = new PluginManager(tmpRoot);
			expect((await mgr.install(spec)).version).toBe("1.0.0");

			await Bun.write(
				path.join(sourceDir, "package.json"),
				JSON.stringify({ name: "@test/pi-package", version: "2.0.0" }, null, 2),
			);
			await runCommand(["git", "add", "package.json"], sourceDir);
			await runCommand(
				[
					"git",
					"-c",
					"user.name=Plugin test",
					"-c",
					"user.email=plugin-test@example.com",
					"commit",
					"-m",
					"version B",
				],
				sourceDir,
			);
			await runCommand(["git", "push", remoteDir, "main"], sourceDir);
			await runCommand(["git", "update-server-info"], remoteDir);

			const reinstalled = await mgr.install(spec);
			expect(reinstalled.version).toBe("2.0.0");
		} finally {
			await server.stop(true);
		}
	});

	test("rejects git specs containing shell metacharacters", async () => {
		const mgr = new PluginManager(tmpRoot);
		await expect(mgr.install("github:foo/bar; rm -rf /")).rejects.toThrow(/Invalid characters in plugin source/);
	});

	test("still rejects invalid npm names with the original error", async () => {
		const mgr = new PluginManager(tmpRoot);
		await expect(mgr.install("Invalid Name With Spaces")).rejects.toThrow(/Invalid (package name|characters)/);
	});
});
