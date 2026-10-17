/**
 * `/mcp reauth` over the shared (ACP/text) dispatcher — the same engine path
 * as the TUI (`MCPOAuthFlow` + config write-back) without a composer, so
 * emacs/Zed clients can reauthorize MCP OAuth. The browser launch itself is
 * glue (`openPath` inside `onAuth`); `login` is mocked like the TUI suite.
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

/** Narrow read shape of the saved project config (see {@link readSavedServer}). */
type SavedServer = {
	type?: string;
	url?: string;
	auth?: { type?: string; credentialId?: string; tokenUrl?: string };
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
	function makeRuntime(authStorage: AuthStorage): SlashCommandRuntime {
		return {
			session: { modelRegistry: { authStorage } } as never,
			sessionManager: {} as never,
			settings: Settings.isolated(),
			cwd: projectDir,
			output: (text: string) => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: () => Promise.resolve(),
		};
	}

	async function writeServerConfig(auth?: SavedServer["auth"]): Promise<void> {
		await Bun.write(
			configPath,
			`${JSON.stringify({ mcpServers: { envserver: { type: "http", url: RAW_SERVER_URL, ...(auth ? { auth } : {}) } } }, null, 2)}\n`,
		);
	}

	async function readSavedServer(): Promise<SavedServer> {
		const saved = JSON.parse(await Bun.file(configPath).text()) as { mcpServers?: { envserver?: SavedServer } };
		return saved.mcpServers?.envserver ?? {};
	}

	async function runReauth(name: string, authStorage: AuthStorage): Promise<void> {
		await handleMcpAcp({ args: `reauth ${name}` } as ParsedSlashCommand, makeRuntime(authStorage));
	}

	beforeEach(async () => {
		outputs.length = 0;
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
});
