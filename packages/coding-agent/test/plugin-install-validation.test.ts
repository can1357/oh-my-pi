import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

function emptyStream(): ReadableStream<Uint8Array> {
	const body = new Response("").body;
	if (!body) {
		throw new Error("Failed to create empty response stream");
	}
	return body;
}

/**
 * Mock response for the `bun pm cache` probe the manager runs before a git
 * re-install (refreshBunGitCache). Points at a nonexistent directory so the
 * cache refresh is a no-op.
 */
function pmCacheSubprocess(tmpRoot: string, cmd: string[]): Subprocess {
	expect(cmd).toEqual(["bun", "pm", "cache"]);
	const body = new Response(path.join(tmpRoot, "no-such-bun-cache")).body;
	if (!body) {
		throw new Error("Failed to create response stream");
	}
	return {
		pid: 3,
		stdout: body,
		stderr: emptyStream(),
		exited: Promise.resolve(0),
	} as Subprocess;
}

interface PluginFixture {
	readonly version: string;
	readonly source: string;
	readonly dependencyVersion?: string;
	readonly peerDependencies?: Record<string, string>;
}

async function writePluginPackage(pluginsNodeModules: string, name: string, fixture: PluginFixture): Promise<string> {
	const installedDir = path.join(pluginsNodeModules, name);
	await fs.mkdir(path.join(installedDir, "dist"), { recursive: true });
	await Bun.write(
		path.join(installedDir, "package.json"),
		JSON.stringify(
			{
				name,
				version: fixture.version,
				...(fixture.peerDependencies ? { peerDependencies: fixture.peerDependencies } : {}),
				omp: { extensions: ["./dist/extension.ts"] },
			},
			null,
			2,
		),
	);
	await Bun.write(path.join(installedDir, "dist", "extension.ts"), fixture.source);
	return installedDir;
}

