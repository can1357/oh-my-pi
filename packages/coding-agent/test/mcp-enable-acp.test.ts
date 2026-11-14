/**
 * `/mcp enable` over the shared (ACP/RPC/print) dispatcher must start the
 * server, not just persist the flag: a lazy server whose `enabled` flips to
 * true but whose process never starts stays absent from the live session while
 * the command reports success.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getMCPConfigPath, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(os.tmpdir(), "omp-enable-acp-fallback-agent");

describe("/mcp enable (shared dispatcher)", () => {
	let projectDir = "";
	let agentDir = "";
	let configPath = "";
	const outputs: string[] = [];
	const connectServers = vi.fn(async () => ({ errors: new Map<string, string>() }));
	const disconnectServer = vi.fn(async () => {});
	const refreshMCPTools = vi.fn();

	function makeRuntime(): SlashCommandRuntime {
		return {
			session: { refreshMCPTools, effectiveExtensionRoots: undefined },
			sessionManager: {},
			cwd: projectDir,
			mcpManager: { connectServers, disconnectServer, getTools: () => [] },
			output: (text: string) => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: () => Promise.resolve(),
		} as unknown as SlashCommandRuntime;
	}

	beforeEach(async () => {
		outputs.length = 0;
		connectServers.mockClear();
		disconnectServer.mockClear();
		refreshMCPTools.mockClear();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-enable-acp-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-enable-acp-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
		configPath = getMCPConfigPath("project", projectDir);
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					lazy: { type: "stdio", command: "node", args: ["server.js"], enabled: false, lifecycle: "lazy" },
				},
			}),
		);
	});

	afterEach(async () => {
		setProjectDir(originalProjectDir);
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else setAgentDir(fallbackAgentDir);
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("enabling a lazy server connects it eagerly and refreshes session tools", async () => {
		await handleMcpAcp({ args: "enable lazy" } as ParsedSlashCommand, makeRuntime());

		expect(connectServers).toHaveBeenCalledTimes(1);
		expect(connectServers).toHaveBeenCalledWith(
			expect.objectContaining({ lazy: expect.objectContaining({ lifecycle: "lazy" }) }),
			expect.anything(),
			undefined,
			undefined,
			{ forceEager: true },
		);
		expect(refreshMCPTools).toHaveBeenCalledTimes(1);
		const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as {
			mcpServers: Record<string, { enabled?: boolean }>;
		};
		expect(saved.mcpServers.lazy?.enabled).toBe(true);
	});

	test("disabling a server disconnects it", async () => {
		await handleMcpAcp({ args: "disable lazy" } as ParsedSlashCommand, makeRuntime());

		expect(disconnectServer).toHaveBeenCalledWith("lazy");
		expect(connectServers).not.toHaveBeenCalled();
		expect(refreshMCPTools).toHaveBeenCalledTimes(1);
	});
});
