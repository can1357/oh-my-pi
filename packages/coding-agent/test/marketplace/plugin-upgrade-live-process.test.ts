import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listClaudePluginRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	MarketplaceManager,
	readInstalledPluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import {
	leaseCacheEntry,
	removeCacheEntryUnlessLeased,
	sweepRetiredCacheEntries,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/cache-lease";
import { processStartToken, removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const HELPERS = path.resolve(import.meta.dir, "../../src/discovery/helpers.ts");

/**
 * A running omp process holds the paths of the plugin version it loaded: skill files, the skill
 * directories the model was told about, hook and MCP server scripts. `omp plugin upgrade` in another
 * process must not delete that version under it.
 */
describe("a plugin upgrade under another running omp process", () => {
	let tmpDir = "";
	let home = "";
	let marketplaceDir = "";
	let manager: MarketplaceManager;
	const children: Bun.Subprocess[] = [];

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-upgrade-live-"));
		home = path.join(tmpDir, "home");
		marketplaceDir = path.join(tmpDir, "marketplace");
		manager = new MarketplaceManager({
			marketplacesRegistryPath: path.join(tmpDir, "marketplaces.json"),
			installedRegistryPath: path.join(pluginsDir(), "installed_plugins.json"),
			marketplacesCacheDir: path.join(pluginsDir(), "cache", "marketplaces"),
			pluginsCacheDir: cacheDir(),
		});
	});

	afterEach(async () => {
		for (const child of children.splice(0)) {
			child.kill("SIGKILL");
			await child.exited;
		}
		removeSyncWithRetries(tmpDir);
	});

	function pluginsDir(): string {
		return path.join(home, ".omp", "plugins");
	}

	function cacheDir(): string {
		return path.join(pluginsDir(), "cache", "plugins");
	}

	function versionDir(plugin: string, version: string): string {
		return path.join(cacheDir(), `mkt___${plugin}___${version}`);
	}

	/** A local marketplace with plugin `demo` at `version` and plugin `other`, each with a skill. */
	function writeMarketplace(version: string): void {
		fs.mkdirSync(path.join(marketplaceDir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(marketplaceDir, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				name: "mkt",
				owner: { name: "Test" },
				plugins: [
					{ name: "demo", source: "./plugins/demo", version },
					{ name: "other", source: "./plugins/other", version: "1.0.0" },
				],
			}),
		);
		for (const [plugin, pluginVersion] of [
			["demo", version],
			["other", "1.0.0"],
		]) {
			const skillDir = path.join(marketplaceDir, "plugins", plugin, "skills", "demo-skill");
			fs.mkdirSync(skillDir, { recursive: true });
			fs.writeFileSync(
				path.join(skillDir, "SKILL.md"),
				`---\nname: demo-skill\ndescription: Skill of ${plugin}.\n---\n\n${plugin} ${pluginVersion}\n`,
			);
		}
	}

	async function installDemo(): Promise<void> {
		writeMarketplace("1.0.0");
		await manager.addMarketplace(marketplaceDir);
		await manager.installPlugin("demo", "mkt");
	}

	async function upgradeDemo(): Promise<void> {
		writeMarketplace("2.0.0");
		await manager.updateMarketplace("mkt");
		await manager.upgradePlugin("demo@mkt");
	}

	/** Another omp process that read the plugin registries, as every session does at startup. */
	async function startHolder(): Promise<Bun.Subprocess<"pipe", "pipe", "inherit">> {
		const script = path.join(tmpDir, "holder.ts");
		fs.writeFileSync(
			script,
			[
				"const [helpers, home] = process.argv.slice(2);",
				"const { listClaudePluginRoots } = await import(helpers);",
				"await listClaudePluginRoots(home);",
				'console.log("ready");',
				// Runs until the test kills it.
				"await Bun.stdin.stream().getReader().read();",
			].join("\n"),
		);
		const child = Bun.spawn([process.execPath, script, HELPERS, home], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		children.push(child);
		const reader = child.stdout.getReader();
		let output = "";
		while (!output.includes("ready")) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`holder exited before it read the registries: ${output}`);
			output += new TextDecoder().decode(value);
		}
		reader.releaseLock();
		return child;
	}

	it("keeps the version a running process loaded, and deletes it after that process is gone", async () => {
		await installDemo();
		const holder = await startHolder();

		await upgradeDemo();

		expect(
			fs.readFileSync(path.join(versionDir("demo", "1.0.0"), "skills", "demo-skill", "SKILL.md"), "utf8"),
		).toContain("demo 1.0.0");
		expect(fs.existsSync(versionDir("demo", "2.0.0"))).toBe(true);

		// A crash leaves its lease behind; the lease of a dead process does not count.
		holder.kill("SIGKILL");
		await holder.exited;
		await manager.sweepRetiredPluginVersions();

		expect(fs.existsSync(versionDir("demo", "1.0.0"))).toBe(false);
		expect(fs.existsSync(versionDir("demo", "2.0.0"))).toBe(true);
	}, 120_000);

	it("deletes the old version at once when no running process uses it", async () => {
		await installDemo();

		await upgradeDemo();

		expect(fs.existsSync(versionDir("demo", "1.0.0"))).toBe(false);
		expect(fs.existsSync(versionDir("demo", "2.0.0"))).toBe(true);
	}, 120_000);

	it("a reinstall of the same version leaves the copy a running process loaded untouched", async () => {
		await installDemo();
		const holder = await startHolder();
		const loadedSkill = path.join(versionDir("demo", "1.0.0"), "skills", "demo-skill", "SKILL.md");
		fs.writeFileSync(
			path.join(marketplaceDir, "plugins", "demo", "skills", "demo-skill", "SKILL.md"),
			"---\nname: demo-skill\ndescription: Skill of demo.\n---\n\nrebuilt 1.0.0\n",
		);

		await manager.upgradePlugin("demo@mkt");

		const registry = await readInstalledPluginsRegistry(path.join(pluginsDir(), "installed_plugins.json"));
		const reinstalled = registry.plugins["demo@mkt"][0].installPath;
		expect(reinstalled).toBe(`${versionDir("demo", "1.0.0")}___2`);
		expect(fs.readFileSync(loadedSkill, "utf8")).toContain("demo 1.0.0");
		expect(fs.readFileSync(path.join(reinstalled, "skills", "demo-skill", "SKILL.md"), "utf8")).toContain(
			"rebuilt 1.0.0",
		);

		holder.kill("SIGKILL");
		await holder.exited;
		await manager.sweepRetiredPluginVersions();

		expect(fs.existsSync(versionDir("demo", "1.0.0"))).toBe(false);
		expect(fs.existsSync(reinstalled)).toBe(true);
	}, 120_000);

	it("keeps the upgraded plugin's place in the registry, so a same-named skill keeps its name", async () => {
		await installDemo();
		await manager.installPlugin("other", "mkt");

		await upgradeDemo();

		const registry = await readInstalledPluginsRegistry(path.join(pluginsDir(), "installed_plugins.json"));
		expect(Object.keys(registry.plugins)).toEqual(["demo@mkt", "other@mkt"]);
		expect(registry.plugins["demo@mkt"]).toHaveLength(1);
		expect(registry.plugins["demo@mkt"][0].installPath).toBe(versionDir("demo", "2.0.0"));
	}, 120_000);

	it("a process that reads the registries leases what they name, and no directory that is gone", async () => {
		await installDemo();
		await manager.installPlugin("other", "mkt");
		removeSyncWithRetries(versionDir("other", "1.0.0"));

		await listClaudePluginRoots(home);

		const leases = path.join(pluginsDir(), "cache", "plugin-leases");
		const ownLease = `${process.pid}-${Bun.hash((await processStartToken(process.pid))!).toString(36)}`;
		expect(fs.readdirSync(path.join(leases, "mkt___demo___1.0.0"))).toEqual([ownLease]);
		expect(fs.existsSync(path.join(leases, "mkt___other___1.0.0"))).toBe(false);
	}, 120_000);
});