describe("PluginManager.install load validation", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let pluginsNodeModules: string;
	let pluginsPkgJson: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-validation-"));
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

	test("installs npm protocol specs with the resolved package name", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "npm:pi-figma-remote-auth"]);

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{
							name: "omp-plugins",
							private: true,
							dependencies: { "pi-figma-remote-auth": "npm:pi-figma-remote-auth" },
						},
						null,
						2,
					),
				);
				await writePluginPackage(pluginsNodeModules, "pi-figma-remote-auth", {
					version: "1.2.3",
					source:
						'export default function(pi) { pi.registerCommand("figma-auth", { handler: async () => {} }); }\n',
				});
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		const result = await new PluginManager(tmpRoot).install("npm:pi-figma-remote-auth");

		expect(result.name).toBe("pi-figma-remote-auth");
		expect(result.version).toBe("1.2.3");
		expect(result.path).toBe(path.join(pluginsNodeModules, "pi-figma-remote-auth"));
	});

	test("rejects and rolls back an install when the extension factory throws", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "factory-failure-plugin"]);

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{
							name: "omp-plugins",
							private: true,
							dependencies: { "factory-failure-plugin": "1.0.0" },
						},
						null,
						2,
					),
				);
				await writePluginPackage(pluginsNodeModules, "factory-failure-plugin", {
					version: "1.0.0",
					source: 'export default function() { throw new Error("factory-time failure"); }\n',
				});
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("factory-failure-plugin")).rejects.toThrow(
			/factory-time failure/,
		);

		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies ?? {}).toEqual({});
		expect(await Bun.file(path.join(pluginsNodeModules, "factory-failure-plugin", "package.json")).exists()).toBe(
			false,
		);
	});

	test("rejects an install whose extension entry cannot resolve its dependencies", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "broken-plugin"]);

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{ name: "omp-plugins", private: true, dependencies: { "broken-plugin": "1.0.0" } },
						null,
						2,
					),
				);
				await writePluginPackage(pluginsNodeModules, "broken-plugin", {
					version: "1.0.0",
					peerDependencies: { "missing-peer": "^1.0.0" },
					source:
						'import { missing } from "missing-peer";\nexport default function(pi) { pi.registerCommand(String(missing), { handler: async () => {} }); }\n',
				});
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("broken-plugin")).rejects.toThrow(/missing-peer/);

		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies ?? {}).toEqual({});
		expect(await Bun.file(path.join(pluginsNodeModules, "broken-plugin", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).exists()).toBe(false);
	});

	test("restores the previous package tree when reinstall validation fails", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "broken-plugin": "1.0.0" } }, null, 2),
		);
		await Bun.write(
			path.join(tmpRoot, "omp-plugins.lock.json"),
			JSON.stringify(
				{ plugins: { "broken-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true } }, settings: {} },
				null,
				2,
			),
		);
		await writePluginPackage(pluginsNodeModules, "broken-plugin", {
			version: "1.0.0",
			source: 'export default function(pi) { pi.registerCommand("old-ok", { handler: async () => {} }); }\n',
		});

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "broken-plugin"]);

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{ name: "omp-plugins", private: true, dependencies: { "broken-plugin": "2.0.0" } },
						null,
						2,
					),
				);
				await writePluginPackage(pluginsNodeModules, "broken-plugin", {
					version: "2.0.0",
					peerDependencies: { "missing-peer": "^1.0.0" },
					source:
						'import { missing } from "missing-peer";\nexport default function(pi) { pi.registerCommand(String(missing), { handler: async () => {} }); }\n',
				});
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("broken-plugin")).rejects.toThrow(/missing-peer/);

		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies).toEqual({ "broken-plugin": "1.0.0" });
		const restoredPackage = await Bun.file(path.join(pluginsNodeModules, "broken-plugin", "package.json")).json();
		expect(restoredPackage.version).toBe("1.0.0");
		const restoredExtension = await Bun.file(
			path.join(pluginsNodeModules, "broken-plugin", "dist", "extension.ts"),
		).text();
		expect(restoredExtension).toContain("old-ok");
		expect(restoredExtension).not.toContain("missing-peer");
		const lock = await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).json();
		expect(lock.plugins["broken-plugin"]).toEqual({ version: "1.0.0", enabledFeatures: null, enabled: true });
	});

	test("restores the previous git plugin tree when reinstalling a different ref fails validation", async () => {
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify(
				{ name: "omp-plugins", private: true, dependencies: { "git-plugin": "github:org/plugin#v1" } },
				null,
				2,
			),
		);
		await Bun.write(
			path.join(tmpRoot, "omp-plugins.lock.json"),
			JSON.stringify(
				{ plugins: { "git-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true } }, settings: {} },
				null,
				2,
			),
		);
		await writePluginPackage(pluginsNodeModules, "git-plugin", {
			version: "1.0.0",
			source: 'export default function(pi) { pi.registerCommand("git-old-ok", { handler: async () => {} }); }\n',
		});

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			if (cmd[1] === "install") {
				expect(cmd).toEqual(["bun", "install", "github:org/plugin#v2"]);

				const prepare = (async () => {
					await Bun.write(
						pluginsPkgJson,
						JSON.stringify(
							{ name: "omp-plugins", private: true, dependencies: { "git-plugin": "github:org/plugin#v2" } },
							null,
							2,
						),
					);
					await writePluginPackage(pluginsNodeModules, "git-plugin", {
						version: "2.0.0",
						peerDependencies: { "missing-peer": "^1.0.0" },
						source:
							'import { missing } from "missing-peer";\nexport default function(pi) { pi.registerCommand(String(missing), { handler: async () => {} }); }\n',
					});
				})();

				return {
					pid: 1,
					stdout: emptyStream(),
					stderr: emptyStream(),
					exited: prepare.then(() => 0),
				} as Subprocess;
			}
			if (cmd[1] === "pm") return pmCacheSubprocess(tmpRoot, cmd);
			// The manager follows a git re-install with `bun update <name>` to refresh
			// the lockfile pin (#3063). The mock treats it as a no-op exit-0 — the
			// on-disk state already reflects the v2 install above.
			expect(cmd).toEqual(["bun", "update", "git-plugin"]);
			return {
				pid: 2,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: Promise.resolve(0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("github:org/plugin#v2")).rejects.toThrow(/missing-peer/);

		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies).toEqual({ "git-plugin": "github:org/plugin#v1" });
		const restoredPackage = await Bun.file(path.join(pluginsNodeModules, "git-plugin", "package.json")).json();
		expect(restoredPackage.version).toBe("1.0.0");
		const restoredExtension = await Bun.file(
			path.join(pluginsNodeModules, "git-plugin", "dist", "extension.ts"),
		).text();
		expect(restoredExtension).toContain("git-old-ok");
		expect(restoredExtension).not.toContain("missing-peer");
		const lock = await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).json();
		expect(lock.plugins["git-plugin"]).toEqual({ version: "1.0.0", enabledFeatures: null, enabled: true });
	});

	test("rejects an install whose manifest declares a missing extension entry", async () => {
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "partial-plugin"]);

			const prepare = (async () => {
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{ name: "omp-plugins", private: true, dependencies: { "partial-plugin": "1.0.0" } },
						null,
						2,
					),
				);
				const installedDir = path.join(pluginsNodeModules, "partial-plugin");
				await fs.mkdir(path.join(installedDir, "dist"), { recursive: true });
				await Bun.write(
					path.join(installedDir, "package.json"),
					JSON.stringify(
						{
							name: "partial-plugin",
							version: "1.0.0",
							omp: { extensions: ["./dist/valid.ts", "./dist/missing.ts"] },
						},
						null,
						2,
					),
				);
				await Bun.write(
					path.join(installedDir, "dist", "valid.ts"),
					'export default function(pi) { pi.registerCommand("valid-ext", { handler: async () => {} }); }\n',
				);
			})();

			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("partial-plugin")).rejects.toThrow(/dist\/missing\.ts/);

		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies ?? {}).toEqual({});
		expect(await Bun.file(path.join(pluginsNodeModules, "partial-plugin", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).exists()).toBe(false);
	});

	test("restores bun.lock when a git reinstall fails validation (#3069 follow-up)", async () => {
		// Pre-existing valid v1 install plus a populated bun.lock pinning the
		// original commit. The mock simulates `bun install` rewriting the lock
		// to a new pin, then `bun update` rewriting it to a NEWER pin (the case
		// the reviewer flagged: bun update mutates bun.lock before validation).
		// Extension validation then fails and the rollback must restore the
		// ORIGINAL pin — not the install-time pin, not the update-time pin.
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify(
				{ name: "omp-plugins", private: true, dependencies: { "git-plugin": "github:org/plugin#v1" } },
				null,
				2,
			),
		);
		const bunLockPath = path.join(pluginsDir, "bun.lock");
		const ORIGINAL_LOCK = '# bun.lock\n"git-plugin": "github:org/plugin#sha-v1"\n';
		await Bun.write(bunLockPath, ORIGINAL_LOCK);
		await Bun.write(
			path.join(tmpRoot, "omp-plugins.lock.json"),
			JSON.stringify(
				{ plugins: { "git-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true } }, settings: {} },
				null,
				2,
			),
		);
		await writePluginPackage(pluginsNodeModules, "git-plugin", {
			version: "1.0.0",
			source: 'export default function(pi) { pi.registerCommand("git-old-ok", { handler: async () => {} }); }\n',
		});

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			if (cmd[1] === "install") {
				const prepare = (async () => {
					// bun install rewrites the lockfile to a stale-but-different pin
					// and stages the broken v2 tree.
					await Bun.write(bunLockPath, '# bun.lock\n"git-plugin": "github:org/plugin#sha-install"\n');
					await Bun.write(
						pluginsPkgJson,
						JSON.stringify(
							{ name: "omp-plugins", private: true, dependencies: { "git-plugin": "github:org/plugin" } },
							null,
							2,
						),
					);
					await writePluginPackage(pluginsNodeModules, "git-plugin", {
						version: "2.0.0",
						peerDependencies: { "missing-peer": "^1.0.0" },
						source:
							'import { missing } from "missing-peer";\nexport default function(pi) { pi.registerCommand(String(missing), { handler: async () => {} }); }\n',
					});
				})();
				return {
					pid: 1,
					stdout: emptyStream(),
					stderr: emptyStream(),
					exited: prepare.then(() => 0),
				} as Subprocess;
			}
			if (cmd[1] === "pm") return pmCacheSubprocess(tmpRoot, cmd);
			expect(cmd).toEqual(["bun", "update", "git-plugin"]);
			const prepare = (async () => {
				// bun update re-resolves the ref and rewrites the lockfile pin
				// AGAIN. Without bun.lock snapshotting this pin would survive
				// the validation failure below.
				await Bun.write(bunLockPath, '# bun.lock\n"git-plugin": "github:org/plugin#sha-update"\n');
			})();
			return {
				pid: 2,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("github:org/plugin")).rejects.toThrow(/missing-peer/);

		expect(await Bun.file(bunLockPath).text()).toBe(ORIGINAL_LOCK);
		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies).toEqual({ "git-plugin": "github:org/plugin#v1" });
		const restoredPackage = await Bun.file(path.join(pluginsNodeModules, "git-plugin", "package.json")).json();
		expect(restoredPackage.version).toBe("1.0.0");
	});

	test("removes bun.lock on rollback when it did not exist before install", async () => {
		// First-time install of a broken plugin: bun install creates bun.lock,
		// extension validation fails, rollback must remove the newly-created
		// lockfile so the next install starts clean.
		const bunLockPath = path.join(pluginsDir, "bun.lock");
		expect(await Bun.file(bunLockPath).exists()).toBe(false);

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			expect(cmd).toEqual(["bun", "install", "broken-plugin"]);
			const prepare = (async () => {
				await Bun.write(bunLockPath, '# bun.lock\n"broken-plugin": "1.0.0"\n');
				await Bun.write(
					pluginsPkgJson,
					JSON.stringify(
						{ name: "omp-plugins", private: true, dependencies: { "broken-plugin": "1.0.0" } },
						null,
						2,
					),
				);
				await writePluginPackage(pluginsNodeModules, "broken-plugin", {
					version: "1.0.0",
					peerDependencies: { "missing-peer": "^1.0.0" },
					source:
						'import { missing } from "missing-peer";\nexport default function(pi) { pi.registerCommand(String(missing), { handler: async () => {} }); }\n',
				});
			})();
			return {
				pid: 1,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("broken-plugin")).rejects.toThrow(/missing-peer/);

		expect(await Bun.file(bunLockPath).exists()).toBe(false);
	});

	test("rolls back when an unknown feature is requested after a git reinstall", async () => {
		// Feature validation lives between bun install/update and extension
		// validation. Pre-#3069-followup it threw outside the rollback block,
		// so an unknown feature would leave the rejected commit + lockfile pin
		// in place. Now it must roll back everything.
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify(
				{ name: "omp-plugins", private: true, dependencies: { "git-plugin": "github:org/plugin" } },
				null,
				2,
			),
		);
		const bunLockPath = path.join(pluginsDir, "bun.lock");
		const ORIGINAL_LOCK = '# bun.lock\n"git-plugin": "github:org/plugin#sha-v1"\n';
		await Bun.write(bunLockPath, ORIGINAL_LOCK);
		await writePluginPackage(pluginsNodeModules, "git-plugin", {
			version: "1.0.0",
			source: 'export default function(pi) { pi.registerCommand("git-old-ok", { handler: async () => {} }); }\n',
		});
		// The seeded manifest declares one feature `keep`; user will request
		// the unknown feature `ghost` instead.
		await Bun.write(
			path.join(pluginsNodeModules, "git-plugin", "package.json"),
			JSON.stringify(
				{
					name: "git-plugin",
					version: "1.0.0",
					omp: {
						extensions: ["./dist/extension.ts"],
						features: { keep: { description: "keep me" } },
					},
				},
				null,
				2,
			),
		);

		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			if (cmd[1] === "install") {
				const prepare = (async () => {
					await Bun.write(bunLockPath, '# bun.lock\n"git-plugin": "github:org/plugin#sha-install"\n');
				})();
				return {
					pid: 1,
					stdout: emptyStream(),
					stderr: emptyStream(),
					exited: prepare.then(() => 0),
				} as Subprocess;
			}
			if (cmd[1] === "pm") return pmCacheSubprocess(tmpRoot, cmd);
			expect(cmd).toEqual(["bun", "update", "git-plugin"]);
			const prepare = (async () => {
				await Bun.write(bunLockPath, '# bun.lock\n"git-plugin": "github:org/plugin#sha-update"\n');
			})();
			return {
				pid: 2,
				stdout: emptyStream(),
				stderr: emptyStream(),
				exited: prepare.then(() => 0),
			} as Subprocess;
		}) as typeof Bun.spawn);

		await expect(new PluginManager(tmpRoot).install("github:org/plugin[ghost]")).rejects.toThrow(/Unknown feature/);

		expect(await Bun.file(bunLockPath).text()).toBe(ORIGINAL_LOCK);
		const pluginsPackage = await Bun.file(pluginsPkgJson).json();
		expect(pluginsPackage.dependencies).toEqual({ "git-plugin": "github:org/plugin" });
	});
});
