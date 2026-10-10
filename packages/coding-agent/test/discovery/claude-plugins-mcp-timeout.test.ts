import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { enableProvider, loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { __resetDirsFromEnvForTests, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";
describe("Claude plugin MCP timeout compatibility", () => {
	let tempDir: string;
	let testAgentDir: string;
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-"));
		testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-agent-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		// Point the agent dir at a temp dir so user-scope discovery (native MCP
		// config, skills, etc.) cannot read the real ~/.omp/agent profile.
		setAgentDir(testAgentDir);
		enableProvider("claude-plugins");
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		// setAgentDir() clears the profile env vars and snapshots the agent dir,
		// so restore every env var it can touch before rebuilding the resolver.
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalOmpProfileEnv === undefined) delete process.env.OMP_PROFILE;
		else process.env.OMP_PROFILE = originalOmpProfileEnv;
		if (originalPiProfileEnv === undefined) delete process.env.PI_PROFILE;
		else process.env.PI_PROFILE = originalPiProfileEnv;
		if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempDir);
		await removeWithRetries(testAgentDir);
	});

	/**
	 * Install a single user-scope marketplace plugin whose `.mcp.json` declares
	 * one stdio server carrying `timeout` (milliseconds in OMP/Claude Code).
	 * Returns the temp paths involved.
	 */
	async function installPluginWithTimeout(timeout: unknown): Promise<void> {
		const pluginPath = path.join(tempDir, "plugins", "sap-fiori-mcp-server");
		const registryPath = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");
		await fs.mkdir(path.join(tempDir, ".omp", "plugins"), { recursive: true });
		await fs.mkdir(pluginPath, { recursive: true });
		await fs.writeFile(
			path.join(pluginPath, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"fiori-mcp": {
						type: "stdio",
						timeout,
						command: "npx",
						args: ["--yes", "@sap-ux/fiori-mcp-server@latest", "fiori-mcp"],
					},
				},
			}),
		);
		await fs.writeFile(
			registryPath,
			JSON.stringify({
				version: 2,
				plugins: {
					"sap-fiori-mcp-server@claude-plugins-official": [
						{ scope: "user", installPath: pluginPath, version: "1.0.0" },
					],
				},
			}),
		);
	}

	async function loadPluginServers(): Promise<{ items: MCPServer[]; warnings: string[] }> {
		const result = await loadCapability<MCPServer>("mcps", { cwd: tempDir, providers: ["claude-plugins"] });
		return { items: result.items, warnings: result.warnings };
	}

	test("drops a sub-1000ms .mcp.json timeout instead of passing 600ms verbatim (#12485)", async () => {
		// Regression (#12485): SAP's official marketplace plugins ship
		// `"timeout": 600`, which Claude Code itself ignores (values below 1000
		// are invalid there and fall through to defaults). OMP read the value
		// verbatim as milliseconds, giving npx-spawned servers a 600ms connect
		// budget — they can never come up, so the plugin's tools never load.
		await installPluginWithTimeout(600);

		const { items, warnings } = await loadPluginServers();
		const server = items.find(i => i.name === "sap-fiori-mcp-server:fiori-mcp");

		expect(server).toBeDefined();
		// The invalid value must not survive: resolveMCPTimeoutMs(undefined)
		// then applies OMP's 30s default instead of 600ms.
		expect(server?.timeout).toBeUndefined();
		expect(warnings.some(w => w.includes("timeout"))).toBe(true);
	});

	test("keeps a >=1000ms .mcp.json timeout verbatim", async () => {
		await installPluginWithTimeout(60000);

		const { items, warnings } = await loadPluginServers();
		const server = items.find(i => i.name === "sap-fiori-mcp-server:fiori-mcp");

		expect(server?.timeout).toBe(60000);
		expect(warnings.some(w => w.includes("timeout"))).toBe(false);
	});

	test("the dropped-timeout warning survives the real MCP config consumer", async () => {
		// Regression (review on #14574): loadAllMCPConfigs() is the consumer
		// users actually hit at startup; if it discards result.warnings the
		// fix silently falls back to the default timeout.
		await installPluginWithTimeout(600);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await loadAllMCPConfigs(tempDir, { enableProjectConfig: false });
			expect(warn.mock.calls.some(([message]) => String(message).includes("timeout"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});
