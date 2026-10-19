import { afterEach, beforeEach, describe, expect, test, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { writeInstalledPluginsRegistry } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const ROOTS: EffectiveExtensionRoots = { explicit: [], mode: "merge", configured: [], configuredLevel: "user" };

function makeContext(cwd: string, refreshSkills: () => Promise<void>) {
	const ctx = {
		session: { effectiveExtensionRoots: ROOTS },
		sessionManager: { getCwd: () => cwd },
		settings: Settings.isolated({}),
		refreshSkillState: refreshSkills,
		refreshSlashCommandState: async () => {},
		showStatus: () => {},
		editor: { setText: () => {} },
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
			const { skills } = await loadSkills({ cwd: root });
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
			const { skills } = await loadSkills({ cwd: root });
			visibleSkills = skills.filter(skill => skill.name === "npm-skill").length;
		});
		await executeBuiltinSlashCommand(`/plugins enable ${name}`, { ctx });
		expect(visibleSkills).toBe(1);

		await executeBuiltinSlashCommand(`/plugins disable ${name}`, { ctx });
		expect(visibleSkills).toBe(0);
	});
});
