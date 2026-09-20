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

describe("standalone mcp.json timeout units (#12485)", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-json-timeout-"));
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	test("treats a Claude-style timeout of 600 as 600 seconds", async () => {
		// Failure mode: SAP-style project `.mcp.json` `"timeout": 600` was 600ms.
		await fs.writeFile(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"fiori-mcp": { type: "stdio", timeout: 600, command: "npx" },
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server?.timeout).toBe(600_000);
	});

	test("keeps timeout 0 as disabled, millisecond values unchanged, and invalid ignored", async () => {
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					off: { command: "timeout-off", timeout: 0 },
					bad: { command: "timeout-bad", timeout: -1 },
					nativeMs: { command: "timeout-ms", timeout: 30_000 },
				},
			}),
		);

		const servers = await loadStandaloneMcpConfig(tempDir);
		const byName = Object.fromEntries(servers.map(s => [s.name, s]));
		expect(byName.off?.timeout).toBe(0);
		expect(byName.bad?.timeout).toBeUndefined();
		expect(byName.nativeMs?.timeout).toBe(30_000);
	});
});
