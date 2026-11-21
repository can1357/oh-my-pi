import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPDroppedServer } from "@oh-my-pi/pi-coding-agent/mcp/transforms";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreAgentDir(): void {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		Bun.env.PI_CODING_AGENT_DIR = originalAgentDir;
		return;
	}
	setAgentDir(fallbackAgentDir);
	delete process.env.PI_CODING_AGENT_DIR;
	delete Bun.env.PI_CODING_AGENT_DIR;
}

function createController(
	builtinDrops = new Map<string, MCPDroppedServer>(),
	options?: {
		getServerConfig?: (name: string) => MCPServerConfig | undefined;
		getSource?: (name: string) => SourceMeta | undefined;
		settings?: Settings;
	},
) {
	const refreshMCPTools = vi.fn(async () => {});
	const showError = vi.fn((_message: string) => {});
	const connectServers = vi.fn(
		async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
			errors: new Map<string, string>(),
			connectedServers: [],
			tools: [],
			exaApiKeys: [],
		}),
	);
	const mcpManager = createMcpManagerStub({
		connectServers,
		getBuiltinDrops: () => builtinDrops,
		...(options?.getServerConfig ? { getServerConfig: options.getServerConfig } : {}),
		...(options?.getSource ? { getSource: options.getSource } : {}),
	});
	const ctx = createInteractiveModeContext({
		session: { refreshMCPTools },
		mcpManager,
		showError,
		...(options?.settings ? { settings: options.settings } : {}),
	});
	const controller = new MCPCommandController(ctx);

	return { controller, mcpManager, refreshMCPTools, connectServers, showError };
}

async function writeProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(
		getMCPConfigPath("project", projectDir),
		`${JSON.stringify(
			{
				mcpServers: servers,
			},
			null,
			2,
		)}\n`,
	);
}

function discoveredLookup(name: string, config: MCPServerConfig, sourcePath: string) {
	const source: SourceMeta = {
		provider: "claude",
		providerName: "Claude Code",
		path: sourcePath,
		level: "user",
	};
	return {
		getServerConfig: (serverName: string) => (serverName === name ? config : undefined),
		getSource: (serverName: string) => (serverName === name ? source : undefined),
	};
}

const FOREIGN_COMMAND = "omp201-foreign-cmd";

function foreignConfig(enabled?: boolean): MCPServerConfig {
	return {
		type: "stdio",
		command: FOREIGN_COMMAND,
		envPolicy: "literal",
		...(enabled === undefined ? {} : { enabled }),
	};
}

