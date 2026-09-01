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

describe("Claude Code custom tool discovery", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
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
		if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
		await removeWithRetries(root);
	});

	test("discovers only JavaScript and TypeScript modules", async () => {
		const userTools = path.join(home, ".claude", "tools");
		const projectTools = path.join(project, ".claude", "tools");
		await fs.mkdir(userTools, { recursive: true });
		await fs.mkdir(projectTools, { recursive: true });
		await Promise.all([
			fs.writeFile(path.join(userTools, "user-tool.ts"), "export default () => ({});\n"),
			fs.writeFile(path.join(projectTools, "project-tool.js"), "export default () => ({});\n"),
			fs.writeFile(path.join(userTools, "helper.sh"), "#!/bin/sh\n"),
			fs.writeFile(path.join(projectTools, "helper.bash"), "#!/bin/bash\n"),
			fs.writeFile(path.join(projectTools, "helper.py"), "print('helper')\n"),
			fs.writeFile(path.join(projectTools, "notes.md"), "# Notes\n"),
		]);

		const result = await loadCapability<CustomTool>(toolCapability.id, {
			cwd: project,
			providers: ["claude"],
		});
		const tools = result.items
			.map(tool => ({ name: tool.name, level: tool.level }))
			.sort((a, b) => a.name.localeCompare(b.name));

		expect(result.warnings).toEqual([]);
		expect(tools).toEqual([
			{ name: "project-tool", level: "project" },
			{ name: "user-tool", level: "user" },
		]);
	});

	test("filters non-module files from marketplace plugin tools", async () => {
		const pluginsDir = path.join(home, ".claude", "plugins");
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
