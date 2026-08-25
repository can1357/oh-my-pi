/**
 * Tests for `lazy: true` MCP server configs.
 *
 * Contract: a lazy server never spawns at startup. `connectServers` registers
 * the tool definitions cached from the last successful connect as
 * `DeferredMCPTool`s, and the first invocation connects on demand through the
 * tool's reconnect fallback (`waitForConnection` throws while nothing is in
 * flight → `reconnectServer` → `#doReconnect` from `#serverConfigs`). A lazy
 * server with no cache stays tool-less (seeded later by `/mcp reconnect`),
 * and an invalid lazy config still surfaces a startup failure event even when
 * no eager server put a name on the status list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { getConfigRootDir, removeSyncWithRetries, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { loadAllMCPConfigs } from "../src/mcp/config";
import "../src/discovery/builtin";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import { MCPManager } from "../src/mcp/manager";
import type { McpConnectionStatusEvent } from "../src/mcp/startup-events";
import { DeferredMCPTool } from "../src/mcp/tool-bridge";
import { MCPToolCache } from "../src/mcp/tool-cache";
import type { MCPStdioServerConfig, MCPToolDefinition } from "../src/mcp/types";
import type { AgentStorage } from "../src/session/agent-storage";
import { TOOL_NAME, TOOL_RESULT } from "./fixtures/lazy-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "lazy-mcp.ts");
const BUN_EXEC = process.execPath;

const TOOL_DEF: MCPToolDefinition = {
	name: TOOL_NAME,
	description: "Fixture tool served by the lazy-connect fixture.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function fakeStorage(): AgentStorage {
	const store = new Map<string, string>();
	return {
		getCache: (key: string) => store.get(key) ?? null,
		setCache: (key: string, value: string, _expiresAtSec: number) => {
			store.set(key, value);
		},
	} as unknown as AgentStorage;
}

function lazyConfig(markerPath: string): MCPStdioServerConfig {
	return {
		type: "stdio",
		command: BUN_EXEC,
		args: [FIXTURE_PATH],
		env: { LAZY_MCP_SPAWN_MARKER: markerPath },
		lazy: true,
	};
}

describe("MCP lazy connect", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lazy-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("registers cached tools at startup without spawning the server", async () => {
		const marker = path.join(workDir, "spawned.marker");
		const config = lazyConfig(marker);
		const cache = new MCPToolCache(fakeStorage());
		await cache.set("lazyfixture", config, [TOOL_DEF]);
		const manager = new MCPManager(workDir, cache);

		try {
			const result = await manager.connectServers({ lazyfixture: config }, {});

			expect(result.errors.size).toBe(0);
			const tools = result.tools.filter(tool => tool.mcpServerName === "lazyfixture");
			expect(tools).toHaveLength(1);
			expect(tools[0]).toBeInstanceOf(DeferredMCPTool);
			expect((tools[0] as DeferredMCPTool).mcpToolName).toBe(TOOL_NAME);

			// The whole point: nothing spawned, nothing connecting.
			expect(fs.existsSync(marker)).toBe(false);
			expect(manager.getConnectionStatus("lazyfixture")).toBe("disconnected");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("connects on demand when a deferred tool is first invoked", async () => {
		const marker = path.join(workDir, "spawned.marker");
		const config = lazyConfig(marker);
		const cache = new MCPToolCache(fakeStorage());
		await cache.set("lazyfixture", config, [TOOL_DEF]);
		const manager = new MCPManager(workDir, cache);

		try {
			const result = await manager.connectServers({ lazyfixture: config }, {});
			const tool = result.tools.find(candidate => candidate.mcpServerName === "lazyfixture");
			expect(tool).toBeInstanceOf(DeferredMCPTool);

			const outcome = await (tool as DeferredMCPTool).execute(
				"call-1",
				{},
				undefined,
				{} as CustomToolContext,
				undefined,
			);

			expect(JSON.stringify(outcome)).toContain(TOOL_RESULT);
			expect(fs.existsSync(marker)).toBe(true);
			expect(manager.getConnectionStatus("lazyfixture")).toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("stays tool-less without cached tools and reports no error", async () => {
		const marker = path.join(workDir, "spawned.marker");
		const config = lazyConfig(marker);
		const manager = new MCPManager(workDir, new MCPToolCache(fakeStorage()));

		try {
			const result = await manager.connectServers({ lazyfixture: config }, {});

			expect(result.errors.size).toBe(0);
			expect(result.tools.filter(tool => tool.mcpServerName === "lazyfixture")).toHaveLength(0);
			expect(fs.existsSync(marker)).toBe(false);
			expect(manager.getConnectionStatus("lazyfixture")).toBe("disconnected");
		} finally {
			await manager.disconnectAll();
		}
	});

	it("reports a startup failure for an invalid lazy config even with no eager servers", async () => {
		const config: MCPStdioServerConfig = { type: "stdio", command: "", lazy: true };
		const manager = new MCPManager(workDir, new MCPToolCache(fakeStorage()));
		const events: McpConnectionStatusEvent[] = [];

		try {
			const result = await manager.connectServers({ broken: config }, {}, event => events.push(event));

			expect(result.errors.get("broken")).toContain('requires "command"');
			expect(events.some(event => event.type === "failed" && event.serverName === "broken")).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	});
});

/**
 * Regression: `lazy` must survive the discovery pipeline, not just direct
 * `connectServers` calls. The builtin provider owns `~/.omp/agent/mcp.json`
 * and project `.omp/mcp.json` with its own field-by-field parse; dropping the
 * flag there silently turns a lazy server eager and re-fires its launch side
 * effects on every session boot (the deel secrets-wrapper incident).
 */
describe("lazy survives config discovery", () => {
	let tempHome = "";
	let projectDir = "";
	let userAgentDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mcp-lazy-home-"));
		projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mcp-lazy-project-"));
		userAgentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mcp-lazy-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
		await fs.promises.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.promises.writeFile(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { projlazy: { command: "proj-lazy-cmd", lazy: true } } }),
		);
		await fs.promises.writeFile(
			path.join(userAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					userlazy: { command: "user-lazy-cmd", lazy: true },
					usereager: { command: "user-eager-cmd" },
				},
			}),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	it("carries lazy from user and project mcp.json into server configs", async () => {
		const result = await loadAllMCPConfigs(projectDir, { filterExa: false });
		expect(result.configs.userlazy?.lazy).toBe(true);
		expect(result.configs.projlazy?.lazy).toBe(true);
		expect(result.configs.usereager?.lazy).toBeUndefined();
	});
});