describe("/mcp enable and disable", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("disabling one configured server does not reload other MCP servers", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp disable mcp1");

		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("mcp1");
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).not.toHaveBeenCalled();
	});

	test("enabling one configured server connects only that MCP server", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one", enabled: false },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, connectServers } = createController();

		await controller.handle("/mcp enable mcp1");

		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(Object.keys(configs)).toEqual(["mcp1"]);
		expect(configs.mcp1).toEqual({ type: "stdio", command: "mcp-one", enabled: true });
	});

	test("enabling a server a built-in transform dropped records the enable and connects it", async () => {
		// Codex's config is another tool's file: the enable can only live in the
		// user allowlist, and that entry is what keeps the next discovery from
		// dropping the server again.
		const codexConfig = path.join(projectDir, ".codex", "config.toml");
		await Bun.write(codexConfig, '[mcp_servers.codex_js]\ncommand = "/opt/codex/cua_node/bin/node_repl"\n');
		const source: SourceMeta = {
			provider: "codex",
			providerName: "OpenAI Codex",
			path: codexConfig,
			level: "project",
		};
		const { controller, connectServers } = createController(
			new Map([["codex_js", { reason: "eval already runs JavaScript", source }]]),
		);

		await controller.handle("/mcp enable codex_js");

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.enabledServers).toEqual(["codex_js"]);
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(configs.codex_js).toMatchObject({ type: "stdio", command: "/opt/codex/cua_node/bin/node_repl" });
	});

	function userPath(): string {
		return getMCPConfigPath("user", projectDir);
	}

	async function loadedHas(name: string): Promise<boolean> {
		const loaded = await loadAllMCPConfigs(projectDir, { filterExa: false, enableProjectConfig: true });
		return loaded.configs[name] !== undefined;
	}

	function acpRuntime(mcpManager?: SlashCommandRuntime["mcpManager"], settings = Settings.isolated()) {
		const outputs: string[] = [];
		const runtime = {
			session: {
				getActiveToolNames: () => [] as string[],
				effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
			},
			sessionManager: {},
			settings,
			cwd: projectDir,
			mcpManager,
			output: (text: string) => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
		return { runtime, outputs, settings };
	}

	async function runAcp(args: string, mcpManager?: SlashCommandRuntime["mcpManager"], settings?: Settings) {
		const ctx = acpRuntime(mcpManager, settings);
		const result = await handleMcpAcp({ args } as ParsedSlashCommand, ctx.runtime);
		return { ...ctx, result };
	}

	test("disabling a discovered server denylists it instead of copying it into user config", async () => {
		// A third-party server must not be cloned into ~/.omp/agent/mcp.json, or that
		// copy permanently shadows later changes to the upstream definition.
		const foreignPath = path.join(projectDir, "claude.json");
		await Bun.write(foreignPath, "tool-owned\n");
		const { controller } = createController(
			new Map(),
			discoveredLookup("omp201-foreign", foreignConfig(), foreignPath),
		);

		await controller.handle("/mcp disable omp201-foreign");

		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.disabledServers).toContain("omp201-foreign");
		expect(await Bun.file(userPath()).text()).not.toContain(FOREIGN_COMMAND);
		expect(await Bun.file(userPath()).text()).not.toContain("envPolicy");
		expect(await Bun.file(foreignPath).text()).toBe("tool-owned\n");
	});

	test("enabling a switched-off discovered server allowlists it instead of copying it", async () => {
		const foreignPath = path.join(projectDir, "claude.json");
		await Bun.write(foreignPath, "tool-owned\n");
		const { controller } = createController(
			new Map(),
			discoveredLookup("omp201-foreign", foreignConfig(false), foreignPath),
		);

		await controller.handle("/mcp enable omp201-foreign");

		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.enabledServers).toContain("omp201-foreign");
		expect(user.disabledServers ?? []).not.toContain("omp201-foreign");
		expect(await Bun.file(userPath()).text()).not.toContain("envPolicy");
		expect(await Bun.file(foreignPath).text()).toBe("tool-owned\n");
	});

	test("enabling an already-on discovered server does not copy it or allowlist it", async () => {
		const foreignPath = path.join(projectDir, "claude.json");
		const { controller } = createController(
			new Map(),
			discoveredLookup("omp201-foreign", foreignConfig(), foreignPath),
		);

		await controller.handle("/mcp enable omp201-foreign");

		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.enabledServers ?? []).not.toContain("omp201-foreign");
	});

	test("enabling a configured server on the denylist turns it back on", async () => {
		// disabledServers wins over enabled: true. Leaving the name there keeps
		// the server off after the next load.
		await writeProjectConfig(projectDir, {
			"omp201-native": { type: "stdio", command: "native-cmd" },
		});
		await Bun.write(userPath(), `${JSON.stringify({ disabledServers: ["omp201-native"] }, null, 2)}\n`);
		const { controller, connectServers } = createController();

		await controller.handle("/mcp enable omp201-native");

		const user = await readMCPConfigFile(userPath());
		expect(user.disabledServers ?? []).not.toContain("omp201-native");
		expect(user.enabledServers ?? []).not.toContain("omp201-native");
		const project = await readMCPConfigFile(getMCPConfigPath("project", projectDir));
		expect(project.mcpServers?.["omp201-native"]?.enabled).toBe(true);
		expect(await loadedHas("omp201-native")).toBe(true);
		expect(connectServers).toHaveBeenCalled();
	});

	test("disabling a configured server on the allowlist turns it back off", async () => {
		// enabledServers overrides enabled: false. Leaving the name there keeps
		// the server on after the next load.
		await writeProjectConfig(projectDir, {
			"omp201-native": { type: "stdio", command: "native-cmd", enabled: false },
		});
		await Bun.write(userPath(), `${JSON.stringify({ enabledServers: ["omp201-native"] }, null, 2)}\n`);
		const { controller, mcpManager } = createController();

		await controller.handle("/mcp disable omp201-native");

		const user = await readMCPConfigFile(userPath());
		expect(user.enabledServers ?? []).not.toContain("omp201-native");
		expect(user.disabledServers ?? []).not.toContain("omp201-native");
		const project = await readMCPConfigFile(getMCPConfigPath("project", projectDir));
		expect(project.mcpServers?.["omp201-native"]?.enabled).toBe(false);
		expect(await loadedHas("omp201-native")).toBe(false);
		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("omp201-native");
	});

	test("enabling a standalone mcp.json server writes that file and clears a stale denylist", async () => {
		const standalone = path.join(projectDir, "mcp.json");
		await Bun.write(
			standalone,
			`${JSON.stringify(
				{ mcpServers: { "omp201-solo": { type: "stdio", command: "solo-cmd", enabled: false } } },
				null,
				2,
			)}\n`,
		);
		await Bun.write(userPath(), `${JSON.stringify({ disabledServers: ["omp201-solo"] }, null, 2)}\n`);
		const { controller } = createController();

		await controller.handle("/mcp enable omp201-solo");

		const saved = await readMCPConfigFile(standalone);
		expect(saved.mcpServers?.["omp201-solo"]?.enabled).toBe(true);
		const user = await readMCPConfigFile(userPath());
		expect(user.disabledServers ?? []).not.toContain("omp201-solo");
		expect(user.enabledServers ?? []).not.toContain("omp201-solo");
		expect(user.mcpServers?.["omp201-solo"]).toBeUndefined();
	});

	test("disabling a discovered server does not rewrite an opted-out project mcp.json", async () => {
		const projectPath = getMCPConfigPath("project", projectDir);
		await writeProjectConfig(projectDir, {
			"omp201-foreign": foreignConfig(),
		});
		const before = await Bun.file(projectPath).text();
		const settings = Settings.isolated();
		cfgMcpEnableProjectConfig.set(settings, false);
		const { controller } = createController(new Map(), {
			settings,
			...discoveredLookup("omp201-foreign", foreignConfig(), path.join(projectDir, "claude.json")),
		});

		await controller.handle("/mcp disable omp201-foreign");

		expect(await Bun.file(projectPath).text()).toBe(before);
		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.disabledServers).toContain("omp201-foreign");
		expect(await Bun.file(userPath()).text()).not.toContain(FOREIGN_COMMAND);
	});

	test("ACP enable clears a stale denylist so the configured server loads", async () => {
		await writeProjectConfig(projectDir, {
			"omp201-native": { type: "stdio", command: "native-cmd" },
		});
		await Bun.write(userPath(), `${JSON.stringify({ disabledServers: ["omp201-native"] }, null, 2)}\n`);

		const { outputs } = await runAcp("enable omp201-native");

		expect(outputs.join("\n")).not.toContain("not found");
		const user = await readMCPConfigFile(userPath());
		expect(user.disabledServers ?? []).not.toContain("omp201-native");
		const project = await readMCPConfigFile(getMCPConfigPath("project", projectDir));
		expect(project.mcpServers?.["omp201-native"]?.enabled).toBe(true);
		expect(await loadedHas("omp201-native")).toBe(true);
	});

	test("ACP disable clears a stale allowlist on a user config server", async () => {
		await Bun.write(
			userPath(),
			`${JSON.stringify(
				{
					mcpServers: { "omp201-user": { type: "stdio", command: "user-cmd", enabled: false } },
					enabledServers: ["omp201-user"],
				},
				null,
				2,
			)}\n`,
		);

		const { outputs } = await runAcp("disable omp201-user");

		expect(outputs.join("\n")).not.toContain("not found");
		const user = await readMCPConfigFile(userPath());
		expect(user.enabledServers ?? []).not.toContain("omp201-user");
		expect(user.disabledServers ?? []).not.toContain("omp201-user");
		expect(user.mcpServers?.["omp201-user"]?.enabled).toBe(false);
		expect(await loadedHas("omp201-user")).toBe(false);
	});

	test("ACP enable of a discovered server allowlists it instead of copying it", async () => {
		const foreignPath = path.join(projectDir, "claude.json");
		await Bun.write(foreignPath, "tool-owned\n");
		const manager = createMcpManagerStub(discoveredLookup("omp201-foreign", foreignConfig(false), foreignPath));

		const { outputs } = await runAcp("enable omp201-foreign", manager);

		expect(outputs.join("\n")).not.toContain("not found");
		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.enabledServers).toContain("omp201-foreign");
		expect(await Bun.file(userPath()).text()).not.toContain("envPolicy");
		expect(await Bun.file(foreignPath).text()).toBe("tool-owned\n");
	});

	test("ACP enable of an already-on discovered server does not copy it or allowlist it", async () => {
		const manager = createMcpManagerStub(
			discoveredLookup("omp201-foreign", foreignConfig(), path.join(projectDir, "claude.json")),
		);

		await runAcp("enable omp201-foreign", manager);

		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.enabledServers ?? []).not.toContain("omp201-foreign");
	});

	test("ACP enable of a standalone mcp.json server writes that file and clears a stale denylist", async () => {
		const standalone = path.join(projectDir, "mcp.json");
		await Bun.write(
			standalone,
			`${JSON.stringify(
				{ mcpServers: { "omp201-solo": { type: "stdio", command: "solo-cmd", enabled: false } } },
				null,
				2,
			)}\n`,
		);
		await Bun.write(userPath(), `${JSON.stringify({ disabledServers: ["omp201-solo"] }, null, 2)}\n`);

		await runAcp("enable omp201-solo");

		const saved = await readMCPConfigFile(standalone);
		expect(saved.mcpServers?.["omp201-solo"]?.enabled).toBe(true);
		const user = await readMCPConfigFile(userPath());
		expect(user.disabledServers ?? []).not.toContain("omp201-solo");
		expect(user.enabledServers ?? []).not.toContain("omp201-solo");
		expect(user.mcpServers?.["omp201-solo"]).toBeUndefined();
	});

	test("ACP disable does not rewrite an opted-out project mcp.json", async () => {
		const projectPath = getMCPConfigPath("project", projectDir);
		await writeProjectConfig(projectDir, {
			"omp201-foreign": foreignConfig(),
		});
		const before = await Bun.file(projectPath).text();
		const settings = Settings.isolated();
		cfgMcpEnableProjectConfig.set(settings, false);

		await runAcp("disable omp201-foreign", undefined, settings);

		expect(await Bun.file(projectPath).text()).toBe(before);
		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.disabledServers).toContain("omp201-foreign");
	});

	test("enabling a user server with project config opted out connects the user command, not a same-named project server", async () => {
		const projectPath = getMCPConfigPath("project", projectDir);
		await writeProjectConfig(projectDir, {
			"omp201-shared": { type: "stdio", command: "project-cmd" },
		});
		const beforeProject = await Bun.file(projectPath).text();
		await Bun.write(
			userPath(),
			`${JSON.stringify(
				{
					mcpServers: {
						"omp201-shared": { type: "stdio", command: "user-cmd", enabled: false },
					},
				},
				null,
				2,
			)}\n`,
		);
		const settings = Settings.isolated();
		cfgMcpEnableProjectConfig.set(settings, false);
		const { controller, connectServers } = createController(new Map(), { settings });

		await controller.handle("/mcp enable omp201-shared");

		expect(await Bun.file(projectPath).text()).toBe(beforeProject);
		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-shared"]?.enabled).toBe(true);
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(configs["omp201-shared"]).toMatchObject({ type: "stdio", command: "user-cmd", enabled: true });
	});

	test("toggling a server switched off in opencode.json resolves it without manager state", async () => {
		const opencodePath = path.join(projectDir, "opencode.json");
		const opencodeText = `${JSON.stringify(
			{
				mcp: {
					"omp201-opencode": {
						type: "local",
						command: ["opencode-bin", "--stdio"],
						enabled: false,
					},
				},
			},
			null,
			2,
		)}\n`;
		await Bun.write(opencodePath, opencodeText);
		const { controller, connectServers, showError } = createController();

		await controller.handle("/mcp disable omp201-opencode");
		expect(showError).not.toHaveBeenCalled();
		expect((await readMCPConfigFile(userPath())).disabledServers ?? []).not.toContain("omp201-opencode");

		const acpDisable = await runAcp("disable omp201-opencode");
		expect(acpDisable.result).toEqual({ consumed: true });
		expect(acpDisable.outputs.join("\n")).toContain("already disabled");

		await controller.handle("/mcp enable omp201-opencode");
		expect(showError).not.toHaveBeenCalled();
		expect(await Bun.file(opencodePath).text()).toBe(opencodeText);
		const userAfterTui = await readMCPConfigFile(userPath());
		expect(userAfterTui.mcpServers?.["omp201-opencode"]).toBeUndefined();
		expect(userAfterTui.enabledServers).toContain("omp201-opencode");
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(configs["omp201-opencode"]).toMatchObject({
			type: "stdio",
			command: "opencode-bin",
			args: ["--stdio"],
		});
		expect(await loadedHas("omp201-opencode")).toBe(true);

		await Bun.write(userPath(), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		const acpEnable = await runAcp("enable omp201-opencode");
		expect(acpEnable.result).toEqual({ consumed: true });
		expect(await Bun.file(opencodePath).text()).toBe(opencodeText);
		const userAfterAcp = await readMCPConfigFile(userPath());
		expect(userAfterAcp.mcpServers?.["omp201-opencode"]).toBeUndefined();
		expect(userAfterAcp.enabledServers).toContain("omp201-opencode");
	});

	test("disabling a server owned by Cursor over a root mcp.json denylists it instead of editing the shadowed root file", async () => {
		const cursorPath = path.join(projectDir, ".cursor", "mcp.json");
		const rootMcpPath = path.join(projectDir, "mcp.json");
		const cursorText = `${JSON.stringify(
			{ mcpServers: { "omp201-cursor-wins": { command: "cursor-cmd" } } },
			null,
			2,
		)}\n`;
		const rootText = `${JSON.stringify(
			{ mcpServers: { "omp201-cursor-wins": { type: "stdio", command: "root-cmd" } } },
			null,
			2,
		)}\n`;
		await Bun.write(cursorPath, cursorText);
		await Bun.write(rootMcpPath, rootText);

		const initial = await loadAllMCPConfigs(projectDir, { filterExa: false, enableProjectConfig: true });
		expect(initial.configs["omp201-cursor-wins"]).toMatchObject({ command: "cursor-cmd" });

		const { controller } = createController();
		await controller.handle("/mcp disable omp201-cursor-wins");

		expect(await Bun.file(rootMcpPath).text()).toBe(rootText);
		expect(await Bun.file(cursorPath).text()).toBe(cursorText);
		expect((await readMCPConfigFile(userPath())).disabledServers).toContain("omp201-cursor-wins");
		expect(await loadedHas("omp201-cursor-wins")).toBe(false);

		await fs.rm(userPath(), { force: true });
		await runAcp("disable omp201-cursor-wins");

		expect(await Bun.file(rootMcpPath).text()).toBe(rootText);
		expect((await readMCPConfigFile(userPath())).disabledServers).toContain("omp201-cursor-wins");
		expect(await loadedHas("omp201-cursor-wins")).toBe(false);
	});

	test('enabling a native server whose enabled flag is string "false" turns it on', async () => {
		await Bun.write(
			getMCPConfigPath("project", projectDir),
			`${JSON.stringify(
				{ mcpServers: { "omp201-str-project": { type: "stdio", command: "proj-cmd", enabled: "false" } } },
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			userPath(),
			`${JSON.stringify(
				{ mcpServers: { "omp201-str-user": { type: "stdio", command: "user-cmd", enabled: "false" } } },
				null,
				2,
			)}\n`,
		);
		expect(await loadedHas("omp201-str-project")).toBe(false);
		expect(await loadedHas("omp201-str-user")).toBe(false);

		const { controller } = createController();
		await controller.handle("/mcp enable omp201-str-project");
		await runAcp("enable omp201-str-user");

		const project = await readMCPConfigFile(getMCPConfigPath("project", projectDir));
		const user = await readMCPConfigFile(userPath());
		expect(project.mcpServers?.["omp201-str-project"]?.enabled).toBe(true);
		expect(user.mcpServers?.["omp201-str-user"]?.enabled).toBe(true);
		expect(await loadedHas("omp201-str-project")).toBe(true);
		expect(await loadedHas("omp201-str-user")).toBe(true);
	});

	test("toggling clears conflicting override entries even when effective state already matches", async () => {
		const opencodePath = path.join(projectDir, "opencode.json");
		await Bun.write(
			opencodePath,
			`${JSON.stringify(
				{ mcp: { "omp201-both": { type: "local", command: ["oc-cmd"], enabled: false } } },
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			userPath(),
			`${JSON.stringify({ disabledServers: ["omp201-both"], enabledServers: ["omp201-both"] }, null, 2)}\n`,
		);
		const { controller } = createController();

		await controller.handle("/mcp disable omp201-both");

		const afterTui = await readMCPConfigFile(userPath());
		expect(afterTui.enabledServers ?? []).not.toContain("omp201-both");
		expect(afterTui.disabledServers).toContain("omp201-both");
		// Removing the denylist entry later must not revive the server via a leftover force-enable.
		await Bun.write(userPath(), `${JSON.stringify({ ...afterTui, disabledServers: undefined }, null, 2)}\n`);
		expect(await loadedHas("omp201-both")).toBe(false);

		await Bun.write(
			userPath(),
			`${JSON.stringify({ disabledServers: ["omp201-both"], enabledServers: ["omp201-both"] }, null, 2)}\n`,
		);
		await runAcp("disable omp201-both");
		const afterAcp = await readMCPConfigFile(userPath());
		expect(afterAcp.enabledServers ?? []).not.toContain("omp201-both");
		expect(afterAcp.disabledServers).toContain("omp201-both");

		// Symmetric enable conflict: writable config says false while enabledServers forces it on.
		await writeProjectConfig(projectDir, {
			"omp201-conflict-on": { type: "stdio", command: "conflict-cmd", enabled: false },
		});
		await Bun.write(userPath(), `${JSON.stringify({ enabledServers: ["omp201-conflict-on"] }, null, 2)}\n`);
		await controller.handle("/mcp enable omp201-conflict-on");
		expect(
			(await readMCPConfigFile(getMCPConfigPath("project", projectDir))).mcpServers?.["omp201-conflict-on"]?.enabled,
		).toBe(true);
		expect((await readMCPConfigFile(userPath())).enabledServers ?? []).not.toContain("omp201-conflict-on");
	});

	test("disabling an absent server present only in enabledServers cancels the saved force-enable", async () => {
		await Bun.write(userPath(), `${JSON.stringify({ enabledServers: ["omp201-absent-plugin"] }, null, 2)}\n`);
		const { controller, showError } = createController();

		await controller.handle("/mcp disable omp201-absent-plugin");

		expect(showError).not.toHaveBeenCalled();
		const user = await readMCPConfigFile(userPath());
		expect(user.enabledServers ?? []).not.toContain("omp201-absent-plugin");
		expect(user.disabledServers).toContain("omp201-absent-plugin");
	});

	test("ACP refuses to toggle an editor-supplied ACP server instead of writing a global setting", async () => {
		const projectPath = getMCPConfigPath("project", projectDir);
		await writeProjectConfig(projectDir, {
			"omp201-acp-editor": { type: "stdio", command: "shadowed-file-cmd" },
		});
		const beforeProject = await Bun.file(projectPath).text();
		const acpManager = createMcpManagerStub({
			getServerConfig: name => (name === "omp201-acp-editor" ? { type: "stdio", command: "editor-cmd" } : undefined),
			getSource: name =>
				name === "omp201-acp-editor"
					? { provider: "acp", providerName: "ACP Client", path: "acp://omp201-acp-editor", level: "project" }
					: undefined,
		});

		const disabled = await runAcp("disable omp201-acp-editor", acpManager);
		const enabled = await runAcp("enable omp201-acp-editor", acpManager);

		expect(disabled.result).toEqual({ consumed: true, failed: true });
		expect(enabled.result).toEqual({ consumed: true, failed: true });
		expect(disabled.outputs.join("\n")).toContain("editor");
		expect(disabled.outputs.join("\n")).not.toContain('Server "omp201-acp-editor" disabled');
		expect(await Bun.file(projectPath).text()).toBe(beforeProject);
		const user = await readMCPConfigFile(userPath());
		expect(user.disabledServers ?? []).not.toContain("omp201-acp-editor");
		expect(user.enabledServers ?? []).not.toContain("omp201-acp-editor");
	});

	test("ACP enable and disable preserve multi-word server names instead of truncating at whitespace", async () => {
		await writeProjectConfig(projectDir, {
			MaaS: { type: "stdio", command: "maas-cmd" },
			"MaaS Slack": { type: "stdio", command: "maas-slack-cmd" },
		});

		const disabled = await runAcp("disable MaaS Slack");
		expect(disabled.result).toEqual({ consumed: true });

		const afterDisable = await readMCPConfigFile(getMCPConfigPath("project", projectDir));
		expect(afterDisable.mcpServers?.["MaaS Slack"]?.enabled).toBe(false);
		expect(afterDisable.mcpServers?.MaaS?.enabled).toBeUndefined();

		const enabled = await runAcp("enable MaaS Slack");
		expect(enabled.result).toEqual({ consumed: true });

		const afterEnable = await readMCPConfigFile(getMCPConfigPath("project", projectDir));
		expect(afterEnable.mcpServers?.["MaaS Slack"]?.enabled).toBe(true);
		expect(afterEnable.mcpServers?.MaaS?.enabled).toBeUndefined();
	});
});
