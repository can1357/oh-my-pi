import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, readFile } from "@oh-my-pi/pi-coding-agent/capability/fs";

const isWindows = process.platform === "win32";

describe("capability/fs readFile on special files", () => {
	let dir = "";

	beforeAll(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-fs-special-"));
	});

	afterAll(async () => {
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	// Contract: discovery scans foreign config dirs (~/.claude, ~/.cursor,
	// project trees). A FIFO/socket dropped where a context file is expected
	// must yield null instead of blocking startup forever on a read that can
	// never see EOF.
	it.skipIf(isWindows)("returns null for a FIFO instead of blocking", async () => {
		const fifo = path.join(dir, "CLAUDE.md");
		const made = Bun.spawnSync(["mkfifo", fifo]);
		expect(made.exitCode).toBe(0);
		clearCache();
		// Real-clock race on purpose: a regressed readFile blocks inside a
		// kernel read() on the FIFO — there is no promise or event to await and
		// fake timers cannot advance a syscall. The sleep only bounds the
		// failure; the passing path returns immediately.
		const result = await Promise.race([readFile(fifo), Bun.sleep(1500).then(() => "HUNG" as const)]);
		if (result === "HUNG") {
			// Regression path: unblock the leaked FIFO reader so the test
			// process can exit, then fail on the assertion below.
			fs.closeSync(fs.openSync(fifo, "w"));
		}
		expect(result).toBeNull();
	});

	it.skipIf(isWindows)(
		"skips FIFO manifests through classification, plugin-dir naming and update checks",
		async () => {
			const root = path.join(dir, "plugin");
			await fs.promises.mkdir(root);
			const fifo = path.join(root, "plugin.json");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
			await Bun.write(
				path.join(dir, ".omp-plugin", "marketplace.json"),
				JSON.stringify({
					name: "fifo-market",
					owner: { name: "test" },
					plugins: [{ name: "plugin", source: "./plugin", version: "1.0.0" }],
				}),
			);
			await Bun.write(
				path.join(dir, "installed.json"),
				JSON.stringify({
					version: 2,
					plugins: {
						"plugin@fifo-market": [{ scope: "user", installPath: root, version: "1.0.0", enabled: true }],
					},
				}),
			);
			// A regressed synchronous FIFO read blocks the event loop. Isolate it
			// in a killable child; fake timers cannot interrupt a kernel read.
			const moduleUrl = new URL("../../src/discovery/agent-plugin-format.ts", import.meta.url).href;
			const helpersUrl = new URL("../../src/discovery/helpers.ts", import.meta.url).href;
			const managerUrl = new URL("../../src/extensibility/plugins/marketplace/manager.ts", import.meta.url).href;
			const child = Bun.spawn(
				[
					process.execPath,
					"--eval",
					`import { classifyAgentPluginRoot, readAgentPluginRootStatus, readAgentPluginRootStatusSync } from ${JSON.stringify(moduleUrl)};
				import { injectPluginDirRoots, listClaudePluginRoots } from ${JSON.stringify(helpersUrl)};
				import { MarketplaceManager } from ${JSON.stringify(managerUrl)};
				const root = ${JSON.stringify(root)};
				const dir = ${JSON.stringify(dir)};
				const statuses = [
					await classifyAgentPluginRoot(root),
					await readAgentPluginRootStatus(root),
					readAgentPluginRootStatusSync(root),
				];
				await injectPluginDirRoots(dir, [root], dir);
				const { roots } = await listClaudePluginRoots(dir, dir);
				const manager = new MarketplaceManager({
					marketplacesRegistryPath: dir + "/marketplaces.json",
					installedRegistryPath: dir + "/installed.json",
					marketplacesCacheDir: dir + "/marketplaces",
					pluginsCacheDir: dir + "/cache",
				});
				await manager.addMarketplace(dir);
				console.log(JSON.stringify({
					statuses,
					name: roots.find(item => item.path === root)?.plugin,
					updates: await manager.checkForUpdates(),
				}));`,
				],
				{ stdout: "pipe", stderr: "pipe", timeout: 3000, killSignal: "SIGKILL" },
			);
			const [exitCode, output, errors] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: "" });
			expect(JSON.parse(output)).toEqual({
				statuses: [{ kind: "none" }, { kind: "none" }, { kind: "none" }],
				name: "plugin",
				updates: [],
			});
		},
	);

	// Symlinked context files (CLAUDE.md -> AGENTS.md) are common; the type
	// gate must follow links rather than rejecting them.
	it.skipIf(isWindows)("still reads regular files through symlinks", async () => {
		const target = path.join(dir, "AGENTS.md");
		await Bun.write(target, "# context");
		const link = path.join(dir, "CLAUDE-link.md");
		await fs.promises.symlink(target, link);
		clearCache();
		expect(await readFile(link)).toBe("# context");
	});
});
