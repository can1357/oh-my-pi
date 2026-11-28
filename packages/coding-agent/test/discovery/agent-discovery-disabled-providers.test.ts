/**
 * Regression test for #1075:
 * discoverAgents() must skip marketplace plugin roots when claude-plugins is disabled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { resolveAgentModelPatterns } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getPluginsDir, removeSyncWithRetries } from "@oh-my-pi/pi-utils";
const PLUGIN_AGENT_MD = [
	"---",
	"name: simplifier",
	"description: A code simplifier agent from a Claude plugin",
	"model: opus",
	"---",
	"Simplify code.",
].join("\n");

describe("discoverAgents — claude-plugins disabled provider", () => {
	let tempHome: string;

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-disco-home-"));

		// Build a fake Claude-format plugin install with an agents/ subdirectory.
		const pluginInstallPath = path.join(tempHome, "plugin-cache", "code-simplifier");
		const agentsDir = path.join(pluginInstallPath, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "simplifier.md"), PLUGIN_AGENT_MD);
		fs.mkdirSync(path.join(pluginInstallPath, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(pluginInstallPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "code-simplifier" }),
		);

		// Register the plugin in the OMP registry so listClaudePluginRoots picks it up.
		const pluginsDir = getPluginsDir(tempHome);
		fs.mkdirSync(pluginsDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"code-simplifier@claude-plugins-official": [
						{
							installPath: pluginInstallPath,
							version: "1.0.0",
							scope: "user",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);

		// Start each test with a clean provider + cache state.
		enableProvider("claude-plugins");
		clearFsCache();
		clearClaudePluginRootsCache();
	});

	afterEach(() => {
		removeSyncWithRetries(tempHome);
		// Restore global state so other tests in the suite are not affected.
		enableProvider("claude-plugins");
		clearFsCache();
		clearClaudePluginRootsCache();
	});

	test("includes plugin agents while claude-plugins is enabled", async () => {
		const { agents } = await discoverAgents(tempHome, tempHome);
		const agent = agents.find(candidate => candidate.name === "simplifier");
		expect(agent).toBeDefined();
		expect(
			resolveAgentModelPatterns({
				agentModel: agent?.model,
				activeModelPattern: "openai-codex/gpt-5.6-sol",
			}),
		).toEqual(["openai-codex/gpt-5.6-sol"]);
	});

	test("excludes plugin agents when claude-plugins is disabled", async () => {
		disableProvider("claude-plugins");
		clearClaudePluginRootsCache();
		const { agents } = await discoverAgents(tempHome, tempHome);
		expect(agents.map(a => a.name)).not.toContain("simplifier");
	});
});
