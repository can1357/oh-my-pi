/**
 * End-to-end regression for broker-backed MCP OAuth refresh (issue #8933).
 *
 * Topology mirrors `omp auth-broker serve` fronting a sandboxed client:
 *   client (RemoteAuthCredentialStore) → broker (SqliteAuthCredentialStore
 *   + refreshBrokerOAuthCredential override) → MCP token endpoint.
 *
 * Two gaps used to break this once the ~6h access token expired:
 *   A. the client threw on the `__remote__` refresh sentinel instead of asking
 *      the broker to refresh (mcp/manager.ts);
 *   B. the broker had no `mcp_oauth:*` refresh path, so it answered
 *      `Unknown OAuth provider` (auth-broker-cli.ts / auth-storage.ts).
 *
 * The test proves the fixed contract: a remote OAuth MCP server whose access
 * token has expired refreshes through the broker (which holds the only real
 * refresh token) and the client injects the freshly minted Bearer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { refreshBrokerOAuthCredential } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { Server } from "bun";

const SERVER_URL = "https://mcp.granola.ai/mcp";
const MCP_PROVIDER = mcpOAuthCredentialId(SERVER_URL, "default");
const BEARER = "e2e-broker-mcp-token";

function getAuthorizationHeader(config: MCPServerConfig): string | undefined {
	if (config.type !== "http" && config.type !== "sse") return undefined;
	return config.headers?.Authorization;
}

describe("broker-backed MCP OAuth refresh", () => {
	let tempDir = "";
	let tokenServer: Server<undefined> | undefined;
	let tokenRequests: URLSearchParams[] = [];
	let serverStore: SqliteAuthCredentialStore | undefined;
	let serverStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	let clientStorage: AuthStorage | undefined;
	let manager: MCPManager | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-broker-mcp-refresh-"));
		tokenRequests = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				tokenRequests.push(new URLSearchParams(await req.text()));
				return Response.json({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 });
			},
		});
		tokenServer = server;
		const tokenUrl = `http://127.0.0.1:${server.port}/token`;

		serverStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		// The serve process constructs AuthStorage with this exact override.
		serverStorage = new AuthStorage(serverStore, {
			refreshOAuthCredential: (provider, _credentialId, credential, signal) =>
				refreshBrokerOAuthCredential(provider, credential, signal),
		});
		await serverStorage.reload();

		// Expired MCP OAuth credential with embedded refresh material, as the
		// vault holds it. Spread bypasses the excess-property check for the
		// MCP-only extension fields the base OAuthCredential type omits.
		const credential: OAuthCredential = {
			// oxlint-disable-next-line unicorn/no-useless-spread -- spread bypasses excess-property checking
			...{ type: "oauth", access: "stale-access", refresh: "real-refresh-token", expires: Date.now() - 60_000 },
			// oxlint-disable-next-line unicorn/no-useless-spread -- spread bypasses excess-property checking
			...{ tokenUrl, clientId: "client-xyz" },
		};
		await serverStorage.set(MCP_PROVIDER, credential);

		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [BEARER],
			disableRefresher: true,
		});

		remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token: BEARER }),
			streamSnapshots: false,
		});
		clientStorage = new AuthStorage(remote);
		await clientStorage.revalidateCredentials();

		manager = new MCPManager(process.cwd());
		manager.setAuthStorage(clientStorage);
	});

	afterEach(async () => {
		clientStorage?.close();
		await handle?.close();
		serverStorage?.close();
		serverStore?.close();
		tokenServer?.stop(true);
		await removeWithRetries(tempDir);
	});

	test("expired remote MCP token refreshes through the broker and injects the fresh Bearer", async () => {
		// Sanity: the client only ever sees the redacted refresh token.
		const stored = clientStorage!.get(MCP_PROVIDER);
		expect(stored?.type === "oauth" ? stored.refresh : undefined).toBe(REMOTE_REFRESH_SENTINEL);

		const prepared = await manager!.prepareConfig({
			type: "http",
			url: SERVER_URL,
			auth: { type: "oauth", credentialId: MCP_PROVIDER },
		});

		// Gap A + B fixed: fresh access token minted and injected.
		expect(getAuthorizationHeader(prepared)).toBe("Bearer fresh-access");

		// The grant ran on the BROKER with the real refresh token — the client
		// never held it, and the broker no longer answers "Unknown OAuth provider".
		expect(tokenRequests).toHaveLength(1);
		expect(tokenRequests[0].get("grant_type")).toBe("refresh_token");
		expect(tokenRequests[0].get("refresh_token")).toBe("real-refresh-token");
	});
});
