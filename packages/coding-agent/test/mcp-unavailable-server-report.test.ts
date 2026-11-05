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

	it("promises a reconnect only for the servers that failed for want of a login", async () => {
		// `crashed` exits before answering: no login would bring it back, so the
		// note must not tell the model that omp is reconnecting it.
		const mixed = new MCPManager(tempDir);
		mixed.setAuthStorage(session);
		try {
			await mixed.connectServers(
				{
					crashed: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(3)"], timeout: 2_000 },
				},
				{},
			);
			await mixed.waitForStartup(GUARD_MS);
			expect(mixed.getConnectionStatus("crashed")).toBe("disconnected");
			const crashedOnly = mixed.explainMissingTool("mcp__crashed_ping");
			expect(crashedOnly).toContain("crashed");
			expect(crashedOnly).not.toContain("omp is checking now");
		} finally {
			await mixed.disconnectAll();
		}
		const remoteNote = manager.explainMissingTool("mcp__remote_ping");
		expect(remoteNote).toContain("omp is checking now whether a login was stored for remote");
		await session.credentials.poll();
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

	it("reconnects every server whose login another session stored, on one miss", async () => {
		// Two more servers down for want of a login, plus an unrelated login in the store, so the
		// credential pool holds more than one provider. Another session then stores a login for the
		// last one only. One `mcp__` miss must bring that server back: a check that reads the pool
		// before this session has reloaded the other session's write would leave it down.
		const alpha = startLoginRequiredServer();
		const beta = startLoginRequiredServer();
		const two = new MCPManager(tempDir);
		two.setAuthStorage(session);
		try {
			await otherSession.credentials.set("unrelated-provider", { type: "api_key", key: "k" });
			await session.credentials.poll();
			await two.connectServers(
				{
					alpha: { type: "http", url: alpha.url, timeout: 2_000 },
					beta: { type: "http", url: beta.url, timeout: 2_000 },
				},
				{},
			);
			await two.waitForStartup(GUARD_MS);
			expect(two.getConnectionStatus("beta")).toBe("disconnected");
			await otherSession.credentials.set(mcpOAuthCredentialId(beta.url), {
				type: "oauth",
				access: GOOD_TOKEN,
				refresh: "unused-refresh",
				expires: Date.now() + 3_600_000,
			});
			two.explainMissingTool("mcp__beta_ping");
			await toolRegistered(two, "mcp__beta_ping");
			expect(two.getConnectionStatus("beta")).toBe("connected");
			expect(two.getConnectionStatus("alpha")).toBe("disconnected");
		} finally {
			await two.disconnectAll();
			alpha.stop();
			beta.stop();
			await otherSession.credentials.remove(mcpOAuthCredentialId(beta.url));
			await otherSession.credentials.remove("unrelated-provider");
			await session.credentials.poll();
		}
	});

	/**
	 * A `lazy: true` server is deliberately outside the startup barrier:
	 * dormant is not a failure, and `/mcp list` shows it as connecting on
	 * first use. The moment something asks it to connect and that connect
	 * fails, it is as unavailable as any other server, so the note has to
	 * name it — a failure is recorded for every server the manager holds a
	 * config for, not only the barrier's members.
	 */
	it("ignores a dormant lazy server and names it once its first connect fails", async () => {
		const lazyServer = startLoginRequiredServer();
		// One attempt, no ladder: the failure is reported without the retry sleeps.
		const lazyManager = new MCPManager(tempDir, null, undefined, {
			ladderMs: [],
			retryBaseMs: 60_000,
			retryMaxMs: 60_000,
		});
		lazyManager.setAuthStorage(session);
		try {
			const lazyConfig: MCPHttpServerConfig = { type: "http", url: lazyServer.url, timeout: 2_000, lazy: true };
			await lazyManager.connectServers({ dormant: lazyConfig }, {});
			const dormant = await lazyManager.waitForStartup(GUARD_MS);

			// Dormant by design: nothing was tried, so nothing failed — and with
			// no cached catalog it has no tools, which is still not a failure.
			expect(lazyServer.state.refusedPosts).toBe(0);
			expect(dormant.failed).toHaveLength(0);
			expect(lazyManager.explainMissingTool("mcp__dormant_ping")).toBeUndefined();

			// First use — `/mcp reconnect`, the path a deferred tool's fallback
			// also takes — fails: from here it is a real failure.
			await lazyManager.reconnectServer("dormant", { manual: true });
			expect(lazyServer.state.refusedPosts).toBeGreaterThan(0);
			const note = lazyManager.explainMissingTool("mcp__dormant_ping");
			expect(note).toContain("dormant");
			expect(note).toContain("401");
			expect(note).toContain("/mcp reauth <server>");
			expect(note).toContain("/mcp reconnect <server>");
			// Still no startup-barrier member: print mode must not wait on it.
			expect((await lazyManager.waitForStartup(GUARD_MS)).failed).toHaveLength(0);

			// And a login another session stores brings it back with no restart.
			await otherSession.credentials.set(mcpOAuthCredentialId(lazyServer.url), {
				type: "oauth",
				access: GOOD_TOKEN,
				refresh: "unused-refresh",
				expires: Date.now() + 3_600_000,
			});
			lazyManager.explainMissingTool("mcp__dormant_ping");
			await toolRegistered(lazyManager, "mcp__dormant_ping");
			expect(lazyManager.getConnectionStatus("dormant")).toBe("connected");
		} finally {
			await lazyManager.disconnectAll();
			lazyServer.stop();
			await otherSession.credentials.remove(mcpOAuthCredentialId(lazyServer.url));
			await session.credentials.poll();
		}
	});
});
