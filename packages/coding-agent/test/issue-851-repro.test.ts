import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";

describe("issue-851: claude-plugins loads flat .mcp.json shape", () => {
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
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-851-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		await removeWithRetries(tempDir);
	});

	async function setupPlugin(pluginId: string, mcpJson: unknown): Promise<void> {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", pluginId);
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(pluginPath, { recursive: true });

		const registry = {
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
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(path.join(pluginPath, ".mcp.json"), JSON.stringify(mcpJson));
	}

	test("flat shape (top-level keys are server names) registers servers", async () => {
		await setupPlugin("context7", {
			context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
		});

		const result = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		const found = result.all.find(s => s.name === "context7:context7");
		expect(found).toBeDefined();
		expect(found?.command).toBe("npx");
		expect(found?.args).toEqual(["-y", "@upstash/context7-mcp"]);
	});

	test("flat shape with HTTP transport (url) registers", async () => {
		await setupPlugin("gitlab", {
			gitlab: { url: "https://gitlab.com/mcp", type: "http" },
		});

		const result = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		const found = result.all.find(s => s.name === "gitlab:gitlab");
		expect(found).toBeDefined();
		expect(found?.url).toBe("https://gitlab.com/mcp");
		expect(found?.transport).toBe("http");
	});

	test("flat shape skips entries without command/url", async () => {
		await setupPlugin("mixed", {
			good: { command: "npx" },
			bad: { description: "missing command and url" },
		});

		const result = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		expect(result.all.find(s => s.name === "mixed:good")).toBeDefined();
		expect(result.all.find(s => s.name === "mixed:bad")).toBeUndefined();
	});
});
