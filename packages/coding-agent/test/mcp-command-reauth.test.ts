import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai";
import * as mcpClient from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import * as oauthFlow from "@pk-nerdsaver-ai/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	setAgentDir,
	setProjectDir,
} from "@pk-nerdsaver-ai/pi-utils";

const RAW_SERVER_URL = `https://\${MCP_HOST}/mcp`;
const EXPANDED_SERVER_URL = "https://mcp.example.com/mcp";
const AUTH_ISSUER = "https://auth.example.com/";
const AUTH_ERROR = new Error(
	`HTTP 401: {"issuer":"${AUTH_ISSUER}","authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}`,
);

type TestConfigFile = {
	mcpServers?: Record<string, MCPServerConfig>;
};

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreEnvValue(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		delete process.env[name];
		return;
	}
	Bun.env[name] = value;
	process.env[name] = value;
}
function createController(authStorage: AuthStorage, mcpManagerOverrides: Record<string, unknown> = {}) {
	const showError = vi.fn();
	const prepareConfig = vi.fn(async (config: MCPServerConfig) => config);
	const mcpManager = {
		prepareConfig,
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async () => ({ errors: new Map<string, string>() })),
		getTools: vi.fn(() => []),
		waitForConnection: vi.fn(async () => {}),
		getConnectionStatus: vi.fn(() => "connected"),
		...mcpManagerOverrides,
	};
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present: vi.fn(),
		ui: { requestRender: vi.fn() },
		editor: {},
		showError,
		showStatus: vi.fn(),
		oauthManualInput: {
			hasPending: vi.fn(() => false),
			pendingProviderId: undefined,
			tryClaimInput: vi.fn(),
		},
		session: {
			refreshMCPTools: vi.fn(),
			modelRegistry: { authStorage },
		},
		mcpManager,
	} as never);

	return { controller, showError, prepareConfig, mcpManager };
}

