import { afterEach, beforeEach, describe, expect, test, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import {
	MarketplaceManager,
	writeInstalledPluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as piUtils from "@oh-my-pi/pi-utils";
import { printRows } from "@oh-my-pi/pi-coding-agent/ui/print-rows";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// A session refreshes skills with its own effective roots, never the process-wide CLI injection
// (`--no-extensions` in an earlier in-process `runRootCommand` leaves it at explicit-only).
const ROOTS: EffectiveExtensionRoots = { explicit: [], mode: "merge", configured: [], configuredLevel: "user" };

function makeContext(cwd: string, refreshSkills: () => Promise<void>) {
	const ctx = {
		session: { effectiveExtensionRoots: ROOTS },
		sessionManager: { getCwd: () => cwd },
		settings: Settings.isolated({}),
		refreshSkillState: refreshSkills,
		refreshSlashCommandState: async () => {},
		showStatus: () => {},
		composer: { setText: () => {} },
	} as never as InteractiveModeContext;
	return ctx;
}

describe("/plugins live enable and disable", () => {
	let root: string;
	let pluginsDir: string;
	let registryPath: string;
	let lockPath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugins-slash-"));
		pluginsDir = path.join(root, "plugins");
		registryPath = path.join(pluginsDir, "installed_plugins.json");
		lockPath = path.join(pluginsDir, "omp-plugins.lock.json");
		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockPath);
		spyOn(piUtils, "getMarketplacesRegistryPath").mockReturnValue(path.join(root, "marketplaces.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(root);
	});

	test("marketplace toggle changes the discovered skills in the running TUI session", async () => {
		const id = "example@local";
		const installPath = path.join(root, "example");
		await Bun.write(path.join(installPath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
		await Bun.write(
			path.join(installPath, "skills", "market-skill", "SKILL.md"),
			"---\nname: market-skill\ndescription: Marketplace fixture\n---\nSkill body\n",
		);
		await writeInstalledPluginsRegistry(registryPath, {
			version: 2,
			plugins: {
				[id]: [
					{
						scope: "user",
						installPath,
						version: "1.0.0",
						installedAt: "2026-01-01",
						lastUpdated: "2026-01-01",
						enabled: false,
					},
				],
			},
		});
		await Bun.write(
			lockPath,
			JSON.stringify({
				version: 1,
				plugins: { example: { version: "1.0.0", enabled: false, enabledFeatures: null } },
			}),
		);

		let visibleSkills = 0;
		const ctx = makeContext(root, async () => {
			const { skills } = await loadSkills({ cwd: root, extensionRoots: ROOTS });
			visibleSkills = skills.filter(skill => skill.name === "market-skill").length;
		});
		await executeBuiltinSlashCommand(`/plugins enable ${id}`, { ctx });
		expect(visibleSkills).toBe(1);

		await executeBuiltinSlashCommand(`/plugins disable ${id}`, { ctx });
		expect(visibleSkills).toBe(0);
	});

	test("npm toggle changes the discovered skills in the running TUI session", async () => {
		const name = "example-npm";
		await Bun.write(
			lockPath,
			JSON.stringify({
				version: 1,
				plugins: { [name]: { version: "1.0.0", enabled: false, enabledFeatures: null } },
			}),
		);
		await Bun.write(
			path.join(pluginsDir, "node_modules", name, "package.json"),
			JSON.stringify({ name, version: "1.0.0", omp: {} }),
		);
		await Bun.write(
			path.join(pluginsDir, "node_modules", name, "skills", "npm-skill", "SKILL.md"),
			"---\nname: npm-skill\ndescription: Npm fixture\n---\nSkill body\n",
		);
		let visibleSkills = 0;
		const ctx = makeContext(root, async () => {
			const { skills } = await loadSkills({ cwd: root, extensionRoots: ROOTS });
			visibleSkills = skills.filter(skill => skill.name === "npm-skill").length;
		});
		await executeBuiltinSlashCommand(`/plugins enable ${name}`, { ctx });
		expect(visibleSkills).toBe(1);

		await executeBuiltinSlashCommand(`/plugins disable ${name}`, { ctx });
		expect(visibleSkills).toBe(0);
	});
});

describe("/plugins list in the TUI", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// #20653: the listing went to a status toast, which natively is one row, so its lines ran together.
	test("shows the installed plugins as a report, one plugin per line", async () => {
		spyOn(PluginManager.prototype, "list").mockResolvedValue([
			{ name: "plugin-a", version: "0.1.1" },
			{ name: "plugin-c", version: "0.8.2", enabled: false },
		] as never);
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([
			{ id: "foo@some-marketplace", scope: "user", entries: [{ version: "1.3.0" }] },
		] as never);
		const showStatus = vi.fn((_message: string) => {});
		const reports: { title: string; rows: string[] }[] = [];
		const ctx = {
			...makeContext(os.tmpdir(), async () => {}),
			showStatus,
			showCommandReport: (options: { title: string; body: () => JSXNode }) => {
				const rows = printRows(options.body, 100).map(row => stripVTControlCharacters(row).trimEnd());
				reports.push({ title: options.title, rows });
			},
		} as never as InteractiveModeContext;

		await executeBuiltinSlashCommand("/plugins", { ctx });

		expect(showStatus).not.toHaveBeenCalled();
		expect(reports).toEqual([
			{
				title: "Installed Plugins",
				rows: [
					"npm plugins:",
					"  plugin-a@0.1.1",
					"  plugin-c@0.8.2 (disabled)",
					"",
					"marketplace plugins:",
					"  foo@some-marketplace v1.3.0 [user]",
				],
			},
		]);
	});
});