describe("plugin cache leases", () => {
	let tmpDir = "";
	let cacheDir = "";
	let entry = "";
	let leaseDir = "";

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cache-lease-"));
		cacheDir = path.join(tmpDir, "cache", "plugins");
		entry = path.join(cacheDir, "mkt___demo___1.0.0");
		leaseDir = path.join(tmpDir, "cache", "plugin-leases", "mkt___demo___1.0.0");
		fs.mkdirSync(path.join(entry, "skills"), { recursive: true });
		fs.mkdirSync(leaseDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tmpDir);
	});

	async function deadPid(): Promise<number> {
		const child = Bun.spawn(["true"]);
		await child.exited;
		return child.pid;
	}

	it("does not count the lease of a dead process or of a process that reuses its pid", async () => {
		fs.writeFileSync(path.join(leaseDir, `${await deadPid()}-0`), "");
		// This process is alive, but its start time does not match the lease's.
		fs.writeFileSync(path.join(leaseDir, `${process.pid}-notmine`), "");

		expect(await removeCacheEntryUnlessLeased(entry)).toBe(true);
		expect(fs.existsSync(entry)).toBe(false);
		expect(fs.existsSync(leaseDir)).toBe(false);
	});

	function ownLeaseName(token: string | null): string {
		return `${process.pid}-${token === null ? "0" : Bun.hash(token).toString(36)}`;
	}

	it("a live lease survives two removals at once", async () => {
		const lease = path.join(leaseDir, ownLeaseName(await processStartToken(process.pid)));
		fs.writeFileSync(lease, "");

		const removed = await Promise.all([removeCacheEntryUnlessLeased(entry), removeCacheEntryUnlessLeased(entry)]);

		expect(removed).toEqual([false, false]);
		expect(fs.existsSync(path.join(entry, "skills"))).toBe(true);
		expect(fs.existsSync(lease)).toBe(true);
		expect(fs.existsSync(path.join(leaseDir, "retired"))).toBe(true);
	});

	it("a lease taken while two removals run either keeps the entry or finds it gone and is not kept", async () => {
		const token = await processStartToken(process.pid);
		for (let round = 0; round < 20; round++) {
			const roundEntry = path.join(cacheDir, `mkt___race___1.0.${round}`);
			const roundLeases = path.join(tmpDir, "cache", "plugin-leases", `mkt___race___1.0.${round}`);
			fs.mkdirSync(path.join(roundEntry, "skills"), { recursive: true });

			const [, , present] = await Promise.all([
				removeCacheEntryUnlessLeased(roundEntry),
				removeCacheEntryUnlessLeased(roundEntry),
				leaseCacheEntry(roundEntry),
			]);

			if (present) {
				expect(fs.existsSync(path.join(roundEntry, "skills"))).toBe(true);
				expect(fs.existsSync(path.join(roundLeases, ownLeaseName(token)))).toBe(true);
			} else {
				expect(fs.existsSync(roundEntry)).toBe(false);
				expect(fs.existsSync(path.join(roundLeases, ownLeaseName(token)))).toBe(false);
			}
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps the entry when its lease directory cannot be written",
		async () => {
			fs.chmodSync(leaseDir, 0o500);
			try {
				expect(await removeCacheEntryUnlessLeased(entry)).toBe(false);
				expect(fs.existsSync(path.join(entry, "skills"))).toBe(true);
			} finally {
				fs.chmodSync(leaseDir, 0o700);
			}
		},
	);

	it("an install leases its new entry before it exists, so a sweep of a retired entry by that name keeps it", async () => {
		const fresh = path.join(cacheDir, "mkt___demo___2.0.0");
		const freshLeases = path.join(tmpDir, "cache", "plugin-leases", "mkt___demo___2.0.0");
		fs.mkdirSync(freshLeases, { recursive: true });
		fs.writeFileSync(path.join(freshLeases, "retired"), "");

		expect(await leaseCacheEntry(fresh, { forInstall: true })).toBe(false);
		fs.mkdirSync(fresh);
		await sweepRetiredCacheEntries(cacheDir, () => false);

		expect(fs.existsSync(fresh)).toBe(true);
	});

	it("sweeps a retired entry once unleased, keeps one a registry names again, and clears a dead removal", async () => {
		fs.writeFileSync(path.join(leaseDir, "retired"), "");
		const aside = path.join(cacheDir, `.mkt___demo___0.9.0.removing-${await deadPid()}-abc`);
		fs.mkdirSync(aside);

		await sweepRetiredCacheEntries(cacheDir, entryPath => entryPath === entry);
		expect(fs.existsSync(entry)).toBe(true);
		expect(fs.existsSync(path.join(leaseDir, "retired"))).toBe(false);
		expect(fs.existsSync(aside)).toBe(false);

		fs.writeFileSync(path.join(leaseDir, "retired"), "");
		await sweepRetiredCacheEntries(cacheDir, () => false);
		expect(fs.existsSync(entry)).toBe(false);
	});
});
