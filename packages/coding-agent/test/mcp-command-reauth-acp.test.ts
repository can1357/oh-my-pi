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
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
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
	headers?: Record<string, string>;
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

	function makeRuntime(
		authStorage: AuthStorage,
		signal?: AbortSignal,
		mcpManager?: SlashCommandRuntime["mcpManager"],
	): SlashCommandRuntime {
		return {
			session: { modelRegistry: { authStorage } },
			sessionManager: {},
			settings: Settings.isolated(),
			cwd: projectDir,
			signal,
			mcpManager,
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

	async function runReauth(
		name: string,
		authStorage: AuthStorage,
		signal?: AbortSignal,
		mcpManager?: SlashCommandRuntime["mcpManager"],
	): Promise<void> {
		await handleMcpAcp(
			{ args: `reauth ${name}` } as ParsedSlashCommand,
			makeRuntime(authStorage, signal, mcpManager),
		);
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

	test("reauthorizes an ACP client-declared server that lives in no config file", async () => {
		// ACP sessions declare servers at session/new; the definition exists
		// only in the session's live manager. Without consulting
		// runtime.mcpManager the lookup answers "not found" for the very
		// servers the ACP path exists to serve.
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(
			new Error(
				'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}',
			),
		);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const authStorage = freshAuthStorage();
		const acpManager = {
			getServerConfig: (name: string) =>
				name === "client-server" ? { type: "http", url: "https://acp.example.com/mcp" } : undefined,
			getSource: (name: string) =>
				name === "client-server" ? { provider: "acp", providerName: "ACP Client" } : undefined,
		} as unknown as NonNullable<SlashCommandRuntime["mcpManager"]>;

		await runReauth("client-server", authStorage, undefined, acpManager);

		const joined = outputs.join("\n");
		expect(joined).toContain('Reauthorized "client-server"');
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId("https://acp.example.com/mcp"))).toMatchObject({
			access: "fresh-access",
			tokenUrl: "https://auth.example.com/token",
		});
		// Discovered definitions stay out of config files; the url-keyed
		// credential row is the only persistence.
		const saved = await readSavedServer();
		expect(saved.auth).toBeUndefined();
	});

	test("persists an explicit auth binding when the definition carries a client bearer header", async () => {
		// Regression: with an Authorization header and no auth block, the fresh
		// url-keyed row used to skip the write-back — but at startup the header
		// disables the url-keyed fallback, so the next process reauthored into
		// nothing and kept serving the stale bearer.
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{
					mcpServers: {
						envserver: {
							type: "http",
							url: RAW_SERVER_URL,
							headers: { Authorization: "Bearer stale-token" },
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const authStorage = freshAuthStorage();

		await runReauth("envserver", authStorage);

		// The config gains an auth block pointing at the fresh url-keyed row,
		// so the next process resolves the new credential despite the header.
		const saved = await readSavedServer();
		expect(saved.auth).toMatchObject({
			type: "oauth",
			credentialId: oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL),
			tokenUrl: "https://auth.example.com/token",
		});
		// The stale client bearer is stripped on write: keeping it would leak
		// the token into a (possibly committed) file and re-disable the
		// url-keyed fallback on the next load.
		expect(saved.headers).toEqual({});
	});

	test("prefers the manager entry over a colliding config-file name", async () => {
		// Regression: the project file carries `envserver` at another URL while
		// the ACP client declared `envserver` itself. Isolation means the
		// manager entry is the only active server, but the lookup answered the
		// file entry first — reporting success while refreshing an inert
		// shadow. The manager entry must win in ACP context.
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const authStorage = freshAuthStorage();
		const acpManager = {
			getServerConfig: (name: string) =>
				name === "envserver" ? { type: "http", url: "https://acp.example.com/mcp" } : undefined,
			getSource: (name: string) =>
				name === "envserver" ? { provider: "acp", providerName: "ACP Client" } : undefined,
		} as unknown as NonNullable<SlashCommandRuntime["mcpManager"]>;

		await runReauth("envserver", authStorage, undefined, acpManager);

		// The fresh credential is keyed by the manager entry's URL…
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId("https://acp.example.com/mcp"))).toMatchObject({
			access: "fresh-access",
			tokenUrl: "https://auth.example.com/token",
		});
		// …and nothing was keyed for the inert file entry's URL.
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		// The colliding file entry stays untouched.
		const saved = await readSavedServer();
		expect(saved.url).toBe(RAW_SERVER_URL);
		expect(saved.auth).toBeUndefined();
	});

	test("ignores a file-manager entry so the real config source wins", async () => {
		// Regression: print/RPC mode passes the file-discovery manager, whose
		// entry is an env-expanded copy with a synthesized user-config path —
		// preferring it shadowed the real project/user source, wrote fresh
		// bindings to the wrong file, and could serialize expanded
		// `${...}` placeholders as plaintext. Only ACP-isolated managers
		// (source `provider: "acp"`) may win the manager-first lookup.
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const authStorage = freshAuthStorage();
		const fileManager = {
			getServerConfig: (name: string) =>
				name === "envserver" ? { type: "http", url: "https://expanded.example.com/mcp" } : undefined,
			getSource: (name: string) =>
				name === "envserver"
					? { provider: "mcp-json", providerName: "MCP JSON", level: "project" as const }
					: undefined,
		} as unknown as NonNullable<SlashCommandRuntime["mcpManager"]>;

		await runReauth("envserver", authStorage, undefined, fileManager);

		// The credential is keyed by the project file's URL, not the
		// manager's expanded copy.
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			access: "fresh-access",
		});
		expect(
			authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId("https://expanded.example.com/mcp")),
		).toBeUndefined();
	});

	test("resolves a multi-word server name without truncation", async () => {
		// `validateServerName` permits spaces, so `/mcp reauth MaaS Slack`
		// must look up "MaaS Slack" — not "MaaS".
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{ mcpServers: { "MaaS Slack": { type: "stdio", command: "maas-slack-server", args: [] } } },
				null,
				2,
			)}\n`,
		);

		await runReauth("MaaS Slack", freshAuthStorage());

		// The named server was found (its stdio refusal), not reported
		// missing the way a truncated "MaaS" lookup would be.
		expect(outputs.join("\n")).toContain("stdio servers manage their own credentials");
	});

	test("writes nothing to the user config for an ACP-owned bearer-header server", async () => {
		// Regression: an ACP-owned, manager-only server with an Authorization
		// header used to force persistence of the whole session-owned
		// definition — bearer included — into the global user MCP file. The
		// client re-declares the definition every session/new, so that copy
		// could never take effect; only the fresh url-keyed credential row
		// (authStorage) plus the live reconnect carry the binding.
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const authStorage = freshAuthStorage();
		const acpManager = {
			getServerConfig: (name: string) =>
				name === "client-server"
					? {
							type: "http",
							url: "https://acp.example.com/mcp",
							headers: { Authorization: "Bearer client-token" },
						}
					: undefined,
			getSource: (name: string) =>
				name === "client-server" ? { provider: "acp", providerName: "ACP Client" } : undefined,
		} as unknown as NonNullable<SlashCommandRuntime["mcpManager"]>;

		await runReauth("client-server", authStorage, undefined, acpManager);

		expect(outputs.join("\n")).toContain('Reauthorized "client-server"');
		// The fresh binding lives only in authStorage…
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId("https://acp.example.com/mcp"))).toMatchObject({
			access: "fresh-access",
		});
		// …and neither config file gained the session-owned definition.
		const savedProject = await readSavedServer();
		expect(savedProject.auth).toBeUndefined();
		const userConfigPath = getMCPConfigPath("user", projectDir);
		const userConfig = await Bun.file(userConfigPath)
			.json()
			.catch(() => ({ mcpServers: {} }));
		expect((userConfig as { mcpServers?: Record<string, unknown> }).mcpServers?.["client-server"]).toBeUndefined();
	});

	test("respects mcp.enableProjectConfig: an opted-out project entry never wins the lookup", async () => {
		// Project and user files both define `envserver`. With
		// `mcp.enableProjectConfig: false` the project tree is opted out of
		// project-scoped config at startup, so reauth must resolve — and bind
		// credentials for — the user entry, never resurrect the opted-out
		// project shadow.
		const userConfigPath = getMCPConfigPath("user", projectDir);
		await Bun.write(
			userConfigPath,
			`${JSON.stringify(
				{ mcpServers: { envserver: { type: "http", url: "https://user.example.com/mcp" } } },
				null,
				2,
			)}\n`,
		);
		await writeServerConfig();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const authStorage = freshAuthStorage();
		const runtime = makeRuntime(authStorage);
		cfgMcpEnableProjectConfig.set(runtime.settings, false);
		try {
			await handleMcpAcp({ args: "reauth envserver" } as ParsedSlashCommand, runtime);
			// The credential is keyed by the user entry's URL…
			expect(
				authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId("https://user.example.com/mcp")),
			).toMatchObject({ access: "fresh-access" });
			// …and nothing was keyed for the opted-out project shadow.
			expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		} finally {
			cfgMcpEnableProjectConfig.unset(runtime.settings);
		}
	});
});
