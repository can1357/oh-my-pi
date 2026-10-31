import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const ARGV_ECHO_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "argv-echo-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCPManager connection status events", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-status-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("emits connecting, connected, and failed updates for startup status", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const success: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};
		const invalid: MCPServerConfig = { type: "stdio", command: "" };

		try {
			// Window 0 waits for every server to settle; the default 250ms window
			// races the fixture's process spawn and flakes on loaded CI runners.
			const result = await manager.connectServers(
				{ alpha: success, broken: invalid },
				{},
				event => events.push(event),
				0,
			);

			expect(result.connectedServers).toContain("alpha");
			expect(result.errors.get("broken")).toBe('Server "broken": stdio server requires "command" field');
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["alpha", "broken"] },
				{ type: "failed", serverName: "broken", error: 'Server "broken": stdio server requires "command" field' },
				{ type: "connected", serverName: "alpha" },
			]);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("includes the originating config path when a discovered server fails to start", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const missingCommand = path.join(workDir, "missing-mcp-server");
		const configPath = path.join(os.homedir(), ".codex", "config.toml");

		try {
			const result = await manager.connectServers(
				{
					broken: {
						type: "stdio",
						command: missingCommand,
					},
				},
				{
					broken: {
						provider: "codex",
						providerName: "Codex",
						path: configPath,
						level: "user",
					},
				},
				event => events.push(event),
				0,
			);

			const message = result.errors.get("broken") ?? "";
			expect(message).toMatch(/ENOENT|No such file|not found/i);
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["broken"] },
				{
					type: "failed",
					serverName: "broken",
					error: message,
					sourcePath: configPath,
				},
			]);
		} finally {
			await manager.disconnectAll();
		}
	});
});

describe("MCPManager startup with unset env placeholders", () => {
	// Names no environment defines, so no test mutates them.
	const UNSET = "OMP_MCP_STATUS_TEST_UNSET_5B21E4";
	const OWN_KEY = "OMP_MCP_STATUS_TEST_OWN_KEY_5B21E4";
	const CMD_KEY = "OMP_MCP_STATUS_TEST_CMD_KEY_5B21E4";
	const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
	let homeDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-unset-home-"));
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-unset-agent-"));
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-unset-project-"));
		// Discovery reads only these temp dirs, never the real user's configs.
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		setAgentDir(agentDir);
		clearFsCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(homeDir);
		removeSyncWithRetries(agentDir);
		removeSyncWithRetries(projectDir);
	});

	it("fails the server naming the variable and field while a sibling from the same file connects", async () => {
		expect(Bun.env[UNSET]).toBeUndefined();
		expect(Bun.env[OWN_KEY]).toBeUndefined();
		expect(Bun.env[CMD_KEY]).toBeUndefined();
		fs.writeFileSync(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					// Port 9 refuses connections: without the guard this fails with a
					// transport error after sending the literal placeholder.
					github: {
						type: "http",
						url: "http://127.0.0.1:9/mcp",
						headers: { Authorization: `Bearer \${${UNSET}}` },
					},
					// Its own env block defines OWN_KEY and the command-backed
					// CMD_KEY; the child is spawned without a shell, so both must be
					// substituted into argv (CMD_KEY only once its command has run).
					sibling: {
						type: "stdio",
						command: BUN_EXEC,
						args: [ARGV_ECHO_FIXTURE_PATH, `--key=\${${OWN_KEY}}`, `--cmd=\${${CMD_KEY}}`],
						env: { [OWN_KEY]: "secret", [CMD_KEY]: "!echo cmd-secret" },
					},
				},
			}),
		);

		const { configs, sources } = await loadAllMCPConfigs(projectDir);
		const github = configs.github;
		const sibling = configs.sibling;
		expect(github).toBeDefined();
		expect(sibling).toBeDefined();
		const manager = new MCPManager(projectDir);
		const events: McpConnectionStatusEvent[] = [];

		try {
			const result = await manager.connectServers(
				{ github: github!, sibling: sibling! },
				{ github: sources.github!, sibling: sources.sibling! },
				event => events.push(event),
				0,
			);

			const message = `MCP server "github": environment variable ${UNSET} is not set (referenced in headers.Authorization)`;
			expect(result.errors.get("github")).toBe(message);
			expect(result.connectedServers).toEqual(["sibling"]);
			expect(events.find(event => event.type === "failed")).toMatchObject({
				type: "failed",
				serverName: "github",
				error: message,
			});
			expect(events).toContainEqual({ type: "connected", serverName: "sibling" });
			// The fixture reports the argv it was spawned with.
			const instructions = manager.getConnection("sibling")?.instructions;
			expect(instructions).toBeDefined();
			expect(JSON.parse(instructions!)).toEqual(["--key=secret", "--cmd=cmd-secret"]);
		} finally {
			await manager.disconnectAll();
		}
	});
});
