/**
 * `/mcp reauth` over the shared (ACP/text/RPC) dispatcher — the same engine
 * path as the TUI (`runMcpOAuthFlow`/`reauthorizeMcpServer`) without a
 * composer, so emacs/Zed clients can reauthorize MCP OAuth. The browser
 * launch itself is glue (`openPath` inside `onAuth`); the flow-level tests
 * below drive `MCPOAuthFlow.login` for real with stubbed HTTP so the
 * client-credential plumbing between dispatcher and flow is exercised, not
 * just its echoes.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import * as oauthDiscovery from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import * as openUtil from "@oh-my-pi/pi-coding-agent/utils/open";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
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
const DCR_AUTH_ERROR = new Error(
	'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token","registration_endpoint":"https://auth.example.com/register"}',
);

/** Narrow read shape of the saved project config (see {@link readSavedServer}). */
type SavedServer = {
	type?: string;
	url?: string;
	auth?: { type?: string; credentialId?: string; clientId?: string; clientSecret?: string; tokenUrl?: string };
};

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreEnvValue(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		delete Bun.env[name];
	} else {
		process.env[name] = value;
		Bun.env[name] = value;
	}
}

describe("/mcp reauth (ACP dispatcher)", () => {
	let projectDir = "";
	let agentDir = "";
	let configPath = "";
	let originalMcpHost: string | undefined;
	// Track every in-memory auth store so afterEach can close the underlying
	// bun:sqlite Database (leaked handles can crash a later parallel GC sweep).
	const openAuthStores: AuthStorage[] = [];
	function freshAuthStorage(): AuthStorage {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		openAuthStores.push(storage);
		return storage;
	}

	const outputs: string[] = [];
	const outputWaiters: Array<{ predicate: (line: string) => boolean; resolve: (line: string) => void }> = [];
	/** Deterministic sync point: resolves with the first output matching `predicate`. */
	function waitForOutput(predicate: (line: string) => boolean): Promise<string> {
		const existing = outputs.find(predicate);
		if (existing !== undefined) return Promise.resolve(existing);
		const waiter = Promise.withResolvers<string>();
		outputWaiters.push({ predicate, resolve: waiter.resolve });
		return waiter.promise;
	}

	function makeRuntime(authStorage: AuthStorage, signal?: AbortSignal): SlashCommandRuntime {
		return {
			session: { modelRegistry: { authStorage } },
			sessionManager: {},
			settings: Settings.isolated(),
			cwd: projectDir,
			signal,
			output: (text: string) => {
				outputs.push(text);
				for (let index = outputWaiters.length - 1; index >= 0; index--) {
					const waiter = outputWaiters[index]!;
					if (waiter.predicate(text)) {
						outputWaiters.splice(index, 1);
						waiter.resolve(text);
					}
				}
			},
			refreshCommands: () => {},
			reloadPlugins: () => Promise.resolve(),
		} as unknown as SlashCommandRuntime;
	}

	async function writeServerConfig(
		auth?: SavedServer["auth"],
		oauth?: { callbackPort?: number; clientId?: string },
	): Promise<void> {
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{
					mcpServers: {
						envserver: {
							type: "http",
							url: RAW_SERVER_URL,
							...(auth ? { auth } : {}),
							...(oauth ? { oauth } : {}),
						},
					},
				},
				null,
				2,
			)}\n`,
		);
	}

	async function readSavedServer(): Promise<SavedServer> {
		const saved = JSON.parse(await Bun.file(configPath).text()) as { mcpServers?: { envserver?: SavedServer } };
		return saved.mcpServers?.envserver ?? {};
	}

	async function runReauth(name: string, authStorage: AuthStorage, signal?: AbortSignal): Promise<void> {
		await handleMcpAcp({ args: `reauth ${name}` } as ParsedSlashCommand, makeRuntime(authStorage, signal));
	}

	beforeEach(async () => {
		outputs.length = 0;
		outputWaiters.length = 0;
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reauth-acp-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reauth-acp-agent-"));
		configPath = getMCPConfigPath("project", projectDir);
		originalMcpHost = Bun.env.MCP_HOST;
		Bun.env.MCP_HOST = "mcp.example.com";
		process.env.MCP_HOST = "mcp.example.com";
		setProjectDir(projectDir);
		setAgentDir(agentDir);
		await writeServerConfig();
	});

	afterEach(async () => {
		while (openAuthStores.length > 0) openAuthStores.pop()?.close();
		vi.restoreAllMocks();
		outputWaiters.length = 0;
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

	test("reauthorizes a previously authorized server and GCs its superseded credential", async () => {
		// A prior reauth left a pointer row: the write-back must point at the
		// fresh url-keyed row and the superseded legacy row must be collected.
		await writeServerConfig({ type: "oauth", credentialId: "mcp_oauth_legacy_123" });
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();

		await runReauth("envserver", authStorage);

		const joined = outputs.join("\n");
		expect(joined).toContain("Reauthorizing");
		expect(joined).toContain("Reauthorized");
		// Same url-keyed credential row the TUI path persists.
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			tokenUrl: "https://auth.example.com/token",
			resource: EXPANDED_SERVER_URL,
		});
		// The legacy pointer row was collected after the fresh row landed.
		expect(authStorage.credentials.get("mcp_oauth_legacy_123")).toBeUndefined();
		const saved = await readSavedServer();
		// Raw `${...}` placeholder stays in the file; the auth block points at
		// the credential row.
		expect(saved.url).toBe(RAW_SERVER_URL);
		expect(saved.auth).toMatchObject({
			type: "oauth",
			credentialId: oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL),
			tokenUrl: "https://auth.example.com/token",
		});
	});

	test("leaves definition-only entries without an auth block write-back", async () => {
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const authStorage = freshAuthStorage();

		await runReauth("envserver", authStorage);

		// Definition-only entries resolve through the url-keyed binding alone;
		// a committed project mcp.json stays clean.
		const saved = await readSavedServer();
		expect(saved.auth).toBeUndefined();
		expect(saved.url).toBe(RAW_SERVER_URL);
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			access: "fresh-access",
		});
	});

	test("surfaces guidance for stdio servers and unknown names", async () => {
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{ mcpServers: { envserver: { type: "stdio", command: "some-mcp-server", args: ["--stdio"] } } },
				null,
				2,
			)}\n`,
		);
		await runReauth("envserver", freshAuthStorage());
		expect(outputs.join("\n")).toContain("stdio servers manage their own credentials");

		outputs.length = 0;
		await runReauth("no-such-server", freshAuthStorage());
		expect(outputs.join("\n")).toContain("not found");
	});

	test("refuses reauthorization when the server connects without OAuth", async () => {
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(
			vi.fn(async () => ({ transport: { onClose: undefined } })) as never,
		);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined);
		// Anonymous connect succeeds: the discovery probe must stay offline.
		const authStorage = freshAuthStorage();
		vi.spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockResolvedValue(null);

		await runReauth("envserver", authStorage);

		const joined = outputs.join("\n");
		expect(joined).toContain("reauthorization is not required");
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
	});

	test("sends a DCR-issued client secret on the token exchange, never an empty one", async () => {
		// Regression: the dispatcher used to pass flowClientSecret's "" fallback
		// straight into MCPOAuthFlow, where `"" ?? registeredSecret` keeps ""
		// and exchangeToken then omits client_secret entirely — a confidential
		// DCR client fails every token exchange with invalid_client.
		await writeServerConfig({ type: "oauth", credentialId: "mcp_oauth_legacy_456" }, { callbackPort: 38471 });
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(DCR_AUTH_ERROR);
		vi.spyOn(openUtil, "openPath").mockImplementation(() => {});
		const realFetch = globalThis.fetch;
		const tokenBodies: string[] = [];
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url === "https://auth.example.com/register") {
					return new Response(JSON.stringify({ client_id: "dcr-client", client_secret: "dcr-secret" }));
				}
				if (url === "https://auth.example.com/token") {
					tokenBodies.push(String(init?.body ?? ""));
					return new Response(
						JSON.stringify({
							access_token: "fresh-access",
							refresh_token: "fresh-refresh",
							expires_in: 3600,
							token_type: "Bearer",
						}),
					);
				}
				// Callback-server redirects and anything unexpected go to the
				// real network stack (the callback server is a local listener).
				return realFetch(input, init);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const authStorage = freshAuthStorage();
		const reauth = runReauth("envserver", authStorage);
		// The flow has started its callback server once the authorization URL
		// is emitted; drive the browser redirect against it like a real client.
		const emittedUrl = await waitForOutput(line => line.includes("https://auth.example.com/authorize"));
		const match = /https:\/\/auth\.example\.com\/authorize\?\S+/.exec(emittedUrl);
		if (!match) throw new Error(`no authorization URL in output: ${emittedUrl}`);
		const authorizeUrl = new URL(match[0]);
		const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
		const state = authorizeUrl.searchParams.get("state");
		if (!redirectUri || !state) throw new Error("authorization URL lacks redirect_uri/state");
		const callback = new URL(redirectUri);
		callback.searchParams.set("code", "dcr-code");
		callback.searchParams.set("state", state);
		await realFetch(callback.toString());
		await reauth;

		// The DCR-issued secret reached the token exchange…
		expect(tokenBodies[0]).toContain("client_secret=dcr-secret");
		expect(tokenBodies[0]).toContain("client_id=dcr-client");
		// …and is embedded in the stored credential row…
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
			access: "fresh-access",
		});
		// …but never written back into the (possibly committed) config file.
		const saved = await readSavedServer();
		expect(saved.auth).toMatchObject({
			type: "oauth",
			credentialId: oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL),
			clientId: "dcr-client",
		});
		expect(saved.auth?.clientSecret).toBeUndefined();
		expect(authStorage.credentials.get("mcp_oauth_legacy_456")).toBeUndefined();
	});

	test("aborts cleanly when the host cancels mid-flow, writing no credential", async () => {
		await writeServerConfig(undefined, { clientId: "public-client", callbackPort: 38473 });
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(openUtil, "openPath").mockImplementation(() => {});
		const hostAbort = new AbortController();
		const authStorage = freshAuthStorage();

		const reauth = runReauth("envserver", authStorage, hostAbort.signal);
		// Abort once the flow is inside its callback wait (the authorization
		// URL has been emitted and the callback server is listening).
		await waitForOutput(line => line.includes("https://auth.example.com/authorize"));
		hostAbort.abort();
		await reauth;

		expect(outputs.join("\n")).toContain("Reauthorization cancelled");
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		const saved = await readSavedServer();
		expect(saved.auth).toBeUndefined();
	});
});
