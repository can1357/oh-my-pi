import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

const RAW_SERVER_URL = `https://\${MCP_HOST}/mcp`;
const EXPANDED_SERVER_URL = "https://mcp.example.com/mcp";
const AUTH_ERROR = new Error(
	'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}',
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
	const showStatus = vi.fn();
	const present = vi.fn();
	const editor: { onEscape?: () => void } = {};
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
	const oauthManualInput = new OAuthManualInputManager();
	const ctx = {
		chatContainer: { addChild: vi.fn() },
		present,
		presentCommandOutput: present,
		ui: { requestRender: vi.fn() },
		editor,
		showError,
		showStatus,
		oauthManualInput,
		settings: {
			get: vi.fn((_key: string): unknown => undefined),
		},
		session: {
			refreshMCPTools: vi.fn(),
			setMCPPromptCommands: vi.fn(),
			modelRegistry: { authStorage },
		},
		mcpManager,
	} as never;
	const controller = new MCPCommandController(ctx);

	return { controller, ctx, showError, showStatus, present, editor, oauthManualInput, prepareConfig, mcpManager };
}

describe("/mcp auth commands", () => {
	let projectDir = "";
	let agentDir = "";
	let configPath = "";
	let originalMcpHost: string | undefined;
	// Track every in-memory auth store so afterEach can close the underlying
	// bun:sqlite Database. Leaked Database handles are JSDestructibleObjects that
	// JSC otherwise finalizes during an arbitrary later GC sweep — under
	// `bun test --parallel` that sweep can run mid-suite on the shared VM and
	// trip a Bun GC crash (SIGABRT "Pure virtual function called").
	const openAuthStores: AuthStorage[] = [];
	function freshAuthStorage(): AuthStorage {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		openAuthStores.push(storage);
		return storage;
	}

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
	});

	afterEach(async () => {
		while (openAuthStores.length > 0) openAuthStores.pop()?.close();
		vi.restoreAllMocks();
		restoreEnvValue("MCP_HOST", originalMcpHost);
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("stores definition-only OAuth credentials under the expanded URL key", async () => {
		const authStorage = freshAuthStorage();
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

	test("uses the registration endpoint discovered from a pathful issuer", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		const resourceMetadataUrl = "https://gateway.example.com/.well-known/oauth-protected-resource/my-service/mcp";
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(
			new Error(`HTTP 401: WWW-Authenticate: Bearer resource_metadata="${resourceMetadataUrl}"`),
		);
		const registrationRequests: string[] = [];
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = String(input);
				if (url === resourceMetadataUrl) {
					return new Response(
						JSON.stringify({
							resource: "https://gateway.example.com/my-service/mcp",
							authorization_servers: ["https://auth.example.com/auth/v1"],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/.well-known/oauth-authorization-server/auth/v1") {
					return new Response(
						JSON.stringify({
							issuer: "https://auth.example.com/auth/v1",
							authorization_endpoint: "https://auth.example.com/auth/v1/oauth/authorize",
							token_endpoint: "https://auth.example.com/auth/v1/oauth/token",
							registration_endpoint: "https://auth.example.com/auth/v1/oauth/register",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/auth/v1/oauth/register" && init?.method === "POST") {
					registrationRequests.push(url);
					return new Response(JSON.stringify({ client_id: "pathful-dcr-client" }), {
						status: 201,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				const { url } = await this.generateAuthUrl("state", "http://127.0.0.1:53192/callback");
				expect(new URL(url).searchParams.get("client_id")).toBe("pathful-dcr-client");
				return {
					access: "fresh-access",
					refresh: "fresh-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		);
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(registrationRequests).toEqual(["https://auth.example.com/auth/v1/oauth/register"]);
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			clientId: "pathful-dcr-client",
		});
	});

	test("uses tool challenge resource metadata and scopes during reauth", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					envserver: {
						type: "http",
						url: RAW_SERVER_URL,
						oauth: { scope: "configured.read" },
					},
				},
			}),
		);
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(new Error("HTTP 401: Unauthorized"));

		const resourceMetadataUrl = "https://gateway.example.com/.well-known/oauth-protected-resource";
		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url === resourceMetadataUrl) {
					return new Response(
						JSON.stringify({
							resource: "https://gateway.example.com/mcp",
							authorization_servers: ["https://auth.example.com"],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							client_id: "challenge-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1:53192/callback")).url;
				return {
					access: "fresh-access",
					refresh: "fresh-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		);

		const { controller, showError } = createController(authStorage);
		const updated = await controller.handleMCPAuthChallenge("envserver", {
			wwwAuthenticate: [`Bearer resource_metadata="${resourceMetadataUrl}" scope="orders.read"`],
		});
		expect(updated).toEqual(expect.objectContaining({ type: "http", url: RAW_SERVER_URL }));
		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("orders.read");
		expect(new URL(authorizationUrl).searchParams.get("resource")).toBe("https://gateway.example.com/mcp");
	});

	test("reauthorizes on a tool challenge even when the anonymous handshake succeeds", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		// Server allows the unauthenticated handshake; only tool calls are protected.
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const resourceMetadataUrl = "https://gateway.example.com/.well-known/oauth-protected-resource";
		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url === resourceMetadataUrl) {
					return new Response(
						JSON.stringify({
							resource: "https://gateway.example.com/mcp",
							authorization_servers: ["https://auth.example.com"],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							client_id: "challenge-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});

		const { controller, showError } = createController(authStorage);
		const updated = await controller.handleMCPAuthChallenge("envserver", {
			wwwAuthenticate: [`Bearer resource_metadata="${resourceMetadataUrl}" scope="orders.read"`],
		});
		expect(updated).toEqual(expect.objectContaining({ type: "http", url: RAW_SERVER_URL }));
		expect(showError).not.toHaveBeenCalled();
	});

	test("/mcp reauth acquires a credential when the handshake succeeds but tools need OAuth", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		// The anonymous handshake (`initialize`) succeeds; only `tools/call` is
		// gated behind OAuth. The unauthenticated probe must not treat this as
		// proof that reauthorization is unnecessary.
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							issuer: "https://mcp.example.com",
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							client_id: "advertised-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});

		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			tokenUrl: "https://auth.example.com/token",
		});
	});

	test("prefers dynamic registration over a metadata-advertised client", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const registrationRequests: string[] = [];
		let tokenRequest: URLSearchParams | undefined;
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = String(input);
				if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							registration_endpoint: "https://auth.example.com/register",
							client_id: "advertised-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/register" && init?.method === "POST") {
					registrationRequests.push(String(init.body ?? ""));
					return new Response(JSON.stringify({ client_id: "dcr-client" }), {
						status: 201,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "https://auth.example.com/token" && init?.method === "POST") {
					tokenRequest = new URLSearchParams(String(init.body ?? ""));
					return new Response(
						JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url;
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(registrationRequests).toHaveLength(1);
		expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("dcr-client");
		expect(tokenRequest?.get("client_id")).toBe("dcr-client");
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			clientId: "dcr-client",
		});
	});

	test("does not persist a whitespace-only embedded client id", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(
			new Error(
				'HTTP 401: {"authorization_url":"https://auth.example.com/authorize?client_id=%20%09","token_url":"https://auth.example.com/token"}',
			),
		);

		let tokenRequest: URLSearchParams | undefined;
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				if (String(input) === "https://auth.example.com/token" && init?.method === "POST") {
					tokenRequest = new URLSearchParams(String(init.body ?? ""));
					return new Response(
						JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url;
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("client_id")).toBeNull();
		expect(tokenRequest?.has("client_id")).toBe(false);
		const savedCredential = authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL)) as
			| oauthFlow.MCPStoredOAuthCredential
			| undefined;
		expect(savedCredential).toMatchObject({ type: "oauth", access: "fresh-access" });
		expect(savedCredential?.clientId).toBeUndefined();
		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		expect(saved.mcpServers?.envserver?.auth?.clientId).toBeUndefined();
	});

	test("uses configured OAuth scope when endpoint metadata omits scopes", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					envserver: {
						type: "http",
						url: RAW_SERVER_URL,
						oauth: { scope: "configured.read configured.write" },
					},
				},
			}),
		);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				if (String(input) === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1:53192/callback")).url;
				return {
					access: "fresh-access",
					refresh: "fresh-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("configured.read configured.write");
	});

	test("uses configured OAuth client credentials as a pair when discovery advertises another client", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					envserver: {
						type: "http",
						url: RAW_SERVER_URL,
						auth: { type: "oauth" },
						oauth: { clientId: "configured-client", clientSecret: "configured-secret" },
					},
				},
			}),
		);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		let tokenRequest: URLSearchParams | undefined;
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = String(input);
				if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize?client_id=embedded-client",
							token_endpoint: "https://auth.example.com/token",
							client_id: "discovered-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/token" && init?.method === "POST") {
					tokenRequest = new URLSearchParams(String(init.body ?? ""));
					return new Response(
						JSON.stringify({
							access_token: "fresh-access",
							refresh_token: "fresh-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url;
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("configured-client");
		expect(tokenRequest?.get("client_id")).toBe("configured-client");
		expect(tokenRequest?.get("client_secret")).toBe("configured-secret");
		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		expect(saved.mcpServers?.envserver?.auth).toEqual(
			expect.objectContaining({ clientId: "configured-client", clientSecret: "configured-secret" }),
		);
		expect(saved.mcpServers?.envserver?.oauth).toEqual(
			expect.objectContaining({ clientId: "configured-client", clientSecret: "configured-secret" }),
		);
	});

	test("does not persist or reuse a configured-only OAuth secret", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					envserver: {
						type: "http",
						url: RAW_SERVER_URL,
						auth: { type: "oauth" },
						oauth: { clientId: " \t ", clientSecret: "configured-secret" },
					},
				},
			}),
		);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const tokenRequests: URLSearchParams[] = [];
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = String(input);
				if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							client_id: "discovered-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/token" && init?.method === "POST") {
					tokenRequests.push(new URLSearchParams(String(init.body ?? "")));
					return new Response(
						JSON.stringify({
							access_token: "fresh-access",
							refresh_token: "fresh-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const authorizationUrls: URL[] = [];
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrls.push(new URL((await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url));
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(authorizationUrls[0]?.searchParams.get("client_id")).toBe("discovered-client");
		expect(tokenRequests[0]?.get("client_id")).toBe("discovered-client");
		expect(tokenRequests[0]?.has("client_secret")).toBe(false);
		const savedAfterFirstReauth = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedAuth = savedAfterFirstReauth.mcpServers?.envserver?.auth;
		expect(savedAuth).toEqual(expect.objectContaining({ clientId: "discovered-client" }));
		expect(savedAuth?.clientSecret).toBeUndefined();
		expect(savedAfterFirstReauth.mcpServers?.envserver?.oauth?.clientId).toBeUndefined();

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(authorizationUrls[1]?.searchParams.get("client_id")).toBe("discovered-client");
		expect(tokenRequests[1]?.get("client_id")).toBe("discovered-client");
		expect(tokenRequests[1]?.has("client_secret")).toBe(false);
		const savedAfterSecondReauth = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedAuthAfterSecondReauth = savedAfterSecondReauth.mcpServers?.envserver?.auth;
		expect(savedAuthAfterSecondReauth).toEqual(expect.objectContaining({ clientId: "discovered-client" }));
		expect(savedAuthAfterSecondReauth?.clientSecret).toBeUndefined();
		expect(savedAfterSecondReauth.mcpServers?.envserver?.oauth?.clientId).toBeUndefined();
		expect(savedAfterSecondReauth.mcpServers?.envserver?.oauth?.clientSecret).toBe("configured-secret");
		const savedCredentialAfterSecond = authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL)) as
			| oauthFlow.MCPStoredOAuthCredential
			| undefined;
		expect(savedCredentialAfterSecond).toMatchObject({ clientId: "discovered-client" });
		expect(savedCredentialAfterSecond?.clientSecret).toBeUndefined();
	});

	test("reuses embedded DCR client secret during reauth token exchange", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		await authStorage.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() + 3_600_000,
			tokenUrl: "https://auth.example.com/token",
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
			resource: EXPANDED_SERVER_URL,
		} as oauthFlow.MCPStoredOAuthCredential);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
					const url = String(input);
					if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
						return new Response(
							JSON.stringify({
								authorization_endpoint: "https://auth.example.com/authorize?client_id=discovered-client",
								token_endpoint: "https://auth.example.com/token",
								client_id: "discovered-client",
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (url === "https://auth.example.com/token" && init?.method === "POST") {
						return new Response(
							JSON.stringify({
								access_token: "fresh-access",
								refresh_token: "fresh-refresh",
								expires_in: 3600,
								token_type: "Bearer",
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					return new Response("not found", { status: 404 });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);
		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url;
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("dcr-client");
		const tokenRequestCall = fetchSpy.mock.calls.find(
			call => String(call[0]) === "https://auth.example.com/token" && call[1]?.method === "POST",
		);
		const tokenRequestBody = String(tokenRequestCall?.[1]?.body ?? "");
		const tokenRequest = new URLSearchParams(tokenRequestBody);
		expect(tokenRequest.get("client_id")).toBe("dcr-client");
		expect(tokenRequest.get("client_secret")).toBe("dcr-secret");
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
		});
	});

	test("Esc aborts the OAuth flow during /mcp reauth", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		// Simulate the real flow: login hangs waiting for the OAuth callback and
		// only resolves when the controller's signal aborts. Mirrors what
		// OAuthCallbackFlow.#waitForCallback does in production.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(function (this: oauthFlow.MCPOAuthFlow) {
			const pending = Promise.withResolvers<never>();
			this.ctrl.signal?.addEventListener("abort", () => {
				pending.reject(new Error(`OAuth callback cancelled: ${String(this.ctrl.signal?.reason ?? "aborted")}`));
			});
			return pending.promise;
		});

		const { controller, showError, showStatus, editor } = createController(authStorage);

		const reauthPromise = controller.handle("/mcp reauth envserver");

		// Wait for #handleOAuthFlow to install its editor.onEscape hook.
		const deadline = Date.now() + 1_000;
		while (typeof editor.onEscape !== "function" && Date.now() < deadline) {
			await Bun.sleep(10);
		}
		expect(typeof editor.onEscape).toBe("function");

		const installedEscape = editor.onEscape;
		editor.onEscape?.();

		// Cancellation must resolve the reauth promise promptly (well under the
		// 5-minute production timeout); a 2s race exposes a hung flow as a test
		// failure rather than a suite hang.
		await Promise.race([
			reauthPromise,
			Bun.sleep(2_000).then(() => {
				throw new Error("reauth did not resolve within 2s of Esc");
			}),
		]);

		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
		// onEscape must be restored to its previous value so subsequent user
		// input does not keep aborting the (now-finished) flow.
		expect(editor.onEscape).not.toBe(installedEscape);
	});

	test("reauth supersedes an unfinished MCP OAuth flow", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		let loginAttempt = 0;
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(function (this: oauthFlow.MCPOAuthFlow) {
			loginAttempt += 1;
			if (loginAttempt > 1) {
				return Promise.resolve({
					access: "replacement-access",
					refresh: "replacement-refresh",
					expires: Date.now() + 3_600_000,
				});
			}

			const manualInputPromise = this.ctrl.onManualCodeInput?.();
			void manualInputPromise?.catch(() => {});
			const pending = Promise.withResolvers<never>();
			this.ctrl.signal?.addEventListener(
				"abort",
				() => {
					pending.reject(new Error(`OAuth callback cancelled: ${String(this.ctrl.signal?.reason ?? "aborted")}`));
				},
				{ once: true },
			);
			return pending.promise;
		});

		const { controller, ctx, showError, showStatus, editor, oauthManualInput } = createController(authStorage);
		const firstReauth = controller.handle("/mcp reauth envserver");
		const claimDeadline = Date.now() + 1_000;
		while (!oauthManualInput.hasPending() && Date.now() < claimDeadline) {
			await Bun.sleep(10);
		}
		expect(oauthManualInput.pendingProviderId).toBe("mcp");

		const replacementReauth = new MCPCommandController(ctx).handle("/mcp reauth envserver");
		await Promise.race([
			replacementReauth,
			Bun.sleep(2_000).then(() => {
				throw new Error("replacement reauth did not resolve within 2s");
			}),
		]);
		if (oauthManualInput.hasPending()) editor.onEscape?.();
		await Promise.race([
			firstReauth,
			Bun.sleep(2_000).then(() => {
				throw new Error("superseded reauth did not resolve within 2s");
			}),
		]);

		expect(loginAttempt).toBe(2);
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
		expect(authStorage.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			access: "replacement-access",
		});
	});

	test("Esc cancels even when OAuth login has not registered its signal listener yet", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		// Simulates the review race: Esc aborts oauthTimeout before
		// OAuthCallbackFlow.#waitForCallback has registered its abort listener
		// (e.g. during dynamic client registration or metadata discovery).
		// The login promise itself never observes ctrl.signal; #handleOAuthFlow
		// must race it against oauthTimeout.signal.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockReturnValue(Promise.withResolvers<never>().promise);
		const { controller, showError, showStatus, editor } = createController(authStorage);

		const reauthPromise = controller.handle("/mcp reauth envserver");
		const deadline = Date.now() + 1_000;
		while (typeof editor.onEscape !== "function" && Date.now() < deadline) {
			await Bun.sleep(10);
		}
		expect(typeof editor.onEscape).toBe("function");
		editor.onEscape?.();

		await Promise.race([
			reauthPromise,
			Bun.sleep(2_000).then(() => {
				throw new Error("reauth did not resolve within 2s of pre-wait Esc");
			}),
		]);

		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
	});

	test("OAuth deadline still surfaces as a reauthorization error, not a cancellation", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		// Deadline path bypasses both the editor's Esc hook and any external
		// signal: withTimeout aborts the controller with reason "MCP OAuth flow
		// timed out" and the login promise rejects with a "timed out" message.
		// Mirror that here. Keeping the surface distinct from the user-cancel
		// flag in #handleOAuthFlow is the whole point of this regression test.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockRejectedValue(
			new Error("OAuth flow timed out after 5 minutes"),
		);
		const { controller, showError, showStatus } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		// Deadline must read as "failed", not "cancelled" — they have different
		// surfaces (error banner vs status line) and the user expects a clear
		// timeout message rather than thinking they pressed Esc.
		expect(showStatus).not.toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
		expect(showError).toHaveBeenCalledWith(expect.stringMatching(/timed out/i));
	});

	test("clears both expanded and stale raw URL-keyed credentials on unauth", async () => {
		const authStorage = freshAuthStorage();
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
		const authStorage = freshAuthStorage();
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

	test("passes env-expanded OAuth client credentials to the reauth flow", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.reload();
		const originalClientId = Bun.env.MCP_OAUTH_CLIENT_ID;
		const originalClientSecret = Bun.env.MCP_OAUTH_CLIENT_SECRET;
		Bun.env.MCP_OAUTH_CLIENT_ID = "expanded-client-id";
		Bun.env.MCP_OAUTH_CLIENT_SECRET = "expanded-client-secret";
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{
					mcpServers: {
						envserver: {
							type: "http",
							url: RAW_SERVER_URL,
							oauth: {
								// oxlint-disable-next-line no-template-curly-in-string -- test placeholder string for env expansion
								clientId: "${MCP_OAUTH_CLIENT_ID}",
								// oxlint-disable-next-line no-template-curly-in-string -- test placeholder string for env expansion
								clientSecret: "${MCP_OAUTH_CLIENT_SECRET}",
							},
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		try {
			vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
			let flowClientId: string | undefined;
			let flowClientSecret: string | undefined;
			vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
				async function (this: oauthFlow.MCPOAuthFlow) {
					// MCPOAuthFlow keeps its config private; read it back to assert the
					// resolved credentials the flow will use. Structurally known shape,
					// no runtime validation is meaningful here.
					const flow = this as unknown as { config: { clientId?: string; clientSecret?: string } };
					flowClientId = flow.config.clientId;
					flowClientSecret = flow.config.clientSecret;
					return {
						access: "fresh-access",
						refresh: "fresh-refresh",
						expires: Date.now() + 3_600_000,
					};
				},
			);
			const { controller, showError } = createController(authStorage);

			await controller.handle("/mcp reauth envserver");

			expect(showError).not.toHaveBeenCalled();
			// The token exchange must receive the resolved secret, not the literal
			// `${...}` placeholder.
			expect(flowClientId).toBe("expanded-client-id");
			expect(flowClientSecret).toBe("expanded-client-secret");

			// The config file keeps the placeholder; only the flow sees the value.
			const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
			const savedServer = saved.mcpServers?.envserver;
			// oxlint-disable-next-line no-template-curly-in-string -- test placeholder string for env expansion
			expect(savedServer?.oauth?.clientSecret).toBe("${MCP_OAUTH_CLIENT_SECRET}");
			// oxlint-disable-next-line no-template-curly-in-string -- test placeholder string for env expansion
			expect(savedServer?.oauth?.clientId).toBe("${MCP_OAUTH_CLIENT_ID}");
		} finally {
			restoreEnvValue("MCP_OAUTH_CLIENT_ID", originalClientId);
			restoreEnvValue("MCP_OAUTH_CLIENT_SECRET", originalClientSecret);
		}
	});
});
