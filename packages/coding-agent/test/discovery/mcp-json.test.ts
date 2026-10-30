import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function loadStandaloneMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["mcp-json"],
	});
	return result.items;
}

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}

describe("standalone mcp.json oauth env expansion", () => {
	let tempDir = "";
	const originalEnv = {
		PI_OAUTH_TOKEN_URL: process.env.PI_OAUTH_TOKEN_URL,
		PI_OAUTH_CLIENT_ID: process.env.PI_OAUTH_CLIENT_ID,
		PI_OAUTH_CLIENT_SECRET: process.env.PI_OAUTH_CLIENT_SECRET,
		PI_OAUTH_REDIRECT_URI: process.env.PI_OAUTH_REDIRECT_URI,
		PI_OAUTH_CALLBACK_PATH: process.env.PI_OAUTH_CALLBACK_PATH,
		PI_MCP_HEADER: process.env.PI_MCP_HEADER,
		PI_MCP_URL: process.env.PI_MCP_URL,
		PI_MCP_ENV: process.env.PI_MCP_ENV,
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-json-"));
		process.env.PI_OAUTH_TOKEN_URL = "https://provider.example/token";
		process.env.PI_OAUTH_CLIENT_ID = "oauth-client-id";
		process.env.PI_OAUTH_CLIENT_SECRET = "oauth-client-secret";
		process.env.PI_OAUTH_REDIRECT_URI = "https://public.example/oauth/callback";
		process.env.PI_OAUTH_CALLBACK_PATH = "/oauth/callback";
		process.env.PI_MCP_HEADER = "Bearer test-token";
		process.env.PI_MCP_URL = "https://mcp.example.com";
		process.env.PI_MCP_ENV = "env-value";
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("expands standalone auth and oauth fields alongside existing env-expanded fields", async () => {
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						url: `${envPlaceholder("PI_MCP_URL")}/mcp`,
						headers: { Authorization: envPlaceholder("PI_MCP_HEADER") },
						env: { MCP_VALUE: envPlaceholder("PI_MCP_ENV") },
						auth: {
							type: "oauth",
							tokenUrl: envPlaceholder("PI_OAUTH_TOKEN_URL"),
							clientId: envPlaceholder("PI_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("PI_OAUTH_CLIENT_SECRET"),
						},
						oauth: {
							clientId: envPlaceholder("PI_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("PI_OAUTH_CLIENT_SECRET"),
							redirectUri: envPlaceholder("PI_OAUTH_REDIRECT_URI"),
							callbackPort: 4317,
							callbackPath: envPlaceholder("PI_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.url).toBe("https://mcp.example.com/mcp");
		expect(server?.headers).toEqual({ Authorization: "Bearer test-token" });
		expect(server?.env).toEqual({ MCP_VALUE: "env-value" });
		expect(server?.auth).toEqual({
			type: "oauth",
			tokenUrl: "https://provider.example/token",
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
		});
		expect(server?.oauth).toEqual({
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
			redirectUri: "https://public.example/oauth/callback",
			callbackPort: 4317,
			callbackPath: "/oauth/callback",
		});
	});

	test("expands only the standalone oauth fields that are present", async () => {
		await fs.writeFile(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					slack: {
						url: "https://slack.example.com/mcp",
						oauth: {
							redirectUri: envPlaceholder("PI_OAUTH_REDIRECT_URI"),
							callbackPath: envPlaceholder("PI_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.oauth).toEqual({
			redirectUri: "https://public.example/oauth/callback",
			callbackPath: "/oauth/callback",
		});
		expect(server?.auth).toBeUndefined();
	});
});

describe("standalone mcp.json unresolved env placeholders", () => {
	// Names no environment defines, so no test mutates process.env.
	const UNSET = "OMP_MCP_JSON_TEST_UNSET_7F3A9C";
	const OWN_KEY = "OMP_MCP_JSON_TEST_OWN_KEY_7F3A9C";
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-json-unresolved-"));
		expect(Bun.env[UNSET]).toBeUndefined();
		expect(Bun.env[OWN_KEY]).toBeUndefined();
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	async function load(mcpServers: Record<string, unknown>): Promise<Map<string, MCPServer>> {
		await fs.writeFile(path.join(tempDir, ".mcp.json"), JSON.stringify({ mcpServers }));
		const servers = await loadStandaloneMcpConfig(tempDir);
		return new Map(servers.map(server => [server.name, server]));
	}

	test("records an unset header variable on that server only", async () => {
		const servers = await load({
			github: {
				type: "http",
				url: "https://api.githubcopilot.com/mcp/",
				headers: { Authorization: `Bearer ${envPlaceholder(UNSET)}` },
			},
			sibling: { type: "http", url: "https://sibling.example/mcp" },
		});

		expect(servers.get("github")?.unresolvedEnv).toEqual([{ variable: UNSET, field: "headers.Authorization" }]);
		expect(servers.get("sibling")).toBeDefined();
		expect(servers.get("sibling")?.unresolvedEnv).toBeUndefined();
	});

	test("treats a variable from the server's own env block as resolved in args", async () => {
		const servers = await load({
			ownEnv: {
				command: "sh",
				args: ["-c", `run --key ${envPlaceholder(OWN_KEY)}`],
				env: { [OWN_KEY]: "secret" },
			},
			noEnv: {
				command: "sh",
				args: ["-c", `run --key ${envPlaceholder(OWN_KEY)}`],
			},
		});

		expect(servers.get("ownEnv")?.unresolvedEnv).toBeUndefined();
		// The spawned shell expands it from env, so the literal must survive.
		expect(servers.get("ownEnv")?.args).toEqual(["-c", `run --key ${envPlaceholder(OWN_KEY)}`]);
		expect(servers.get("noEnv")?.unresolvedEnv).toEqual([{ variable: OWN_KEY, field: "args[1]" }]);
	});

	test("uses the default of an unset placeholder with :- without flagging it", async () => {
		const servers = await load({
			remote: {
				type: "http",
				url: "https://remote.example/mcp",
				headers: {
					"X-Region": `\${${UNSET}:-us-east-1}`,
					Authorization: envPlaceholder(UNSET),
				},
			},
		});

		const remote = servers.get("remote");
		expect(remote?.headers?.["X-Region"]).toBe("us-east-1");
		expect(remote?.unresolvedEnv).toEqual([{ variable: UNSET, field: "headers.Authorization" }]);
	});

	test("keeps an unset VS Code predefined variable literal without flagging it", async () => {
		expect(Bun.env.workspaceFolder).toBeUndefined();
		const servers = await load({
			local: {
				command: "node",
				args: [`${envPlaceholder("workspaceFolder")}/server.js`, envPlaceholder(UNSET)],
			},
		});

		const local = servers.get("local");
		expect(local?.args).toEqual([`${envPlaceholder("workspaceFolder")}/server.js`, envPlaceholder(UNSET)]);
		expect(local?.unresolvedEnv).toEqual([{ variable: UNSET, field: "args[1]" }]);
	});
});
