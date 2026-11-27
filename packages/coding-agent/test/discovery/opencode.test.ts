import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function loadOpenCodeMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
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

	test("ignores user-level OpenCode config", async () => {
		const projectDir = path.join(tempDir, "project");
		const userConfigDir = path.join(tempDir, ".config", "opencode");
		await fs.mkdir(projectDir);
		await fs.mkdir(userConfigDir, { recursive: true });

		await fs.writeFile(
			path.join(userConfigDir, "opencode.jsonc"),
			JSON.stringify({ mcp: { "user-jsonc": { type: "local", command: ["user-server"] } } }),
		);
		await fs.writeFile(
			path.join(projectDir, "opencode.jsonc"),
			JSON.stringify({ mcp: { "project-jsonc": { type: "local", command: ["project-server"] } } }),
		);

		const servers = await loadOpenCodeMcpConfig(projectDir);

		expect(servers).toEqual([expect.objectContaining({ name: "project-jsonc", command: "project-server" })]);
	});

	test("discovers OpenCode v2 servers rather than the mcp.servers container", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.jsonc"),
			JSON.stringify({
				mcp: {
					timeout: 10_000,
					servers: {
						demo: { type: "local", command: ["node", "demo.js"] },
					},
				},
			}),
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);

		expect(servers).toEqual([
			expect.objectContaining({ name: "demo", command: "node", args: ["demo.js"], transport: "stdio" }),
		]);
	});

	test("merges v2 overrides with legacy flat servers across config layers", async () => {
		const projectDir = path.join(tempDir, "project");
		await fs.mkdir(path.join(projectDir, ".opencode"), { recursive: true });

		await fs.writeFile(
			path.join(projectDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					demo: { type: "local", command: ["node", "demo.js"], environment: { TOKEN: "root" } },
				},
			}),
		);
		await fs.writeFile(
			path.join(projectDir, ".opencode", "opencode.jsonc"),
			JSON.stringify({
				mcp: { timeout: 10_000, servers: { demo: { environment: { REGION: "project" } } } },
			}),
		);

		const servers = await loadOpenCodeMcpConfig(projectDir);

		expect(servers).toEqual([
			expect.objectContaining({
				name: "demo",
				command: "node",
				args: ["demo.js"],
				env: { TOKEN: "root", REGION: "project" },
			}),
		]);
	});

	test("keeps a legacy flat server named servers", async () => {
		await fs.writeFile(
			path.join(tempDir, "opencode.json"),
			JSON.stringify({ mcp: { servers: { type: "local", command: ["node", "legacy.js"] } } }),
		);

		const servers = await loadOpenCodeMcpConfig(tempDir);

		expect(servers).toEqual([expect.objectContaining({ name: "servers", command: "node", args: ["legacy.js"] })]);
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

		const servers = await loadOpenCodeMcpConfig(projectDir);

		expect(servers.filter(server => server.name === "shared")).toEqual([
			expect.objectContaining({ command: "dotdir-server", transport: "stdio" }),
		]);
	});

	test("resolves same-named MCP servers by OpenCode precedence", async () => {
		const projectDir = path.join(tempDir, "project");
		const projectConfigDir = path.join(projectDir, ".opencode");
		await fs.mkdir(projectConfigDir, { recursive: true });

		// Lowest precedence: project-root opencode.json enables "shared" with the root command.
		await fs.writeFile(
			path.join(projectDir, "opencode.json"),
			JSON.stringify({
				mcp: { shared: { type: "local", command: ["root-json-server"], enabled: true } },
			}),
		);
		// Higher precedence: project-root opencode.jsonc disables it with a different command.
		await fs.writeFile(
			path.join(projectDir, "opencode.jsonc"),
			JSON.stringify({
				mcp: { shared: { type: "local", command: ["root-jsonc-server"], enabled: false } },
			}),
		);
		// Highest precedence: .opencode/opencode.jsonc wins outright.
		await fs.writeFile(
			path.join(projectConfigDir, "opencode.jsonc"),
			`{ "mcp": { "shared": { "type": "local", "command": ["dotdir-server"], "enabled": false } } }`,
		);

		const servers = await loadOpenCodeMcpConfig(projectDir);
		const shared = servers.filter(server => server.name === "shared");

		expect(shared).toHaveLength(1);
		expect(shared[0]).toMatchObject({ command: "dotdir-server", enabled: false });
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
		await fs.mkdir(path.join(projectDir, ".opencode"), { recursive: true });

		// Project-root config carries the full definition.
		await fs.writeFile(
			path.join(projectDir, "opencode.json"),
			JSON.stringify({
				mcp: {
					github: {
						type: "local",
						command: ["gh-server"],
						environment: { TOKEN: "root-token" },
					},
				},
			}),
		);
		// .opencode config overrides only a single field; command/env must survive.
		await fs.writeFile(
			path.join(projectDir, ".opencode", "opencode.jsonc"),
			`{ "mcp": { "github": { "timeout": 5000, "environment": { "REGION": "eu" } } } }`,
		);

		const servers = await loadOpenCodeMcpConfig(projectDir);
		const github = servers.filter(server => server.name === "github");

		expect(github).toHaveLength(1);
		expect(github[0]).toMatchObject({
			command: "gh-server",
			transport: "stdio",
			timeout: 5000,
			env: { TOKEN: "root-token", REGION: "eu" },
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
