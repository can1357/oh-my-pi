import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function loadMcp(cwd: string, provider: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: [provider],
	});
	return result.items;
}

interface Fixture {
	/** Discovery provider id passed to `loadCapability`. */
	provider: string;
	/** Project-relative config file the importer reads. */
	file: string;
	/** File body carrying a single server with `enabled: false`. */
	content: string;
}

// Project-scoped config for each translated importer that previously dropped the
// per-server `enabled` flag (issue #7652). Codex/OpenCode/native already
// propagate it and are covered elsewhere.
const FIXTURES: Fixture[] = [
	{
		provider: "claude",
		file: ".claude/.mcp.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "cursor",
		file: ".cursor/mcp.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "gemini",
		file: ".gemini/settings.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "windsurf",
		file: ".windsurf/mcp_config.json",
		content: JSON.stringify({
			mcpServers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } },
		}),
	},
	{
		provider: "vscode",
		file: ".vscode/mcp.json",
		content: JSON.stringify({
			mcp: { servers: { markitdown: { command: "uvx", args: ["markitdown-mcp"], type: "stdio", enabled: false } } },
		}),
	},
];

interface CompoundFixture {
	/** Discovery provider id passed to `loadCapability`. */
	provider: string;
	/** User-scope config file, relative to the temp HOME. */
	userFile: string;
	/** Project-scope config file, relative to the temp cwd. */
	projectFile: string;
}

// Providers exposing both a user and a project MCP scope. A project
// `enabled: false` must claim the dedupe key ahead of the same-named user
// server so the disable actually suppresses it (#7654). VS Code MCP is
// project-only, so it has no user/project compound case.
const COMPOUND_FIXTURES: CompoundFixture[] = [
	{ provider: "claude", userFile: ".claude.json", projectFile: ".claude/.mcp.json" },
	{ provider: "cursor", userFile: ".cursor/mcp.json", projectFile: ".cursor/mcp.json" },
	{ provider: "gemini", userFile: ".gemini/settings.json", projectFile: ".gemini/settings.json" },
	{ provider: "windsurf", userFile: ".codeium/windsurf/mcp_config.json", projectFile: ".windsurf/mcp_config.json" },
];

function mcpServersJson(enabled: boolean, command: string): string {
	return JSON.stringify({
		mcpServers: { markitdown: { command, args: ["markitdown-mcp"], type: "stdio", enabled } },
	});
}

describe("translated MCP importers propagate enabled: false", () => {
	let tempCwd = "";
	let tempHome = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-enabled-cwd-"));
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-enabled-home-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempCwd);
		await removeWithRetries(tempHome);
	});

	for (const { provider, file, content } of FIXTURES) {
		test(`${provider} carries enabled: false`, async () => {
			const filePath = path.join(tempCwd, file);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content);

			const servers = await loadMcp(tempCwd, provider);
			const server = servers.find(item => item.name === "markitdown");

			expect(server).toBeDefined();
			expect(server?.enabled).toBe(false);
		});
	}

	for (const { provider, userFile, projectFile } of COMPOUND_FIXTURES) {
		test(`${provider} project enabled: false suppresses a same-named user server`, async () => {
			const userPath = path.join(tempHome, userFile);
			const projectPath = path.join(tempCwd, projectFile);
			await fs.mkdir(path.dirname(userPath), { recursive: true });
			await fs.mkdir(path.dirname(projectPath), { recursive: true });
			await fs.writeFile(userPath, mcpServersJson(true, "user-markitdown"));
			await fs.writeFile(projectPath, mcpServersJson(false, "project-markitdown"));

			const result = await loadCapability<MCPServer>(mcpCapability.id, {
				cwd: tempCwd,
				providers: [provider],
				suppress: server => server.enabled === false,
			});

			expect(result.items.find(server => server.name === "markitdown")).toBeUndefined();
		});
	}
});