describe("/mcp auth commands", () => {
	let projectDir = "";
	let agentDir = "";
	let configPath = "";
	let originalMcpHost: string | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reauth-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reauth-agent-"));
		configPath = path.join(projectDir, ".mcp.json");
		originalMcpHost = Bun.env.MCP_HOST;
		Bun.env.MCP_HOST = "mcp.example.com";
		process.env.MCP_HOST = "mcp.example.com";
		setProjectDir(projectDir);
		setAgentDir(agentDir);
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{
					mcpServers: {
						envserver: {
							type: "http",
							url: RAW_SERVER_URL,
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			if (String(input) === "https://auth.example.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						issuer: AUTH_ISSUER,
						authorization_endpoint: "https://auth.example.com/authorize",
						token_endpoint: "https://auth.example.com/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreEnvValue("MCP_HOST", originalMcpHost);
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fs.rm(projectDir, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("stores definition-only OAuth credentials under the expanded URL key", async () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.reload();
		const connectToServer = vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, showError, prepareConfig } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(prepareConfig).toHaveBeenCalledWith(
			expect.objectContaining({ url: EXPANDED_SERVER_URL }),
			expect.objectContaining({ oauth: false }),
		);
		expect(connectToServer).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ url: EXPANDED_SERVER_URL }),
		);
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			issuer: AUTH_ISSUER,
			tokenUrl: "https://auth.example.com/token",
			resource: EXPANDED_SERVER_URL,
		});
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(RAW_SERVER_URL))).toBeUndefined();

		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedServer = saved.mcpServers?.envserver;
		const savedUrl = savedServer?.type === "http" || savedServer?.type === "sse" ? savedServer.url : undefined;
		expect(savedUrl).toBe(RAW_SERVER_URL);
		expect(savedServer?.auth).toBeUndefined();
	});

	test("reuses embedded DCR client secret during reauth token exchange", async () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.reload();
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			issuer: AUTH_ISSUER,
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() + 3_600_000,
			tokenUrl: "https://auth.example.com/token",
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
			resource: EXPANDED_SERVER_URL,
		} as oauthFlow.MCPStoredOAuthCredential);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async input => {
			if (String(input) === "https://auth.example.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						issuer: AUTH_ISSUER,
						authorization_endpoint: "https://auth.example.com/authorize",
						token_endpoint: "https://auth.example.com/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					access_token: "fresh-access",
					refresh_token: "fresh-refresh",
					expires_in: 3600,
					token_type: "Bearer",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch);
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(function (this: oauthFlow.MCPOAuthFlow) {
			return this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
		});
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		const tokenRequestBody = String(
			fetchSpy.mock.calls.find(call => String(call[0]) === "https://auth.example.com/token")?.[1]?.body ?? "",
		);
		const tokenRequest = new URLSearchParams(tokenRequestBody);
		expect(tokenRequest.get("client_id")).toBe("dcr-client");
		expect(tokenRequest.get("client_secret")).toBe("dcr-secret");
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			clientId: "dcr-client",
			issuer: AUTH_ISSUER,
			clientSecret: "dcr-secret",
		});
	});

	test("clears a credential from a changed issuer before reauthorization", async () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.reload();
		const credentialId = oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL);
		await authStorage.set(credentialId, {
			type: "oauth",
			issuer: "https://old-auth.example.com/",
			authorizationUrl: "https://old-auth.example.com/authorize",
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() + 3_600_000,
			tokenUrl: "https://old-auth.example.com/token",
			clientId: "old-dcr-client",
			clientSecret: "old-dcr-secret",
		} as oauthFlow.MCPStoredOAuthCredential);
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					envserver: {
						type: "http",
						url: RAW_SERVER_URL,
						oauth: { clientId: "old-config-client", clientSecret: "old-config-secret" },
					},
				},
			}),
		);
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(function (this: oauthFlow.MCPOAuthFlow) {
			expect(this.resolvedClientId).toBeUndefined();
			return Promise.reject(new Error("authorization cancelled"));
		});
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).toHaveBeenCalledWith(expect.stringContaining("authorization cancelled"));
		expect(authStorage.get(credentialId)).toBeUndefined();
	});

	test("rejects challenge endpoints that do not match authorization-server metadata", async () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.reload();
		const challengeError = new Error(
			`HTTP 401: {"issuer":"${AUTH_ISSUER}","authorization_url":"https://attacker.example/authorize","token_url":"https://attacker.example/token"}`,
		);
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(challengeError);
		const login = vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login");
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).toHaveBeenCalledWith(expect.stringContaining("do not match authorization-server metadata"));
		expect(login).not.toHaveBeenCalled();
	});

	test("clears both expanded and stale raw URL-keyed credentials on unauth", async () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.reload();
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "expanded-access",
			refresh: "expanded-refresh",
			expires: Date.now() + 3_600_000,
		});
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(RAW_SERVER_URL), {
			type: "oauth",
			access: "raw-access",
			refresh: "raw-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp unauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(RAW_SERVER_URL))).toBeUndefined();
		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedServer = saved.mcpServers?.envserver;
		const savedUrl = savedServer?.type === "http" || savedServer?.type === "sse" ? savedServer.url : undefined;
		expect(savedUrl).toBe(RAW_SERVER_URL);
		expect(savedServer?.auth).toBeUndefined();
	});

	test("clears url-keyed auth for discovered definition-only servers", async () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.reload();
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "discovered-access",
			refresh: "discovered-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, showError } = createController(authStorage, {
			getServerConfig: vi.fn(() => ({ type: "http", url: EXPANDED_SERVER_URL })),
			getSource: vi.fn(() => ({ provider: "test", path: "/tmp/discovered.json" })),
		});

		await controller.handle("/mcp unauth discovered");

		expect(showError).not.toHaveBeenCalled();
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		const userConfigPath = getMCPConfigPath("user", projectDir);
		const userConfig = JSON.parse(
			await Bun.file(userConfigPath)
				.text()
				.catch(() => "{}"),
		) as TestConfigFile;
		expect(userConfig.mcpServers?.discovered).toBeUndefined();
	});
});
