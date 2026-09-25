import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type CustomTool, toolCapability } from "@oh-my-pi/pi-coding-agent/capability/tool";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverCustomToolPaths, loadCustomTools } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/loader";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

function toolSource(name: string): string {
	return `export default api => ({
		name: ${JSON.stringify(name)},
		description: "Discovery fixture",
		parameters: api.arktype({}),
		async execute() { return { content: [{ type: "text", text: "ok" }] }; },
	});`;
}

describe("native executable custom tool discovery", () => {
	let root: string;
	let project: string;
	let projectTools: string;
	let userTools: string;
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-builtin-tools-"));
		const home = path.join(root, "home");
		project = path.join(root, "project");
		projectTools = path.join(project, ".omp", "tools");
		userTools = path.join(home, ".omp", "agent", "tools");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.dirname(userTools));
		await Promise.all([
			fs.mkdir(projectTools, { recursive: true }),
			fs.mkdir(userTools, { recursive: true }),
			fs.mkdir(path.join(project, ".git"), { recursive: true }),
		]);
		initializeWithSettings(await Settings.init({ inMemory: true, cwd: project }));
	});

	afterEach(async () => {
		resetSettingsForTest();
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	});

	test("loads modules beside metadata without errors or metadata shadowing", async () => {
		const packagePath = path.join(projectTools, "package.json");
		const notesPath = path.join(projectTools, "notes.md");
		await fs.mkdir(path.join(projectTools, "nested"));
		await Promise.all([
			fs.writeFile(packagePath, JSON.stringify({ name: "user-module", type: "module" })),
			fs.writeFile(notesPath, "---\nname: notes\ndescription: Declarative tool metadata\n---\n# Notes\n"),
			fs.writeFile(path.join(projectTools, "project-module.ts"), toolSource("project_module")),
			fs.writeFile(path.join(userTools, "user-module.js"), toolSource("user_module")),
			fs.writeFile(path.join(projectTools, "nested", "index.ts"), toolSource("nested_module")),
			fs.writeFile(path.join(projectTools, "types.d.ts"), "export declare const tool: unknown;\n"),
			fs.writeFile(path.join(projectTools, "helper.sh"), "#!/bin/sh\necho helper\n"),
			fs.writeFile(path.join(projectTools, "helper.bash"), "#!/bin/bash\necho helper\n"),
			fs.writeFile(path.join(projectTools, "helper.py"), "print('helper')\n"),
		]);

		const discoveredPaths = await discoverCustomToolPaths([], project);
		const loaded = await loadCustomTools(discoveredPaths, project, []);
		expect(loaded.errors).toEqual([]);
		expect(loaded.tools.map(tool => tool.tool.name).sort()).toEqual([
			"nested_module",
			"project_module",
			"user_module",
		]);

		// Capability consumers still receive declarative definitions; only executable discovery filters them.
		const definitions = await loadCapability<CustomTool>(toolCapability.id, { cwd: project, providers: ["native"] });
		expect(definitions.items.find(tool => tool.path === packagePath)?.name).toBe("user-module");
		expect(definitions.items.find(tool => tool.path === notesPath)?.description).toBe("Declarative tool metadata");
	});

	test("reports explicitly configured metadata instead of silently skipping it", async () => {
		const packagePath = path.join(projectTools, "package.json");
		await fs.writeFile(packagePath, JSON.stringify({ type: "module" }));

		const discoveredPaths = await discoverCustomToolPaths([packagePath], project);
		const loaded = await loadCustomTools(discoveredPaths, project, []);
		expect(loaded.tools).toEqual([]);
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]).toMatchObject({ path: packagePath, source: { provider: "config" } });
		expect(loaded.errors[0]?.error).toMatch(/cannot be loaded as executable modules/);
	});
});
