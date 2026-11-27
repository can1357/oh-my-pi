import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type CustomTool, toolCapability } from "@oh-my-pi/pi-coding-agent/capability/tool";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("Claude Code marketplace plugin tool discovery", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-tools-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		const settings = await Settings.init({ inMemory: true, cwd: project });
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(root);
	});

	test("filters non-module files from marketplace plugin tools", async () => {
		const pluginsDir = path.join(home, ".omp", "plugins");
		const pluginPath = path.join(root, "fixture-plugin");
		const toolsDir = path.join(pluginPath, "tools");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(toolsDir, { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"fixture@market": [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
							installedAt: "2026-01-01T00:00:00Z",
							lastUpdated: "2026-01-01T00:00:00Z",
						},
					],
				},
			}),
		);
		await Promise.all([
			fs.writeFile(path.join(toolsDir, "plugin-tool.ts"), "export default () => ({});\n"),
			fs.writeFile(path.join(toolsDir, "helper.sh"), "#!/bin/sh\n"),
			fs.writeFile(path.join(toolsDir, "notes.md"), "# Notes\n"),
		]);

		const result = await loadCapability<CustomTool>(toolCapability.id, {
			cwd: project,
			providers: ["claude-plugins"],
		});

		expect(result.warnings).toEqual([]);
		expect(result.items.map(tool => tool.name)).toEqual(["plugin-tool"]);
	});
});
