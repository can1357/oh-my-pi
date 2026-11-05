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
 * - a server whose tools are still mounted — a lazy one serving the catalog
 *   cached from its last connect, or one lost mid-session — is never
 *   described as having none: it is not why the asked-for tool is missing;
 * - a failure belongs to the config that produced it, so replacing a
 *   server's config retires both its error text and its pending login check;
 * - a remote server that failed while no login was stored is reconnected, with
 *   no restart, once another session stores a login and the model asks for
 *   one of its tools again; without a stored login nothing is retried, and a
 *   server that failed for any reason other than an auth challenge is never
 *   promised a login check at all.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { MCPManager, type MCPReconnectPolicy } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPHttpServerConfig, MCPStdioServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createXdevState } from "@oh-my-pi/pi-coding-agent/tools";
import { xdevDocs } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const GOOD_TOKEN = "stored-by-another-session";
const GUARD_MS = 5_000;

/** One connect attempt, no ladder, so a failure is reported without retry sleeps. */
const SINGLE_ATTEMPT: MCPReconnectPolicy = { ladderMs: [], retryBaseMs: 60_000, retryMaxMs: 60_000 };

const PING_DEF: MCPToolDefinition = {
	name: "ping",
	description: "Answers pong",
	inputSchema: { type: "object", properties: {} },
};

/**
 * A stdio MCP server that completes one handshake and exits, and whose
 * respawn is impossible: the second process sees the marker and exits at
 * once. Reproduces a server lost mid-session that cannot be brought back,
 * whose tools stay registered so a call still routes through the per-call
 * reconnect.
 */
const DIES_ONCE_SCRIPT = `
const fs = require("node:fs");
const marker = process.env.DIES_MARKER;
if (fs.existsSync(marker)) process.exit(3);
fs.writeFileSync(marker, "spawned");
let buffer = "";
process.stdin.on("data", chunk => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id === undefined || message.id === null) continue;
		let result = {};
		if (message.method === "initialize") {
			result = {
				protocolVersion: "2025-03-26",
				serverInfo: { name: "dies-once", version: "1" },
				capabilities: { tools: {} },
			};
		} else if (message.method === "tools/list") {
			result = { tools: [{ name: "ping", description: "Answers pong", inputSchema: { type: "object", properties: {} } }] };
		}
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
		if (message.method === "tools/list") setTimeout(() => process.exit(0), 100);
	}
});
`;

