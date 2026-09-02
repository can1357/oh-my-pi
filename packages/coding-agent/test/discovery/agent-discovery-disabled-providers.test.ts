/**
 * Regression test for #1075:
 * discoverAgents() must skip Claude plugin roots when claude-plugins is disabled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";
const PLUGIN_AGENT_MD = [
	"---",
	"name: simplifier",
	"description: A code simplifier agent from a Claude plugin",
	"---",
	"Simplify code.",
].join("\n");

describe("discoverAgents — claude-plugins disabled provider", () => {
	let tempHome: string;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(() => {
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete Bun.env.CLAUDE_CONFIG_DIR;
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-disco-home-"));

		// Build a fake Claude plugin install with an agents/ subdirectory.
		const pluginInstallPath = path.join(tempHome, "plugin-cache", "code-simplifier");
		const agentsDir = path.join(pluginInstallPath, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "simplifier.md"), PLUGIN_AGENT_MD);

		// Register the plugin in the Claude registry so listClaudePluginRoots picks it up.
		const claudePluginsDir = path.join(tempHome, ".claude", "plugins");
		fs.mkdirSync(claudePluginsDir, { recursive: true });
		fs.writeFileSync(
			path.join(claudePluginsDir, "installed_plugins.json"),
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
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		enableProvider("claude-plugins");
		clearFsCache();
		clearClaudePluginRootsCache();
	});

	test("includes plugin agents when claude-plugins is enabled", async () => {
		const { agents } = await discoverAgents(tempHome, tempHome);
		expect(agents.map(a => a.name)).toContain("simplifier");
	});

	test("excludes plugin agents when claude-plugins is disabled", async () => {
		disableProvider("claude-plugins");
		clearClaudePluginRootsCache();
		const { agents } = await discoverAgents(tempHome, tempHome);
		expect(agents.map(a => a.name)).not.toContain("simplifier");
	});
});
