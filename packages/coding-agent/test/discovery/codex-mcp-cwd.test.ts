/**
 * Regression tests for Codex MCP config discovery (#5561, #7538).
 *
 * The Codex `config.toml` MCP importer in `packages/coding-agent/src/discovery/codex.ts`
 * used to copy only `command`/`args`/`url` into the returned `MCPServer`, dropping
 * `cwd` and leaving relative `command` values verbatim. MCP stdio spawning then
 * resolved those relative values against the OMP session cwd, so the bundled Codex
 * Computer Use server (a relative `command` with `cwd = "."`) failed with ENOENT.
 *
 * The importer now roots relative `command`/`cwd` at the config directory via
 * `resolvePluginStdioPaths`, matching the claude-plugins/omp-plugins fix in #5481.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tempHome = "";
let tempCwd = "";
let originalHome: string | undefined;

beforeEach(async () => {
	originalHome = process.env.HOME;
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-mcp-home-"));
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-mcp-cwd-"));
	process.env.HOME = tempHome;
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	await fs.mkdir(path.join(tempHome, ".codex"), { recursive: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await removeWithRetries(tempHome);
	await removeWithRetries(tempCwd);
});

async function loadCodexServers(): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd: tempCwd,
		providers: ["codex"],
	});
	return result.items;
}

test("disabled Codex MCP servers survive discovery tagged enabled: false (#7538)", async () => {
	const codexDir = path.join(tempHome, ".codex");
	await fs.writeFile(
		path.join(codexDir, "config.toml"),
		[
			"[mcp_servers.computer-use]",
			'command = "./Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient"',
			"enabled = false",
			"",
			"[mcp_servers.context7]",
			'command = "npx"',
			"enabled = true",
			"",
		].join("\n"),
	);

	const servers = await loadCodexServers();
	const cu = servers.find(server => server.name === "computer-use");
	const context7 = servers.find(server => server.name === "context7");

	// The disabled entry is NOT dropped: it stays so loadAllMCPConfigs' suppress
	// path can claim its dedupe key (keeping a same-named, lower-priority source
	// disabled) and honor the user force-enable allowlist. `enabled: true` is the
	// default, so it is not persisted onto the enabled sibling.
	expect(cu?.enabled).toBe(false);
	expect(context7?.command).toBe("npx");
	expect(context7?.enabled).toBeUndefined();
});

test("project Codex disable suppresses a same-named user server (#7538)", async () => {
	const userCodexDir = path.join(tempHome, ".codex");
	const projectCodexDir = path.join(tempCwd, ".codex");
	await fs.mkdir(projectCodexDir, { recursive: true });
	await Promise.all([
		fs.writeFile(
			path.join(userCodexDir, "config.toml"),
			["[mcp_servers.shared]", 'command = "user-server"', ""].join("\n"),
		),
		fs.writeFile(
			path.join(projectCodexDir, "config.toml"),
			["[mcp_servers.shared]", 'command = "project-server"', "enabled = false", ""].join("\n"),
		),
	]);

	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd: tempCwd,
		providers: ["codex"],
		suppress: server => server.enabled === false,
	});

	expect(result.items.find(server => server.name === "shared")).toBeUndefined();
});

test("relative path-like command and cwd resolve against the Codex config directory (#5561)", async () => {
	const codexDir = path.join(tempHome, ".codex");
	await fs.writeFile(
		path.join(codexDir, "config.toml"),
		[
			"[mcp_servers.computer-use]",
			'command = "./bin/SkyComputerUseClient"',
			'args = ["mcp"]',
			'cwd = "."',
			"",
			"[mcp_servers.bare]",
			'command = "npx"',
			'args = ["-y", "@some/mcp"]',
			"",
		].join("\n"),
	);

	const servers = await loadCodexServers();
	const cu = servers.find(s => s.name === "computer-use");
	const bare = servers.find(s => s.name === "bare");

	// Path-like command and "." cwd rebase onto the config directory (~/.codex),
	// not the session cwd. Bare executables are left untouched.
	expect(cu?.command).toBe(path.join(codexDir, "bin", "SkyComputerUseClient"));
	expect(cu?.cwd).toBe(codexDir);
	expect(cu?.args).toEqual(["mcp"]);
	expect(bare?.command).toBe("npx");
	expect(bare?.cwd).toBeUndefined();
});

test("path-like command resolves against a subdirectory cwd, not the config directory (#5562 review)", async () => {
	const codexDir = path.join(tempHome, ".codex");
	await fs.writeFile(
		path.join(codexDir, "config.toml"),
		["[mcp_servers.nested]", 'command = "./bin/mcp"', 'args = ["serve"]', 'cwd = "server"', ""].join("\n"),
	);

	const servers = await loadCodexServers();
	const nested = servers.find(s => s.name === "nested");

	// The transport spawns the subprocess with the rooted cwd; a relative command
	// is resolved by the OS from there. cwd="server" + command="./bin/mcp" must
	// resolve to <codexDir>/server/bin/mcp, not <codexDir>/bin/mcp.
	expect(nested?.cwd).toBe(path.join(codexDir, "server"));
	expect(nested?.command).toBe(path.join(codexDir, "server", "bin", "mcp"));
});

test("Codex OAuth scopes import as the space-separated authorization scope string", async () => {
	const codexDir = path.join(tempHome, ".codex");
	await fs.writeFile(
		path.join(codexDir, "config.toml"),
		[
			"[mcp_servers.gateway]",
			'url = "https://gateway.example.com/mcp"',
			'scopes = ["https://gateway.example.com/mcp/mcp.invoke", "openid"]',
			"",
			"[mcp_servers.suppressed]",
			'url = "https://suppressed.example.com/mcp"',
			"scopes = []",
			"",
			"[mcp_servers.plain]",
			'url = "https://plain.example.com/mcp"',
			"",
		].join("\n"),
	);

	const servers = await loadCodexServers();

	// Codex stores scopes as an array; the authorization request needs the
	// space-separated form, so the importer joins them rather than dropping them.
	expect(servers.find(server => server.name === "gateway")?.oauth).toEqual({
		scopes: "https://gateway.example.com/mcp/mcp.invoke openid",
	});
	// An explicitly empty list suppresses the `scope` parameter, which is a
	// different authorization request than sending discovered scopes.
	expect(servers.find(server => server.name === "suppressed")?.oauth).toEqual({ scopes: "" });
	expect(servers.find(server => server.name === "plain")?.oauth).toBeUndefined();
});
