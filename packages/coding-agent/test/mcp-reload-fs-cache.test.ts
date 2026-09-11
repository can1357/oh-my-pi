import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, readFile } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getMCPConfigPath, getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();

async function writeExternalProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
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

function createController(discoveredCommands: string[]) {
	const refreshMCPTools = vi.fn(async () => {});
	const setMCPPromptCommands = vi.fn();
	const mcpManager = createMcpManagerStub({
		discoverAndConnect: vi.fn(async () => {
			const configPath = getMCPConfigPath("project", getProjectDir());
			const content = await readFile(configPath);
			if (content) {
				const parsed = JSON.parse(content) as {
					mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>;
				};
				for (const server of Object.values(parsed.mcpServers ?? {})) {
					if (server.command) {
						discoveredCommands.push(server.command);
					}
					if (server.env) {
						discoveredCommands.push(...Object.values(server.env));
					}
				}
			}
			return { errors: new Map<string, string>(), connectedServers: [], tools: [], exaApiKeys: [] };
		}),
	});
	const controller = new MCPCommandController(
		createInteractiveModeContext({
			session: { refreshMCPTools, setMCPPromptCommands },
			mcpManager,
		}),
	);

	return { controller, mcpManager, refreshMCPTools, setMCPPromptCommands };
}

describe("/mcp reload picks up external mcp.json edits", () => {
	let projectDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reload-project-"));
		setProjectDir(projectDir);
		clearCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCache();
		setProjectDir(originalProjectDir);
		await removeWithRetries(projectDir);
	});

	test("reloadServers clears fs cache before rediscovery", async () => {
		const configPath = getMCPConfigPath("project", projectDir);
		await writeExternalProjectConfig(projectDir, {
			test: { type: "stdio", command: "old-cmd" },
		});

		const primed = await readFile(configPath);
		expect(primed).toContain("old-cmd");

		await Bun.write(
			configPath,
			`${JSON.stringify({ mcpServers: { test: { type: "stdio", command: "new-cmd" } } }, null, 2)}\n`,
		);

		const stale = await readFile(configPath);
		expect(stale).toContain("old-cmd");
		expect(stale).not.toContain("new-cmd");

		const discoveredCommands: string[] = [];
		const { controller, mcpManager, refreshMCPTools, setMCPPromptCommands } = createController(discoveredCommands);

		await controller.reloadServers();

		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(setMCPPromptCommands).toHaveBeenCalledWith([]);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		expect(discoveredCommands).toContain("new-cmd");
		expect(discoveredCommands).not.toContain("old-cmd");
	});
});
