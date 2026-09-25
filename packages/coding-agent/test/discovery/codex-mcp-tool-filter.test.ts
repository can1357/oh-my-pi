import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let root = "";
let home = "";
let project = "";
let originalHome: string | undefined;

beforeEach(async () => {
	clearFsCache();
	resetSettingsForTest();
	originalHome = process.env.HOME;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-mcp-filter-"));
	home = path.join(root, "home");
	project = path.join(root, "project");
	process.env.HOME = home;
	vi.spyOn(os, "homedir").mockReturnValue(home);
	await fs.mkdir(path.join(project, ".git"), { recursive: true });
});

afterEach(async () => {
	clearFsCache();
	resetSettingsForTest();
	vi.restoreAllMocks();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await removeWithRetries(root);
});

async function loadCodexServers(): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd: project,
		providers: ["codex"],
	});
	return result.items;
}

test("Codex maps enabled_tools/disabled_tools onto the canonical filter", async () => {
	const file = path.join(project, ".codex", "config.toml");
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(
		file,
		`[mcp_servers.filtered]
command = "/bin/true"
enabled_tools = ["read_*"]
disabled_tools = ["read_secret"]
`,
	);

	const servers = await loadCodexServers();
	const server = servers.find(item => item.name === "filtered");
	expect(server).toBeDefined();
	expect(server?.enabledTools).toEqual(["read_*"]);
	expect(server?.disabledTools).toEqual(["read_secret"]);
});

test("Codex omits the filter when no tool keys are configured", async () => {
	const file = path.join(project, ".codex", "config.toml");
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(
		file,
		`[mcp_servers.plain]
command = "/bin/true"
`,
	);

	const servers = await loadCodexServers();
	const server = servers.find(item => item.name === "plain");
	expect(server).toBeDefined();
	expect(server?.enabledTools).toBeUndefined();
	expect(server?.disabledTools).toBeUndefined();
});
