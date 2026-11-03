/**
 * A remote MCP server that fails at startup must not vanish from the session.
 *
 * Seen live: a session moved to a machine whose `agent.db` held no OAuth login
 * for its Slack MCP server. The server answered HTTP 401 at startup, omp logged
 * it and mounted no Slack tools, and every call the model made answered only
 * "No such tool", which reads like a typo. Another session then stored a login
 * in the same `agent.db`, and the first session still had no Slack tools until
 * it was restarted.
 *
 * Contracts defended here:
 * - asking for an `mcp__…` tool while a configured server is down names that
 *   server, its error and the recovery commands, in the `xd://` error the
 *   model reads (the top-level path is covered in the agent package's
 *   agent-loop tests); other names get no note;
 * - a remote server that failed while no login was stored is reconnected, with
 *   no restart, once another session stores a login and the model asks for
 *   one of its tools again; without a stored login nothing is retried.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPHttpServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createXdevState } from "@oh-my-pi/pi-coding-agent/tools";
import { xdevDocs } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const GOOD_TOKEN = "stored-by-another-session";
const GUARD_MS = 5_000;

interface LoginRequiredServer {
	readonly url: string;
	/** POSTs that carried the stored token, and POSTs refused with 401. */
	readonly state: { authorizedPosts: number; refusedPosts: number };
	stop(): void;
}

/** Streamable HTTP MCP server that answers 401 to any request without the stored token. */
function startLoginRequiredServer(): LoginRequiredServer {
	const state = { authorizedPosts: 0, refusedPosts: 0 };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (request.headers.get("authorization") !== `Bearer ${GOOD_TOKEN}`) {
				if (request.method === "POST") state.refusedPosts += 1;
				return Response.json(
					{ jsonrpc: "2.0", id: null, error: { code: -32001, message: "missing_token" } },
					{
						status: 401,
						headers: { "WWW-Authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/none"' },
					},
				);
			}
			if (request.method === "GET") return new Response(null, { status: 405 });
			if (request.method === "DELETE") return new Response(null, { status: 200 });
			state.authorizedPosts += 1;
			const message = (await request.json()) as { id?: number | string; method: string };
			if (message.id === undefined) return new Response(null, { status: 202 });
			let result: unknown = {};
			if (message.method === "initialize") {
				result = {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "login-required", version: "1" },
				};
			} else if (message.method === "tools/list") {
				result = {
					tools: [{ name: "ping", description: "Answers pong", inputSchema: { type: "object", properties: {} } }],
				};
			}
			return Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "Mcp-Session-Id": "s1" } });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/mcp`, state, stop: () => server.stop(true) };
}

/** Resolve once `name` is registered, however late the reconnect lands. */
async function toolRegistered(manager: MCPManager, name: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const check = () => {
		if (manager.getTools().some(tool => tool.name === name)) resolve();
	};
	const unsubscribe = manager.addToolsChangedListener(check);
	check();
	try {
		await promise;
	} finally {
		unsubscribe();
	}
}

describe("MCP server that is not connected", () => {
	let tempDir: string;
	let session: AuthStorage;
	let otherSession: AuthStorage;
	let manager: MCPManager;
	let server: LoginRequiredServer;
	let config: MCPHttpServerConfig;

	// Opening a SqliteAuthCredentialStore creates and migrates its tables; on a loaded host that took
	// 9-14 s for the two opens below (a 64-core host at load ~400). Open them once per
	// file with that budget instead of in every beforeEach under the default 5 s hook limit.
	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-unavailable-"));
		const dbPath = path.join(tempDir, "agent.db");
		// Two stores on one file: this session and another omp process on the same machine.
		session = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath));
		otherSession = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath));
		await session.credentials.reload();
		await otherSession.credentials.reload();
	}, 60_000);

	afterAll(async () => {
		session.close();
		otherSession.close();
		await removeWithRetries(tempDir);
	});

	// Each test gets its own server, so its own URL and credential id.
	beforeEach(async () => {
		server = startLoginRequiredServer();
		config = { type: "http", url: server.url, timeout: 2_000 };
		manager = new MCPManager(tempDir);
		manager.setAuthStorage(session);
		await manager.connectServers({ remote: config }, {});
		await manager.waitForStartup(GUARD_MS);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		server.stop();
		// A later test whose server reuses this port must start with no login stored.
		await otherSession.credentials.remove(mcpOAuthCredentialId(server.url));
		await session.credentials.poll();
	});

	async function storeLoginInOtherSession(): Promise<void> {
		await otherSession.credentials.set(mcpOAuthCredentialId(server.url), {
			type: "oauth",
			access: GOOD_TOKEN,
			refresh: "unused-refresh",
			expires: Date.now() + 3_600_000,
		});
	}

	it("names the server, its error and the recovery instead of vanishing", () => {
		expect(manager.getTools()).toHaveLength(0);
		const note = manager.explainMissingTool("mcp__remote_ping");
		expect(note).toContain("remote");
		expect(note).toContain("401");
		expect(note).toContain("/mcp reauth <server>");
		expect(note).toContain("/mcp reconnect <server>");
		// A name that cannot belong to an MCP server gets no note.
		expect(manager.explainMissingTool("read")).toBeUndefined();
	});

	it("puts the note in the xd:// error the model reads", () => {
		const toolSession = { mcpManager: manager } as unknown as ToolSession;
		const state = createXdevState(toolSession, new Map(), new Set());
		expect(() => xdevDocs(state, "mcp__remote_ping")).toThrow(
			/No such tool: xd:\/\/mcp__remote_ping[\s\S]*remote[\s\S]*401/,
		);
	});

	it("does not retry a server whose login is still missing", async () => {
		const refused = server.state.refusedPosts;
		manager.explainMissingTool("mcp__remote_ping");
		// The background check is one pool poll and a lookup. It was queued
		// first, so it has settled once this poll of the same pool has.
		await session.credentials.poll();
		expect(manager.getConnectionStatus("remote")).toBe("disconnected");
		expect(server.state.refusedPosts).toBe(refused);
		expect(server.state.authorizedPosts).toBe(0);
	});

	it("reconnects with a login another session stored, with no restart", async () => {
		await storeLoginInOtherSession();
		// This session's credential pool has not seen the other session's write.
		expect(manager.getTools()).toHaveLength(0);
		manager.explainMissingTool("mcp__remote_ping");
		await toolRegistered(manager, "mcp__remote_ping");
		expect(manager.getConnectionStatus("remote")).toBe("connected");
		expect(manager.explainMissingTool("mcp__remote_ping")).toBeUndefined();
	});
});
