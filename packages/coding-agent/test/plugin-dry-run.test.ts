/**
 * Regression tests for `--dry-run` on `omp plugin` actions beyond install/uninstall/link.
 *
 * These actions used to accept `--dry-run` and silently apply their change:
 * `upgrade --dry-run` rewrote installed_plugins.json and replaced the plugin's
 * cache directory, and `marketplace update --dry-run` rewrote the catalog cache.
 * `upgrade` now previews what the real command would do; the actions with no
 * preview mode refuse the flag. Either way every file and symlink stays as it was.
 *
 * The fixture is a real local-directory marketplace plugin and a linked local
 * plugin in a temp plugins tree, so the assertions run against the files the CLI writes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PluginCommandArgs, runPluginCommand } from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import Update from "@oh-my-pi/pi-coding-agent/commands/update";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const PLUGIN_ID = "hello@fixmkt";
const LINKED = "lp";
const UPGRADE_PREVIEW = `Would upgrade ${PLUGIN_ID} (user): 1.0.0 -> 2.0.0`;
const CLI_CONFIG: CliConfig = { bin: "omp", version: "0.0.0-test", commands: new Map() };

async function writeMarketplace(dir: string, name: string, version: string | undefined): Promise<void> {
	await Bun.write(
		path.join(dir, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			name,
			owner: { name: "fixture" },
			plugins: [{ name: "hello", source: "./plugins/hello", version, description: "fixture" }],
		}),
	);
	await Bun.write(
		path.join(dir, "plugins", "hello", ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "hello", version, description: "fixture" }),
	);
	await Bun.write(
		path.join(dir, "plugins", "hello", "skills", "hi", "SKILL.md"),
		`---\nname: hi\ndescription: hi ${version}\n---\nhi\n`,
	);
}

/** Every file (bytes) and symlink (target) under `dir`, so any write, delete, new entry or repoint shows up. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
	const snapshot: Record<string, string> = {};
	for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
		const entryPath = path.join(entry.parentPath, entry.name);
		const key = path.relative(dir, entryPath);
		if (entry.isSymbolicLink()) snapshot[key] = `-> ${await fs.readlink(entryPath)}`;
		else if (entry.isFile()) snapshot[key] = await Bun.file(entryPath).text();
	}
	return snapshot;
}

describe("plugin --dry-run beyond install, uninstall and link", () => {
	let root: string;
	let pluginsDir: string;
	let marketplaceDir: string;
	let otherMarketplaceDir: string;
	let output: string[];

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-dry-run-"));
		pluginsDir = path.join(root, "state", "plugins");
		marketplaceDir = path.join(root, "marketplace");
		otherMarketplaceDir = path.join(root, "other-marketplace");
		const projectDir = path.join(root, "project");
		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(pluginsDir, "node_modules"));
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(pluginsDir, "omp-plugins.lock.json"));
		spyOn(piUtils, "getMarketplacesRegistryPath").mockReturnValue(path.join(root, "state", "marketplaces.json"));
		spyOn(piUtils, "getProjectDir").mockReturnValue(projectDir);
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(
			path.join(projectDir, ".omp", "plugin-overrides.json"),
		);
		output = [];
		spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(args.map(String).join(" "));
		});
		spyOn(console, "error").mockImplementation(() => undefined);

		// An npm-installed plugin as package.json records it, for the npm/git upgrade path.
		await Bun.write(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "remote-pkg": "^1.0.0" } }),
		);
		// A linked local plugin with a feature and a setting, for enable/features/config.
		const linkedDir = path.join(root, LINKED);
		await Bun.write(
			path.join(linkedDir, "package.json"),
			JSON.stringify({
				name: LINKED,
				version: "1.0.0",
				omp: {
					features: { search: { description: "search", default: false } },
					settings: { apiKey: { type: "string", description: "key" } },
				},
			}),
		);
		await runPluginCommand({ action: "link", args: [linkedDir], flags: {} });
		await runPluginCommand({ action: "config", args: ["set", LINKED, "apiKey", "k1"], flags: {} });
		await runPluginCommand({ action: "disable", args: [LINKED], flags: {} });

		await writeMarketplace(marketplaceDir, "fixmkt", "1.0.0");
		await writeMarketplace(otherMarketplaceDir, "othermkt", "1.0.0");
		await runPluginCommand({ action: "marketplace", args: ["add", marketplaceDir], flags: {} });
		await runPluginCommand({ action: "install", args: [PLUGIN_ID], flags: {} });
		// A newer version is now available, so upgrade and marketplace update have real work to do.
		await writeMarketplace(marketplaceDir, "fixmkt", "2.0.0");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(root);
	});

	/** Everything the command printed to stdout so far in this test. */
	function logged(): string {
		return output.join("\n");
	}

	const previewed: Array<[string, Pick<PluginCommandArgs, "action" | "args">]> = [
		["upgrade <id>", { action: "upgrade", args: [PLUGIN_ID] }],
		["upgrade (all plugins)", { action: "upgrade", args: [] }],
	];

	for (const [label, cmd] of previewed) {
		test(`${label} --dry-run reports the version change and changes no plugin state`, async () => {
			const before = await snapshotTree(root);

			await runPluginCommand({ ...cmd, flags: { dryRun: true } });

			expect(logged()).toContain(UPGRADE_PREVIEW);
			expect(await snapshotTree(root)).toEqual(before);
		});
	}

	// `upgrade <id>` force-reinstalls whatever the catalog publishes now, while `upgrade` with no id
	// only touches outdated plugins; the previews must say the same.
	const reinstalls: Array<[string, string, string]> = [
		["same", "1.0.0", `Would reinstall ${PLUGIN_ID} (user): 1.0.0 -> 1.0.0`],
		["older", "0.5.0", `Would downgrade ${PLUGIN_ID} (user): 1.0.0 -> 0.5.0`],
	];

	for (const [kind, version, expected] of reinstalls) {
		test(`upgrade <id> --dry-run with a ${kind} catalog version reports the reinstall the real command makes`, async () => {
			await writeMarketplace(marketplaceDir, "fixmkt", version);
			const before = await snapshotTree(root);

			await runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: { dryRun: true } });
			expect(logged()).toContain(expected);

			await runPluginCommand({ action: "upgrade", args: [], flags: { dryRun: true } });
			expect(logged()).toContain("All marketplace plugins are up to date");
			expect(await snapshotTree(root)).toEqual(before);

			await runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: {} });
			expect(logged()).toContain(`Upgraded ${PLUGIN_ID} (user) to ${version}`);
		});
	}

	// A local source that declares no version installs as "0.0.0"; the preview must show that downgrade.
	test("upgrade <id> --dry-run shows the 0.0.0 fallback of a local plugin with no declared version", async () => {
		await writeMarketplace(marketplaceDir, "fixmkt", undefined);
		// The cached catalog keeps the old entry version until the marketplace is updated.
		await runPluginCommand({ action: "marketplace", args: ["update", "fixmkt"], flags: {} });

		await runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: { dryRun: true } });
		expect(logged()).toContain(`Would downgrade ${PLUGIN_ID} (user): 1.0.0 -> 0.0.0`);

		await runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: {} });
		expect(logged()).toContain(`Upgraded ${PLUGIN_ID} (user) to 0.0.0`);
	});

	// Tags that are not semver have no known order, so every different tag counts as an upgrade,
	// and both previews must use that same rule.
	test("upgrade --dry-run with and without an id agree on a non-semver catalog version", async () => {
		await writeMarketplace(marketplaceDir, "fixmkt", "nightly");
		const expected = `Would upgrade ${PLUGIN_ID} (user): 1.0.0 -> nightly`;

		await runPluginCommand({ action: "upgrade", args: [], flags: { dryRun: true } });
		expect(logged()).toContain(expected);
		output.length = 0;

		await runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: { dryRun: true } });
		expect(logged()).toContain(expected);
	});

	test("upgrade <id> --scope --dry-run reports a scope the plugin is not installed in, like the real command", async () => {
		const exit = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});
		const before = await snapshotTree(root);

		await expect(
			runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: { dryRun: true, scope: "project" } }),
		).rejects.toThrow("process.exit");

		expect(exit).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("is not installed in project scope"));
		expect(await snapshotTree(root)).toEqual(before);
	});

	test("upgrade --scope --dry-run with no id keeps the --scope warning", async () => {
		await runPluginCommand({ action: "upgrade", args: [], flags: { dryRun: true, scope: "user" } });

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--scope is ignored"));
		expect(logged()).toContain(UPGRADE_PREVIEW);
	});

	// A release that renames the runtime package onto a name another plugin owns is rejected by the
	// real upgrade before its first write. The preview reads the same local source, so it must refuse
	// too instead of promising an upgrade that cannot happen.
	test("upgrade <id> --dry-run refuses a release whose runtime package name another plugin owns", async () => {
		await Bun.write(
			path.join(marketplaceDir, "plugins", "hello", "package.json"),
			JSON.stringify({ name: LINKED, version: "2.0.0" }),
		);
		const exit = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});
		const before = await snapshotTree(root);

		await expect(runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: { dryRun: true } })).rejects.toThrow(
			"process.exit",
		);

		expect(exit).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`Runtime package name "${LINKED}" conflicts`));
		expect(logged()).not.toContain(UPGRADE_PREVIEW);
		expect(await snapshotTree(root)).toEqual(before);

		// The real upgrade refuses it the same way, so the preview promised nothing it would not.
		await expect(runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: {} })).rejects.toThrow(
			"process.exit",
		);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`Runtime package name "${LINKED}" conflicts`));
	});

	// `upgrade` with no id and the startup auto-update take their rows from checkForUpdates. The
	// "0.0.0" a source with no declared version falls back to is not a newer version, so it must
	// stay out of those rows, while the named force-reinstall preview still shows it.
	test("upgrade --dry-run with no id leaves out a local plugin whose source declares no version", async () => {
		await writeMarketplace(marketplaceDir, "fixmkt", "nightly");
		await runPluginCommand({ action: "marketplace", args: ["update", "fixmkt"], flags: {} });
		await runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: {} });
		await writeMarketplace(marketplaceDir, "fixmkt", undefined);
		await runPluginCommand({ action: "marketplace", args: ["update", "fixmkt"], flags: {} });
		output.length = 0;
		const before = await snapshotTree(root);

		await runPluginCommand({ action: "upgrade", args: [], flags: { dryRun: true } });
		expect(logged()).toContain("All marketplace plugins are up to date");
		expect(logged()).not.toContain("0.0.0");

		await runPluginCommand({ action: "upgrade", args: [], flags: {} });
		expect(await snapshotTree(root)).toEqual(before);

		// The named command still force-reinstalls it, so its preview still shows the fallback.
		output.length = 0;
		await runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: { dryRun: true } });
		expect(logged()).toContain(`Would upgrade ${PLUGIN_ID} (user): nightly -> 0.0.0`);
	});

	// The real install builds a cache path from the version the plugin manifest resolves to, not
	// from the catalog entry's. A manifest version that is unsafe as a path component must stop
	// the preview with the same error.
	test("upgrade <id> --dry-run refuses a manifest version that is unsafe as a cache path", async () => {
		await writeMarketplace(marketplaceDir, "fixmkt", "2.0.0");
		await Bun.write(
			path.join(marketplaceDir, "plugins", "hello", ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "hello", version: "2/0", description: "fixture" }),
		);
		await runPluginCommand({ action: "marketplace", args: ["update", "fixmkt"], flags: {} });
		const exit = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});
		const before = await snapshotTree(root);

		await expect(runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: { dryRun: true } })).rejects.toThrow(
			"process.exit",
		);

		expect(exit).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid version for cache: "2/0"'));
		expect(await snapshotTree(root)).toEqual(before);

		await expect(runPluginCommand({ action: "upgrade", args: [PLUGIN_ID], flags: {} })).rejects.toThrow(
			"process.exit",
		);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid version for cache: "2/0"'));
	});

	// `upgradeAllPlugins` skips a row whose install fails, so the no-id preview must not promise it.
	test("upgrade --dry-run with no id leaves out a row the real run skips", async () => {
		await Bun.write(
			path.join(marketplaceDir, "plugins", "hello", "package.json"),
			JSON.stringify({ name: LINKED, version: "2.0.0" }),
		);
		await runPluginCommand({ action: "marketplace", args: ["update", "fixmkt"], flags: {} });
		output.length = 0;
		const before = await snapshotTree(root);

		await runPluginCommand({ action: "upgrade", args: [], flags: { dryRun: true } });
		expect(logged()).toContain("All marketplace plugins are up to date");
		expect(logged()).not.toContain(UPGRADE_PREVIEW);

		output.length = 0;
		await runPluginCommand({ action: "upgrade", args: [], flags: {} });
		expect(logged()).toContain("All marketplace plugins are up to date");
		expect(await snapshotTree(root)).toEqual(before);
	});

	test("update --plugins --check reports plugin upgrades and changes no plugin state", async () => {
		const before = await snapshotTree(root);

		await new Update(["--plugins", "--check"], CLI_CONFIG).run();

		expect(logged()).toContain(UPGRADE_PREVIEW);
		expect(await snapshotTree(root)).toEqual(before);
	});

	test("install <npm-pkg> --dry-run does not create the plugins package.json", async () => {
		await fs.rm(path.join(pluginsDir, "package.json"));
		const before = await snapshotTree(root);

		await runPluginCommand({ action: "install", args: ["left-pad"], flags: { dryRun: true } });

		expect(logged()).toContain("Would install left-pad");
		expect(await snapshotTree(root)).toEqual(before);
	});

	test("list --dry-run still lists installed plugins", async () => {
		const before = await snapshotTree(root);

		await runPluginCommand({ action: "list", args: [], flags: { dryRun: true } });

		expect(logged()).toContain(PLUGIN_ID);
		expect(await snapshotTree(root)).toEqual(before);
	});

	const refused: Array<[string, () => Pick<PluginCommandArgs, "action" | "args"> & Partial<PluginCommandArgs>]> = [
		["marketplace update <name>", () => ({ action: "marketplace", args: ["update", "fixmkt"] })],
		["marketplace update (all)", () => ({ action: "marketplace", args: ["update"] })],
		["marketplace add", () => ({ action: "marketplace", args: ["add", otherMarketplaceDir] })],
		["marketplace remove", () => ({ action: "marketplace", args: ["remove", "fixmkt"] })],
		["disable (marketplace)", () => ({ action: "disable", args: [PLUGIN_ID] })],
		["enable (npm/link)", () => ({ action: "enable", args: [LINKED] })],
		["upgrade <npm package>", () => ({ action: "upgrade", args: ["remote-pkg"] })],
		["features --enable", () => ({ action: "features", args: [LINKED], flags: { enable: "search" } })],
		["features --set", () => ({ action: "features", args: [LINKED], flags: { set: "search" } })],
		["config set", () => ({ action: "config", args: ["set", LINKED, "apiKey", "k2"] })],
		["config delete", () => ({ action: "config", args: ["delete", LINKED, "apiKey"] })],
		["doctor --fix", () => ({ action: "doctor", args: [], flags: { fix: true } })],
	];

	for (const [label, cmd] of refused) {
		test(`${label} --dry-run exits 1 and changes no plugin state`, async () => {
			const before = await snapshotTree(root);
			const exit = spyOn(process, "exit").mockImplementation(() => {
				throw new Error("process.exit");
			});
			const { flags, ...rest } = cmd();

			await expect(runPluginCommand({ ...rest, flags: { ...flags, dryRun: true } })).rejects.toThrow("process.exit");

			expect(exit).toHaveBeenCalledWith(1);
			expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--dry-run is not supported"));
			expect(await snapshotTree(root)).toEqual(before);
		});
	}

	test("upgrade <unknown name> --dry-run reports that it is not installed", async () => {
		spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		await expect(
			runPluginCommand({ action: "upgrade", args: ["nosuchplugin"], flags: { dryRun: true } }),
		).rejects.toThrow("process.exit");

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("nosuchplugin is not installed"));
	});
});
