/**
 * Step-up authorization for an MCP tool call refused with HTTP 403
 * `insufficient_scope` (RFC 6750 §3.1, MCP authorization step-up flow, #20340).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { disposeLocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as oauthDiscovery from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { MCPOAuthCancelledError, reauthorizeMcpServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPAuthChallenge, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const STEP_UP_CHALLENGE =
	'Bearer error="insufficient_scope", scope="cabinet:write", resource_metadata="https://jug.example/.well-known/oauth-protected-resource/mcp"';
const WRITE_TOKEN = "Bearer read-write";

/**
 * A handshake-era Streamable HTTP server whose one tool refuses any token but
 * {@link WRITE_TOKEN} with HTTP 403 and `challenge`.
 */
function startScopedServer(challenge: string) {
	const seen = { toolCalls: 0 };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(request) {
			if (request.method === "GET") return new Response(null, { status: 405 });
			if (request.method !== "POST") return new Response(null, { status: 200 });
			const message = (await request.json()) as { id?: string | number; method: string };
			if (message.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			switch (message.method) {
				case "initialize":
					result = {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "jug", version: "1.0.0" },
					};
					break;
				case "tools/list":
					result = { tools: [{ name: "save_version", inputSchema: { type: "object" } }] };
					break;
				case "tools/call":
					seen.toolCalls++;
					if (request.headers.get("Authorization") !== WRITE_TOKEN) {
						return new Response(JSON.stringify({ error: "insufficient_scope" }), {
							status: 403,
							headers: { "Content-Type": "application/json", "WWW-Authenticate": challenge },
						});
					}
					result = { content: [{ type: "text", text: "saved" }] };
					break;
			}
			return Response.json({ jsonrpc: "2.0", id: message.id, result });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/mcp`, seen, stop: () => server.stop(true) };
}

describe("MCP tool call refused with 403 insufficient_scope", () => {
	const noop = () => {};
	const noCtx = {} as Parameters<MCPTool["execute"]>[3];
	let cleanup: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
		await disposeLocalMcpHost();
	});

	/** Connect with a read-only token; `authorize` answers each challenge with the config to reconnect with. */
	async function connect(
		authorize: (current: MCPServerConfig) => MCPServerConfig | undefined,
		challenge = STEP_UP_CHALLENGE,
	) {
		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-step-up-"));
		const remote = startScopedServer(challenge);
		const manager = new MCPManager(workDir);
		cleanup = async () => {
			await manager.disconnectAll();
			await remote.stop();
			await removeWithRetries(workDir);
		};
		const config: MCPServerConfig = {
			type: "http",
			url: remote.url,
			timeout: 5_000,
			headers: { Authorization: "Bearer read-only" },
		};
		const challenges: MCPAuthChallenge[] = [];
		manager.setAuthHandler(async (_name, received) => {
			challenges.push(received);
			return authorize(config);
		});
		await manager.connectServers({ jug: config }, {});
		expect((await manager.waitForStartup(0)).connected).toEqual(["jug"]);
		const tool = manager.getTools().find(candidate => candidate.mcpServerName === "jug");
		if (!tool) throw new Error("jug tool not registered");
		return { tool, remote, challenges };
	}

	it("authorizes the challenged scope, then retries the call", async () => {
		const { tool, remote, challenges } = await connect(current => ({
			...current,
			headers: { Authorization: WRITE_TOKEN },
		}));

		const result = await tool.execute("save", {}, noop, noCtx);

		expect(challenges).toEqual([{ wwwAuthenticate: [STEP_UP_CHALLENGE] }]);
		expect(result.details?.isError).toBeFalsy();
		expect(result.content).toEqual([{ type: "text", text: "saved" }]);
		expect(remote.seen.toolCalls).toBe(2);
	}, 20_000);

	it("surfaces the 403 without retrying when authorization is declined", async () => {
		const { tool, remote, challenges } = await connect(() => undefined);

		const result = await tool.execute("save", {}, noop, noCtx);

		expect(challenges).toHaveLength(1);
		expect(result.details?.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("HTTP 403");
		expect(remote.seen.toolCalls).toBe(1);
	}, 20_000);

	it("steps up once per call when the new grant still lacks the scope", async () => {
		const { tool, remote, challenges } = await connect(current => current);

		const result = await tool.execute("save", {}, noop, noCtx);

		expect(challenges).toHaveLength(1);
		expect(result.details?.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("insufficient_scope");
		expect(remote.seen.toolCalls).toBe(2);
	}, 20_000);

	it("asks for no consent on a 403 that is not insufficient_scope", async () => {
		const { tool, remote, challenges } = await connect(
			current => current,
			'Bearer error="invalid_token", error_description="revoked"',
		);

		const result = await tool.execute("save", {}, noop, noCtx);

		expect(challenges).toHaveLength(0);
		expect(result.details?.isError).toBe(true);
		expect(remote.seen.toolCalls).toBe(1);
	}, 20_000);
});

describe("step-up reauthorization scopes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requests the granted, advertised and challenged scopes together", async () => {
		const serverUrl = "https://jug.example/mcp";
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		try {
			const granted: MCPStoredOAuthCredential = {
				type: "oauth",
				access: "read-only",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				scope: "cabinet:read offline_access",
			};
			await authStorage.credentials.set(mcpOAuthCredentialId(serverUrl), granted);
			vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(new Error("HTTP 401: Unauthorized"));
			// Protected-resource metadata advertises only the baseline scope.
			vi.spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockResolvedValue({
				authorizationUrl: "https://auth.jug.example/authorize",
				tokenUrl: "https://auth.jug.example/token",
				scopes: "cabinet:read",
			});
			const controller = new AbortController();
			let authorizeUrl: URL | undefined;

			const reauth = reauthorizeMcpServer(
				"jug",
				{
					filePath: "/nonexistent/mcp.json",
					scope: "user",
					discovered: true,
					config: { type: "http", url: serverUrl, oauth: { clientId: "public-client", callbackPort: 38475 } },
				},
				{
					authStorage,
					authChallenge: { wwwAuthenticate: [STEP_UP_CHALLENGE] },
					silent: true,
					signal: controller.signal,
					onAuth: info => {
						authorizeUrl = new URL(info.url);
						controller.abort();
					},
				},
			);

			await expect(reauth).rejects.toBeInstanceOf(MCPOAuthCancelledError);
			expect(authorizeUrl?.searchParams.get("scope")).toBe("cabinet:read offline_access cabinet:write");
		} finally {
			authStorage.close();
		}
	});
});