/** In-memory stand-in for agent.db's cache table. */
function memoryStorage(): AgentStorage {
	const store = new Map<string, string>();
	return {
		getCache: (key: string) => store.get(key) ?? null,
		setCache: (key: string, value: string) => {
			store.set(key, value);
		},
	} as unknown as AgentStorage;
}

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

	/**
	 * B1. A lazy server serves the catalog cached from its last successful
	 * connect, so its tools stay mounted even after a first-use connect
	 * fails. Telling the model those tools "are not mounted" contradicts
	 * what it can see and steers it away from the per-call reconnect the
	 * deferred tool exists to perform.
	 */
	it("does not report a lazy server whose cached tools are still mounted", async () => {
		const lazyServer = startLoginRequiredServer();
		const lazyConfig: MCPHttpServerConfig = { type: "http", url: lazyServer.url, timeout: 2_000, lazy: true };
		const cache = new MCPToolCache(memoryStorage());
		await cache.set("dormant", lazyConfig, [PING_DEF]);
		const lazyManager = new MCPManager(tempDir, cache, undefined, SINGLE_ATTEMPT);
		lazyManager.setAuthStorage(session);
		try {
			await lazyManager.connectServers({ dormant: lazyConfig }, {});
			expect(lazyManager.getTools().map(tool => tool.name)).toContain("mcp__dormant_ping");

			// First use fails, so the server is down — but its tools did not go away.
			await lazyManager.reconnectServer("dormant", { manual: true });
			expect(lazyManager.getConnectionStatus("dormant")).toBe("disconnected");
			expect(lazyManager.getTools().map(tool => tool.name)).toContain("mcp__dormant_ping");

			expect(lazyManager.explainMissingTool("mcp__dormant_search")).toBeUndefined();
		} finally {
			await lazyManager.disconnectAll();
			lazyServer.stop();
			await session.credentials.poll();
		}
	}, 30_000);

	/**
	 * B1, same shape from the other end: a server that connected and then
	 * died keeps its tools registered on purpose, so a call routes through
	 * the tool-level reconnect. The note must not claim they are gone.
	 */
	it("does not report a server that died mid-session with its tools still mounted", async () => {
		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-dies-"));
		const dying = new MCPManager(workDir, null, undefined, SINGLE_ATTEMPT);
		const { promise: failed, resolve: onFailed } = Promise.withResolvers<void>();
		const unsubscribe = dying.addConnectionStatusListener(event => {
			if (event.type === "failed" && event.serverName === "alive") onFailed();
		});
		try {
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: process.execPath,
				args: ["-e", DIES_ONCE_SCRIPT],
				env: { DIES_MARKER: path.join(workDir, "spawned") },
				timeout: 5_000,
			};
			await dying.connectServers({ alive: config }, {});
			await dying.waitForStartup(GUARD_MS);
			expect(dying.getTools().map(tool => tool.name)).toContain("mcp__alive_ping");

			// The process exits, the respawn exits at once, and the failure lands;
			// the second wait lets the reconnect itself finish unwinding.
			await failed;
			await dying.waitForStartup(GUARD_MS);
			expect(dying.getConnectionStatus("alive")).toBe("disconnected");
			expect(dying.getTools().map(tool => tool.name)).toContain("mcp__alive_ping");

			expect(dying.explainMissingTool("mcp__alive_search")).toBeUndefined();
		} finally {
			unsubscribe();
			await dying.disconnectAll();
			await removeWithRetries(workDir);
		}
	}, 30_000);

	/**
	 * B2, first shape. A lazy server never retries on its own, so a failure
	 * recorded against a config nobody holds any more would be reported for
	 * the rest of the session — with the error of an endpoint that is no
	 * longer configured.
	 */
	it("retires a failure when the server's config is replaced", async () => {
		const replacement = startLoginRequiredServer();
		const reconfigured = new MCPManager(tempDir, null, undefined, SINGLE_ATTEMPT);
		reconfigured.setAuthStorage(session);
		try {
			const stdioConfig: MCPStdioServerConfig = {
				type: "stdio",
				command: process.execPath,
				args: ["-e", "process.exit(3)"],
				timeout: 2_000,
				lazy: true,
			};
			await reconfigured.connectServers({ dormant: stdioConfig }, {});
			await reconfigured.reconnectServer("dormant", { manual: true });
			expect(reconfigured.explainMissingTool("mcp__dormant_ping")).toContain("subprocess");

			// `/mcp test`, `/mcp enable` and the project-config path all reach
			// `connectServers` incrementally with an edited config.
			const httpConfig: MCPHttpServerConfig = { type: "http", url: replacement.url, timeout: 2_000, lazy: true };
			await reconfigured.connectServers({ dormant: httpConfig }, {});
			expect(reconfigured.getServerConfig("dormant")).toBe(httpConfig);

			// Nothing has asked the replacement to connect, so it has not failed.
			expect(reconfigured.explainMissingTool("mcp__dormant_ping")).toBeUndefined();
		} finally {
			await reconfigured.disconnectAll();
			replacement.stop();
			await session.credentials.poll();
		}
	}, 30_000);

	/**
	 * B2, second shape and the worse one: the stale record also carried the
	 * pending login check, and that check reads the *current* config. A
	 * login stored for the replacement endpoint then connected it off an
	 * unrelated missing tool name — no first use, no `/mcp reconnect`,
	 * which is the whole point of `lazy`.
	 */
	it("does not connect a replacement endpoint on a login stored for it", async () => {
		const first = startLoginRequiredServer();
		const replacement = startLoginRequiredServer();
		const reconfigured = new MCPManager(tempDir, null, undefined, SINGLE_ATTEMPT);
		reconfigured.setAuthStorage(session);
		try {
			await reconfigured.connectServers(
				{ dormant: { type: "http", url: first.url, timeout: 2_000, lazy: true } },
				{},
			);
			await reconfigured.reconnectServer("dormant", { manual: true });
			expect(first.state.refusedPosts).toBeGreaterThan(0);

			await reconfigured.connectServers(
				{ dormant: { type: "http", url: replacement.url, timeout: 2_000, lazy: true } },
				{},
			);
			await otherSession.credentials.set(mcpOAuthCredentialId(replacement.url), {
				type: "oauth",
				access: GOOD_TOKEN,
				refresh: "unused-refresh",
				expires: Date.now() + 3_600_000,
			});

			const note = reconfigured.explainMissingTool("mcp__dormant_ping");
			// The background check is one pool poll and a lookup; it was queued
			// first, so it has settled once this poll of the same pool has.
			await session.credentials.poll();
			// An integration wait, not a guessed race window: the contract is
			// that *nothing* happens, and the only observable of the defect is a
			// loopback handshake this session never asked for. Fake timers cannot
			// drive a real socket, so allow far more than the few milliseconds
			// that handshake takes when it does run.
			await Bun.sleep(500);
			expect(replacement.state.authorizedPosts).toBe(0);
			expect(replacement.state.refusedPosts).toBe(0);
			expect(reconfigured.getConnectionStatus("dormant")).toBe("disconnected");
			expect(note).toBeUndefined();
		} finally {
			await reconfigured.disconnectAll();
			first.stop();
			replacement.stop();
			await otherSession.credentials.remove(mcpOAuthCredentialId(replacement.url));
			await session.credentials.poll();
		}
	}, 30_000);

	/**
	 * B3. "omp is checking now whether a login was stored" promises a
	 * recovery that only an auth failure can have. A plain HTTP server that
	 * is merely down has no login to wait for, and pointing the user at
	 * `/mcp reauth` for a network outage is a wrong answer.
	 */
	it("promises a login check only for a failure the server answered with an auth challenge", async () => {
		// A port that was listening and is not any more: a plain connect refusal.
		const vacant = startLoginRequiredServer();
		const vacantUrl = vacant.url;
		vacant.stop();
		const offline = new MCPManager(tempDir, null, undefined, SINGLE_ATTEMPT);
		offline.setAuthStorage(session);
		try {
			await offline.connectServers({ plainhttp: { type: "http", url: vacantUrl, timeout: 2_000 } }, {});
			await offline.waitForStartup(GUARD_MS);
			expect(offline.getConnectionStatus("plainhttp")).toBe("disconnected");

			const note = offline.explainMissingTool("mcp__plainhttp_ping");
			expect(note).toContain("plainhttp");
			expect(note).toContain("ECONNREFUSED");
			expect(note).not.toContain("omp is checking now");
		} finally {
			await offline.disconnectAll();
			await session.credentials.poll();
		}
	}, 30_000);
});
