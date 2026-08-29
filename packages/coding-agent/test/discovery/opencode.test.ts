import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { type Settings, settingsCapability } from "@oh-my-pi/pi-coding-agent/capability/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function loadOpenCodeMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["opencode"],
	});
	return result.items;
}

async function loadOpenCodeSettings(cwd: string): Promise<Settings[]> {
	const result = await loadCapability<Settings>(settingsCapability.id, {
		cwd,
		providers: ["opencode"],
	});
	return result.items;
}

describe("OpenCode MCP discovery", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-opencode-mcp-"));
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tempDir);
	});

	test("discovers commented JSONC config at user and project scopes", async () => {
		const projectDir = path.join(tempDir, "project");
		const userConfigDir = path.join(tempDir, ".config", "opencode");
		await fs.mkdir(projectDir);
		await fs.mkdir(userConfigDir, { recursive: true });

		await fs.writeFile(
			path.join(userConfigDir, "opencode.jsonc"),
			`{
				// User-level OpenCode config
				"model": "user-model",
				"mcp": {
					"user-jsonc": {
						"type": "local",
						"command": ["user-server"]
					}
				}
			}`,
		);
		await fs.writeFile(
			path.join(projectDir, "opencode.jsonc"),
			`{
				// Project-level OpenCode config
				"model": "project-model",
				"mcp": {
					"project-jsonc": {
						"type": "local",
						"command": ["project-server"]
					}
				}
			}`,
		);

		const [servers, discoveredSettings] = await Promise.all([
			loadOpenCodeMcpConfig(projectDir),
			loadOpenCodeSettings(projectDir),
		]);

		expect(servers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "user-jsonc", command: "user-server" }),
				expect.objectContaining({ name: "project-jsonc", command: "project-server" }),
			]),
		);
		expect(discoveredSettings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ level: "user", data: expect.objectContaining({ model: "user-model" }) }),
				expect.objectContaining({ level: "project", data: expect.objectContaining({ model: "project-model" }) }),
			]),
		);
	});

	test("loads project .opencode config after project-root config", async () => {
		const projectDir = path.join(tempDir, "project");
		const projectConfigDir = path.join(projectDir, ".opencode");
		await fs.mkdir(projectConfigDir, { recursive: true });

		await fs.writeFile(
			path.join(projectDir, "opencode.json"),
			JSON.stringify({
				model: "root-model",
				mcp: { shared: { type: "local", command: ["root-server"] } },
			}),
		);
		await fs.writeFile(
			path.join(projectConfigDir, "opencode.jsonc"),
			`{
				// Project .opencode config has higher precedence.
				"model": "dotdir-model",
				"mcp": { "shared": { "command": ["dotdir-server"] } }
			}`,
		);

		const [servers, discoveredSettings] = await Promise.all([
			loadOpenCodeMcpConfig(projectDir),
			loadOpenCodeSettings(projectDir),
		]);

		expect(servers.filter(server => server.name === "shared")).toEqual([
			expect.objectContaining({ command: "dotdir-server", transport: "stdio" }),
		]);
		expect(discoveredSettings.at(-1)).toMatchObject({
			path: path.join(projectConfigDir, "opencode.jsonc"),
			level: "project",
			data: expect.objectContaining({ model: "dotdir-model" }),
		});
	});

	test("resolves same-named MCP servers by OpenCode precedence", async () => {
		const projectDir = path.join(tempDir, "project");
		const userConfigDir = path.join(tempDir, ".config", "opencode");
		await fs.mkdir(projectDir);
		await fs.mkdir(userConfigDir, { recursive: true });

		// Lower precedence: user scope enables "shared" with the user command.
		await fs.writeFile(
			path.join(userConfigDir, "opencode.json"),
			JSON.stringify({
				mcp: { shared: { type: "local", command: ["user-server"], enabled: true } },
			}),
		);
		// Higher precedence: project opencode.json disables it with a different command.
		await fs.writeFile(
			path.join(projectDir, "opencode.json"),
			JSON.stringify({
				mcp: { shared: { type: "local", command: ["project-json-server"], enabled: false } },
			}),
		);
		// Highest precedence within the project scope: opencode.jsonc wins outright.
		await fs.writeFile(
			path.join(projectDir, "opencode.jsonc"),
			`{ "mcp": { "shared": { "type": "local", "command": ["project-jsonc-server"], "enabled": false } } }`,
		);

		const servers = await loadOpenCodeMcpConfig(projectDir);
		const shared = servers.filter(server => server.name === "shared");

		expect(shared).toHaveLength(1);
		expect(shared[0]).toMatchObject({ command: "project-jsonc-server", enabled: false });
	});

	test("preserves OAuth settings from remote OpenCode MCP servers", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					service: {
						type: "remote",
						url: "https://mcp.example.com/mcp",
						oauth: {
							clientId: "configured-client",
							clientSecret: "configured-secret",
							scope: "mcp:read mcp:write",
							callbackPort: 53192,
							redirectUri: "http://127.0.0.1:53192/callback",
						},
					},
				},
			}),
		);

		const [server] = await loadOpenCodeMcpConfig(tempDir);

		expect(server).toMatchObject({
			name: "service",
			oauth: {
				clientId: "configured-client",
				clientSecret: "configured-secret",
				scope: "mcp:read mcp:write",
				callbackPort: 53192,
				redirectUri: "http://127.0.0.1:53192/callback",
			},
		});
	});

	test("inherits lower-precedence fields on partial overrides", async () => {
		const projectDir = path.join(tempDir, "project");
		const userConfigDir = path.join(tempDir, ".config", "opencode");
		await fs.mkdir(projectDir);
		await fs.mkdir(userConfigDir, { recursive: true });

		// User scope carries the full definition.
		await fs.writeFile(
			path.join(userConfigDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					github: {
						type: "local",
						command: ["gh-server"],
						environment: { TOKEN: "user-token" },
					},
				},
			}),
		);
		// Project scope overrides only a single field; command/env must survive.
		await fs.writeFile(
			path.join(projectDir, "opencode.jsonc"),
			`{ "mcp": { "github": { "timeout": 5000, "environment": { "REGION": "eu" } } } }`,
		);

		const servers = await loadOpenCodeMcpConfig(projectDir);
		const github = servers.filter(server => server.name === "github");

		expect(github).toHaveLength(1);
		expect(github[0]).toMatchObject({
			command: "gh-server",
			transport: "stdio",
			timeout: 5000,
			env: { TOKEN: "user-token", REGION: "eu" },
		});
	});

	test("parses comments in opencode.json", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			`{
				// OpenCode parses either extension as JSONC.
				"mcp": {
					"commented-json": {
						"type": "local",
						"command": ["commented-server"]
					}
				}
			}`,
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);

		expect(servers).toEqual([
			expect.objectContaining({
				name: "commented-json",
				command: "commented-server",
			}),
		]);
	});
	test("normalizes array commands and OpenCode environment fields", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					sequentialthinking: {
						type: "local",
						command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
						enabled: true,
					},
					github: {
						type: "local",
						command: ["npx", "-y", "@modelcontextprotocol/server-github"],
						environment: {
							GITHUB_PERSONAL_ACCESS_TOKEN: "token",
						},
						enabled: true,
					},
					firecrawl: {
						type: "local",
						command: ["firecrawl-mcp"],
						env: {
							FIRECRAWL_API_KEY: "legacy-token",
						},
					},
				},
			}),
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);
		const byName = Object.fromEntries(servers.map(server => [server.name, server]));

		expect(byName.sequentialthinking).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
			transport: "stdio",
		});
		expect(byName.github).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: "token" },
			transport: "stdio",
		});
		expect(byName.firecrawl).toMatchObject({
			command: "firecrawl-mcp",
			env: { FIRECRAWL_API_KEY: "legacy-token" },
			transport: "stdio",
		});
		expect(byName.firecrawl?.args).toBeUndefined();
	});

	test("omits empty args for scalar OpenCode commands", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					plain: {
						type: "local",
						command: "server-bin",
					},
				},
			}),
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);
		const server = servers.find(item => item.name === "plain");

		expect(server?.command).toBe("server-bin");
		expect(server?.args).toBeUndefined();
	});

	test("expands OpenCode {env:VAR} and {file:path} substitutions", async () => {
		const secretFile = path.join(tempDir, "mcp-key.txt");
		await fs.writeFile(secretFile, "file-token\n");
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					"env-server": {
						type: "remote",
						url: "https://mcp.example.xyz/{env:OMP_TEST_MCP_PATH}",
						headers: { Authorization: "Bearer {env:OMP_TEST_MCP_KEY}" },
					},
					"file-server": {
						type: "remote",
						url: "https://mcp.example.xyz/mcp",
						headers: { Authorization: "Bearer {file:./mcp-key.txt}" },
					},
					"missing-server": {
						type: "remote",
						url: "https://mcp.example.xyz/mcp",
						headers: { Authorization: "Bearer {env:OMP_TEST_MCP_ABSENT}" },
					},
				},
			}),
		);

		delete Bun.env.OMP_TEST_MCP_ABSENT;
		Bun.env.OMP_TEST_MCP_KEY = "secret-token";
		Bun.env.OMP_TEST_MCP_PATH = "mcp/server";
		try {
			const servers = await loadOpenCodeMcpConfig(tempDir);
			const byName = Object.fromEntries(servers.map(server => [server.name, server]));

			expect(byName["env-server"]).toMatchObject({
				url: "https://mcp.example.xyz/mcp/server",
				headers: { Authorization: "Bearer secret-token" },
			});
			expect(byName["file-server"]?.headers).toEqual({ Authorization: "Bearer file-token" });
			// Unset env expands to empty string, matching OpenCode — never the literal token.
			expect(byName["missing-server"]?.headers).toEqual({ Authorization: "Bearer " });
		} finally {
			delete Bun.env.OMP_TEST_MCP_KEY;
			delete Bun.env.OMP_TEST_MCP_PATH;
		}
	});
});
