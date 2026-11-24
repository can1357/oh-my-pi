/**
 * Regression: `discoverAndLoadMCPTools` must forward the session's effective
 * extension roots to the manager. Dropping them made discovery (and every later
 * live reconcile, which reuses the stored discovery options) fall back to
 * ambient extension discovery, so MCP servers from session-provided extension
 * paths were never found.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverAndLoadMCPTools } from "@oh-my-pi/pi-coding-agent/mcp/loader";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery";
import { restoreEnvValue } from "./helpers/settings-test-state";

describe("discoverAndLoadMCPTools extension roots", () => {
	let root = "";
	let projectDir = "";
	let extensionDir = "";
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		root = "";
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		restoreEnvValue("CLAUDE_CONFIG_DIR", undefined);
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-loader-"));
		const tempHome = path.join(root, "home");
		projectDir = path.join(tempHome, "project");
		extensionDir = path.join(root, "extension");
		await fs.mkdir(path.join(projectDir, ".git"), { recursive: true });
		restoreEnvValue("HOME", tempHome);
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		await Bun.write(
			path.join(extensionDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { extensionserver: { command: "extension-mcp" } } }),
		);
		// Stand in for the transport only: report every resolved server as connected.
		vi.spyOn(MCPManager.prototype, "connectServers").mockImplementation(async configs => ({
			tools: [],
			errors: new Map(),
			connectedServers: Object.keys(configs),
			exaApiKeys: [],
		}));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		__resetDirsFromEnvForTests();
		clearClaudePluginRootsCache();
		if (root) await removeWithRetries(root);
	});

	test("discovers MCP servers from session-provided extension roots", async () => {
		const result = await discoverAndLoadMCPTools(projectDir, {
			filterExa: false,
			extensionRoots: { explicit: [extensionDir], mode: "explicit-only", configured: [], configuredLevel: "user" },
		});
		expect(result.connectedServers).toEqual(["extensionserver"]);
	});
});
