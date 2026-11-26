import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { reset as resetDiscoveryCache } from "@oh-my-pi/pi-coding-agent/discovery";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { MCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	__resetDirsFromEnvForTests,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

describe("ACP /mcp config resolution", () => {
	let projectDir = "";
	let processDir = "";
	let agentDir = "";
	let originalProjectDir = "";
	let originalAgentDir: string | undefined;
	let originalPiProfile: string | undefined;
	let originalOmpProfile: string | undefined;
	const outputs: string[] = [];

	beforeEach(async () => {
		outputs.length = 0;
		originalProjectDir = getProjectDir();
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalPiProfile = process.env.PI_PROFILE;
		originalOmpProfile = process.env.OMP_PROFILE;
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-acp-project-"));
		processDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-acp-process-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-acp-agent-"));
		// The session cwd deliberately differs from the process-wide project dir.
		setProjectDir(processDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		resetDiscoveryCache();
		setProjectDir(originalProjectDir);
		restoreEnvValue("PI_PROFILE", originalPiProfile);
		restoreEnvValue("OMP_PROFILE", originalOmpProfile);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDir);
		__resetDirsFromEnvForTests();
		await removeWithRetries(projectDir);
		await removeWithRetries(processDir);
		await removeWithRetries(agentDir);
	});

	function makeRuntime(): SlashCommandRuntime {
		return {
			session: { modelRegistry: { authStorage: {} } },
			sessionManager: {},
			settings: Settings.isolated(),
			cwd: projectDir,
			output: (text: string) => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: () => Promise.resolve(),
		} as unknown as SlashCommandRuntime;
	}

	async function writeConfig(scope: "user" | "project", config: MCPConfigFile): Promise<void> {
		await Bun.write(getMCPConfigPath(scope, projectDir), `${JSON.stringify(config, null, 2)}\n`);
	}

	function runMcp(args: string, runtime: SlashCommandRuntime) {
		return handleMcpAcp({ name: "mcp", args, text: `/mcp ${args}` }, runtime);
	}

	function mockConnections() {
		const connection = { capabilities: {} } as never;
		const connect = vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		return connect;
	}

	function listedRows(text: string | undefined): Record<string, { enabled: boolean; command: string; scope: string }> {
		const rows: Record<string, { enabled: boolean; command: string; scope: string }> = {};
		for (const line of (text ?? "").split("\n")) {
			if (!line) continue;
			const parts = line.split(" | ");
			expect(parts).toHaveLength(4);
			const name = parts[0]!;
			const status = parts[2]!;
			const detail = parts[3]!;
			const scopeStart = detail.lastIndexOf(" [");
			expect(scopeStart).toBeGreaterThan(0);
			expect(detail.endsWith("]")).toBe(true);
			const scope = detail.slice(scopeStart + 2, -1);
			expect(status === "enabled" || status === "disabled").toBe(true);
			expect(scope === "project" || scope === "user").toBe(true);
			expect(rows[name]).toBeUndefined();
			rows[name] = { enabled: status === "enabled", command: detail.slice(0, scopeStart), scope };
		}
		return rows;
	}

	test("list shows the effective project entries and user enable/disable overrides", async () => {
		await writeConfig("project", {
			mcpServers: {
				shared: { type: "stdio", command: "project-command" },
				"disabled-shadow": { type: "stdio", command: "project-disabled", enabled: false },
				forced: { type: "stdio", command: "project-forced", enabled: false },
				denied: { type: "stdio", command: "project-denied" },
			},
		});
		await writeConfig("user", {
			mcpServers: {
				shared: { type: "stdio", command: "user-command" },
				"disabled-shadow": { type: "stdio", command: "user-shadow" },
				"user-only": { type: "stdio", command: "user-only-command" },
			},
			disabledServers: ["denied"],
			enabledServers: ["forced"],
		});
		const runtime = makeRuntime();

		const result = await runMcp("list", runtime);

		expect(result).toEqual({ consumed: true });
		expect(listedRows(outputs[0])).toEqual({
			shared: { enabled: true, command: "project-command", scope: "project" },
			"disabled-shadow": { enabled: false, command: "project-disabled", scope: "project" },
			forced: { enabled: true, command: "project-forced", scope: "project" },
			denied: { enabled: false, command: "project-denied", scope: "project" },
			"user-only": { enabled: true, command: "user-only-command", scope: "user" },
		});
	});

	test("test connects only to effectively enabled servers in the session cwd", async () => {
		await writeConfig("project", {
			mcpServers: {
				"disabled-shadow": { type: "stdio", command: "project-disabled", enabled: false },
				forced: { type: "stdio", command: "project-forced", enabled: false },
				denied: { type: "stdio", command: "project-denied" },
			},
		});
		await writeConfig("user", {
			mcpServers: {
				"disabled-shadow": { type: "stdio", command: "user-shadow" },
			},
			disabledServers: ["denied"],
			enabledServers: ["forced"],
		});
		const runtime = makeRuntime();
		const connect = mockConnections();

		const shadowResult = await runMcp("test disabled-shadow", runtime);
		expect(shadowResult).toEqual({ consumed: true, failed: true });
		expect(connect).not.toHaveBeenCalled();

		const forcedResult = await runMcp("test forced", runtime);
		expect(forcedResult).toEqual({ consumed: true });
		expect(connect).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledWith(
			"forced",
			expect.objectContaining({ command: "project-forced", enabled: false }),
			{ live: true, cwd: projectDir },
		);

		const deniedResult = await runMcp("test denied", runtime);
		expect(deniedResult).toEqual({ consumed: true, failed: true });
		expect(connect).toHaveBeenCalledTimes(1);
	});

	test("project-config opt-out exposes user entries without resurrecting project entries", async () => {
		await writeConfig("project", {
			mcpServers: {
				shared: { type: "stdio", command: "project-command" },
				"project-only": { type: "stdio", command: "project-only-command" },
			},
		});
		await writeConfig("user", {
			mcpServers: {
				shared: { type: "stdio", command: "user-command" },
				"user-only": { type: "stdio", command: "user-only-command" },
			},
		});
		const runtime = makeRuntime();
		cfgMcpEnableProjectConfig.set(runtime.settings, false);
		const connect = mockConnections();

		const listResult = await runMcp("list", runtime);
		expect(listResult).toEqual({ consumed: true });
		expect(listedRows(outputs.at(-1))).toEqual({
			shared: { enabled: true, command: "user-command", scope: "user" },
			"user-only": { enabled: true, command: "user-only-command", scope: "user" },
		});

		const testResult = await runMcp("test shared", runtime);
		expect(testResult).toEqual({ consumed: true });
		expect(connect).toHaveBeenCalledWith("shared", expect.objectContaining({ command: "user-command" }), {
			live: true,
			cwd: projectDir,
		});

		const projectResult = await runMcp("test project-only", runtime);
		expect(projectResult).toEqual({ consumed: true, failed: true });
		expect(connect).toHaveBeenCalledTimes(1);
	});

	test("disable clears a force-enable so the server no longer connects", async () => {
		await writeConfig("project", {
			mcpServers: {
				forced: { type: "stdio", command: "project-forced", enabled: false },
			},
		});
		await writeConfig("user", {
			enabledServers: ["forced"],
		});
		const runtime = makeRuntime();
		const connect = mockConnections();

		const disabled = await runMcp("disable forced", runtime);
		expect(disabled).toEqual({ consumed: true });

		const testForced = await runMcp("test forced", runtime);
		expect(testForced).toEqual({ consumed: true, failed: true });
		expect(connect).not.toHaveBeenCalled();
		const userConfig = (await Bun.file(getMCPConfigPath("user", projectDir)).json()) as MCPConfigFile;
		expect(userConfig.enabledServers ?? []).not.toContain("forced");
	});

	test("enable clears a denylist entry so the server connects", async () => {
		await writeConfig("project", {
			mcpServers: {
				denied: { type: "stdio", command: "project-denied" },
			},
		});
		await writeConfig("user", {
			disabledServers: ["denied"],
		});
		const runtime = makeRuntime();
		const connect = mockConnections();

		const enabled = await runMcp("enable denied", runtime);
		expect(enabled).toEqual({ consumed: true });

		const testDenied = await runMcp("test denied", runtime);
		expect(testDenied).toEqual({ consumed: true });
		expect(connect).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledWith(
			"denied",
			expect.objectContaining({ command: "project-denied" }),
			expect.objectContaining({ cwd: projectDir }),
		);
		const userConfig = (await Bun.file(getMCPConfigPath("user", projectDir)).json()) as MCPConfigFile;
		expect(userConfig.disabledServers ?? []).not.toContain("denied");
	});

	test("disable edits only user config and leaves ignored project entries untouched when project config is off", async () => {
		await writeConfig("project", {
			mcpServers: {
				shared: { type: "stdio", command: "project-command" },
				"project-only": { type: "stdio", command: "project-only-command" },
			},
		});
		const projectPath = getMCPConfigPath("project", projectDir);
		const originalProjectText = await Bun.file(projectPath).text();
		await writeConfig("user", {
			mcpServers: {
				shared: { type: "stdio", command: "user-command" },
			},
		});
		const runtime = makeRuntime();
		cfgMcpEnableProjectConfig.set(runtime.settings, false);
		const connect = mockConnections();

		const disabledShared = await runMcp("disable shared", runtime);
		expect(disabledShared).toEqual({ consumed: true });

		const disabledProjectOnly = await runMcp("disable project-only", runtime);
		expect(disabledProjectOnly).toEqual({ consumed: true });

		const testShared = await runMcp("test shared", runtime);
		expect(testShared).toEqual({ consumed: true, failed: true });
		expect(connect).not.toHaveBeenCalled();
		expect(await Bun.file(projectPath).text()).toBe(originalProjectText);
		const userConfig = (await Bun.file(getMCPConfigPath("user", projectDir)).json()) as MCPConfigFile;
		expect(userConfig.mcpServers?.shared).toMatchObject({ enabled: false });
		expect(userConfig.disabledServers ?? []).toContain("project-only");
	});

	test("enable edits the user server when project config is off", async () => {
		await writeConfig("project", {
			mcpServers: {
				other: { type: "stdio", command: "project-other" },
			},
		});
		const projectPath = getMCPConfigPath("project", projectDir);
		const originalProjectText = await Bun.file(projectPath).text();
		await writeConfig("user", {
			mcpServers: {
				other: { type: "stdio", command: "user-other", enabled: false },
			},
		});
		const runtime = makeRuntime();
		cfgMcpEnableProjectConfig.set(runtime.settings, false);
		const connect = mockConnections();

		const enabled = await runMcp("enable other", runtime);
		expect(enabled).toEqual({ consumed: true });

		const testOther = await runMcp("test other", runtime);
		expect(testOther).toEqual({ consumed: true });
		expect(connect).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledWith(
			"other",
			expect.objectContaining({ command: "user-other" }),
			expect.objectContaining({ cwd: projectDir }),
		);
		expect(await Bun.file(projectPath).text()).toBe(originalProjectText);
		const userConfig = (await Bun.file(getMCPConfigPath("user", projectDir)).json()) as MCPConfigFile;
		expect(userConfig.mcpServers?.other).toMatchObject({ enabled: true });
		expect(userConfig.enabledServers ?? []).not.toContain("other");
	});

	test("disabling then re-enabling a force-enabled external server restores its override on reload", async () => {
		await Bun.write(
			path.join(projectDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					"ext-off": {
						type: "local",
						command: ["echo", "opencode"],
						enabled: false,
					},
				},
			}),
		);
		await writeConfig("user", {
			enabledServers: ["ext-off"],
		});
		clearFsCache();
		resetDiscoveryCache();
		const runtime = makeRuntime();

		expect((await loadAllMCPConfigs(projectDir, { filterExa: false })).configs["ext-off"]).toBeDefined();

		const disabled = await runMcp("disable ext-off", runtime);
		expect(disabled).toEqual({ consumed: true });
		clearFsCache();
		resetDiscoveryCache();
		expect((await loadAllMCPConfigs(projectDir, { filterExa: false })).configs["ext-off"]).toBeUndefined();

		const enabled = await runMcp("enable ext-off", runtime);
		expect(enabled).toEqual({ consumed: true });
		clearFsCache();
		resetDiscoveryCache();
		const reloaded = (await loadAllMCPConfigs(projectDir, { filterExa: false })).configs["ext-off"];
		expect(reloaded).toMatchObject({ type: "stdio", command: "echo" });
		const userConfig = (await Bun.file(getMCPConfigPath("user", projectDir)).json()) as MCPConfigFile;
		expect(userConfig.disabledServers ?? []).not.toContain("ext-off");
		expect(userConfig.enabledServers ?? []).toContain("ext-off");
	});
});
