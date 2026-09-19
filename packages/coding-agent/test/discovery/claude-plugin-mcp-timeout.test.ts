/**
 * Regression for #12485: Claude marketplace plugin `.mcp.json` `timeout` is
 * seconds (SAP `"timeout": 600` = 600s). OMP's canonical MCP timeout is
 * milliseconds, so copying the number verbatim aborted npx-started servers
 * after 600ms. Native `.omp/mcp.json` already documents milliseconds and must
 * keep those values as-is.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableUserSource, enableUserSource, loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";
import "@oh-my-pi/pi-coding-agent/discovery/builtin";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("Claude plugin MCP timeout units (#12485)", () => {
	let tempDir: string;
	let originalHome: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete Bun.env.CLAUDE_CONFIG_DIR;
		originalHome = process.env.HOME;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugin-mcp-timeout-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		enableUserSource("claude");
	});

	afterEach(async () => {
		disableUserSource("claude");
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		await removeWithRetries(tempDir);
	});

	async function setupPlugin(pluginId: string, mcpJson: unknown): Promise<void> {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", pluginId);
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(pluginPath, { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					[`${pluginId}@claude-plugins-official`]: [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);
		await fs.writeFile(path.join(pluginPath, ".mcp.json"), JSON.stringify(mcpJson));
	}

	test("converts plugin timeout 600 from seconds to milliseconds", async () => {
		await setupPlugin("sap-fiori-mcp-server", {
			mcpServers: {
				"fiori-mcp": {
					type: "stdio",
					timeout: 600,
					command: "npx",
					args: ["--yes", "@sap-ux/fiori-mcp-server@latest", "fiori-mcp"],
				},
			},
		});

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});
		const found = result.items.find(s => s.name === "sap-fiori-mcp-server:fiori-mcp");
		expect(found?.timeout).toBe(600_000);
	});

	test("keeps plugin timeout 0 as disabled", async () => {
		await setupPlugin("no-deadline", {
			mcpServers: {
				slow: { command: "npx", timeout: 0 },
			},
		});

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});
		expect(result.items.find(s => s.name === "no-deadline:slow")?.timeout).toBe(0);
	});

	test("leaves plugin millisecond timeouts unchanged", async () => {
		await setupPlugin("already-ms", {
			mcpServers: {
				server: { command: "npx", timeout: 30_000 },
			},
		});

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});
		expect(result.items.find(s => s.name === "already-ms:server")?.timeout).toBe(30_000);
	});

	test("ignores invalid plugin timeout values", async () => {
		await setupPlugin("bad-timeout", {
			mcpServers: {
				server: { command: "npx", timeout: -1 },
			},
		});

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});
		expect(result.items.find(s => s.name === "bad-timeout:server")?.timeout).toBeUndefined();
	});

	test("does not convert native OMP millisecond timeouts below 1000", async () => {
		const agentDir = path.join(tempDir, ".omp", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		setAgentDir(agentDir);
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					native: { command: "native-mcp", timeout: 600 },
				},
			}),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["native"],
		});
		expect(result.items.find(s => s.name === "native")?.timeout).toBe(600);
	});
});
