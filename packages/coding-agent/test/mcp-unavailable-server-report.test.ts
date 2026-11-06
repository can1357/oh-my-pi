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
 * - a remote server whose connect was answered with an auth challenge is
 *   reconnected, with no restart, once the store holds a login other than the
 *   one that attempt sent — whether it sent none or a token since rotated —
 *   and is left alone, polls aside, while that login is unchanged; a server
 *   that failed for any other reason is never promised a login check;
 * - a rejected config edit changes neither the definition the manager holds
 *   nor what its own last attempt recorded;
 * - reading the report does not change what the startup barrier reports;
 * - a server's name reaches the report whole, because the report tells the
 *   model to type it into `/mcp reconnect <server>`.
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

/**
 * Streamable HTTP MCP server that answers 401 to any request without the
 * stored token. `onRefusedPost` runs before the 401 is written, so a test
 * can hold an unauthenticated request on the wire while the credential
 * store changes under it.
 */
function startLoginRequiredServer(options: { onRefusedPost?: () => Promise<void> | void } = {}): LoginRequiredServer {
	const state = { authorizedPosts: 0, refusedPosts: 0 };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (request.headers.get("authorization") !== `Bearer ${GOOD_TOKEN}`) {
				if (request.method === "POST") {
					state.refusedPosts += 1;
					await options.onRefusedPost?.();
				}
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

/** Resolve once `name` reports connected, however late the reconnect lands. */
async function connectionEstablished(manager: MCPManager, name: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const check = () => {
		if (manager.getConnectionStatus(name) === "connected") resolve();
	};
	const unsubscribe = manager.addConnectionStatusListener(check);
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
	 * R2-a. A lazy server serves the catalog cached from its last successful
	 * connect, so its tools stay mounted even after a first-use connect
	 * fails. Round 1 dropped such a server from the note altogether, which
	 * also dropped the only diagnosis available when that cache is stale:
	 * here the server renamed `ping` to `search`, and the model asking for
	 * `mcp__dormant_search` is told nothing. It is named again — in a clause
	 * that is true of it, "still serving the tools cached from an earlier
	 * connect". The sentence round 1 was right to call false of it, that its
	 * tools are not mounted, is reserved for servers with no tools: `broken`
	 * is here so both groups render in one note.
	 */
	it("reports a lazy server whose cached tools are still mounted without calling them absent", async () => {
		const lazyServer = startLoginRequiredServer();
		const lazyConfig: MCPHttpServerConfig = { type: "http", url: lazyServer.url, timeout: 2_000, lazy: true };
		const cache = new MCPToolCache(memoryStorage());
		await cache.set("dormant", lazyConfig, [PING_DEF]);
		const lazyManager = new MCPManager(tempDir, cache, undefined, SINGLE_ATTEMPT);
		lazyManager.setAuthStorage(session);
		try {
			await lazyManager.connectServers(
				{
					dormant: lazyConfig,
					broken: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(3)"], timeout: 2_000 },
				},
				{},
			);
			await lazyManager.waitForStartup(GUARD_MS);
			expect(lazyManager.getTools().map(tool => tool.name)).toContain("mcp__dormant_ping");

			// First use fails, so the server is down — but its tools did not go away.
			await lazyManager.reconnectServer("dormant", { manual: true });
			expect(lazyManager.getConnectionStatus("dormant")).toBe("disconnected");
			expect(lazyManager.getTools().map(tool => tool.name)).toContain("mcp__dormant_ping");

			const note = lazyManager.explainMissingTool("mcp__dormant_search");
			expect(note).toContain("dormant");
			expect(note).toContain("401");
			expect(note).toContain("still serving the tools cached from an earlier connect");
			expect(note).toContain("/mcp reconnect <server>");
			// The "not mounted" sentence is spent on the server that really has
			// no tools, and never reaches the one whose cached tools the model
			// can see listed.
			expect(note).toContain("so its tools are not mounted: broken");
			expect(note).not.toMatch(/tools are not mounted:[^.]*dormant/);
		} finally {
			await lazyManager.disconnectAll();
			lazyServer.stop();
			await session.credentials.poll();
		}
	}, 30_000);

	/**
	 * R2-a, same shape from the other end: a server that connected and then
	 * died keeps its tools registered on purpose, so a call routes through
	 * the tool-level reconnect. It is reported, because the model cannot see
	 * why `mcp__alive_search` is missing otherwise, and reported as what it
	 * is: serving a cached list, not stripped of its tools.
	 */
	it("reports a server that died mid-session as still serving its mounted tools", async () => {
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

			const note = dying.explainMissingTool("mcp__alive_search");
			expect(note).toContain("alive");
			expect(note).toContain("still serving the tools cached from an earlier connect");
			expect(note).not.toContain("tools are not mounted");
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

	/**
	 * R2-b, the recovery #18014 exists for, in the configuration #9793 adds.
	 * `#reconnectWithStoredLogin` is the manager's only cross-process
	 * credential poll, so a login another process stored is invisible until
	 * it runs. Round 1 skipped it for any server with tools mounted, which
	 * is every lazy server with a warm cache: the eager control above
	 * ("reconnects with a login another session stored, with no restart")
	 * recovered and this one could not, for the same 401 and the same
	 * `agent.db`. The deferred tool's per-call reconnect is not a substitute
	 * — it never polls — and a tool the cache does not list has no deferred
	 * wrapper to call at all.
	 */
	it("reconnects a lazy server serving cached tools when another session stores its login", async () => {
		const lazyServer = startLoginRequiredServer();
		const lazyConfig: MCPHttpServerConfig = { type: "http", url: lazyServer.url, timeout: 2_000, lazy: true };
		const cache = new MCPToolCache(memoryStorage());
		await cache.set("dormant", lazyConfig, [PING_DEF]);
		const lazyManager = new MCPManager(tempDir, cache, undefined, SINGLE_ATTEMPT);
		lazyManager.setAuthStorage(session);
		try {
			await lazyManager.connectServers({ dormant: lazyConfig }, {});
			expect(lazyManager.getTools().map(tool => tool.name)).toContain("mcp__dormant_ping");

			// First use fails with 401: down, with its cached catalog still mounted.
			await lazyManager.reconnectServer("dormant", { manual: true });
			expect(lazyManager.getConnectionStatus("dormant")).toBe("disconnected");
			expect(lazyServer.state.authorizedPosts).toBe(0);

			// Another omp process on this machine signs the server in.
			await otherSession.credentials.set(mcpOAuthCredentialId(lazyServer.url), {
				type: "oauth",
				access: GOOD_TOKEN,
				refresh: "unused-refresh",
				expires: Date.now() + 3_600_000,
			});

			// The model asks for a tool this cache never had; the miss is what
			// drives the login check.
			lazyManager.explainMissingTool("mcp__dormant_search");
			// The recovery is a credential poll plus a real loopback handshake,
			// which no fake clock can drive; the bound only keeps a regression
			// reporting the connection state instead of the hook timeout.
			await Promise.race([connectionEstablished(lazyManager, "dormant"), Bun.sleep(5_000)]);
			expect(lazyManager.getConnectionStatus("dormant")).toBe("connected");
			expect(lazyServer.state.authorizedPosts).toBeGreaterThan(0);
		} finally {
			await lazyManager.disconnectAll();
			lazyServer.stop();
			await otherSession.credentials.remove(mcpOAuthCredentialId(lazyServer.url));
			await session.credentials.poll();
		}
	}, 30_000);

	/**
	 * R2-c. The failure record describes the attempt that produced it, so a
	 * writer landing while that attempt is in flight cannot inherit its
	 * error: the record is bound to the config the attempt used, not to
	 * whatever `#serverConfigs` holds when the failure finally lands.
	 */
	it("does not pin a mid-connect failure on the config that replaced it", async () => {
		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-swap-"));
		const swapped = new MCPManager(workDir, null, undefined, SINGLE_ATTEMPT);
		try {
			const attempted: MCPStdioServerConfig = {
				type: "stdio",
				command: process.execPath,
				args: ["-e", "setTimeout(() => process.exit(3), 400)"],
				timeout: 5_000,
			};
			const connecting = swapped.connectServers({ swap: attempted }, {});
			// A real subprocess decides when the attempt ends, so the writer's
			// arrival inside that window is a real delay, not a clock to fake:
			// the config is replaced well before the child exits.
			await Bun.sleep(150);
			const replacement: MCPStdioServerConfig = {
				...attempted,
				args: ["-e", "setTimeout(() => process.exit(7), 400)"],
			};
			swapped.updateServerConfig("swap", replacement);
			await connecting;
			await swapped.waitForStartup(GUARD_MS);
			expect(swapped.getServerConfig("swap")).toBe(replacement);

			// Nothing has tried the replacement, so it has no error to report.
			expect(swapped.explainMissingTool("mcp__swap_ping")).toBeUndefined();
		} finally {
			await swapped.disconnectAll();
			await removeWithRetries(workDir);
		}
	}, 30_000);

	/**
	 * R2-c, the other half: the startup barrier reports what happened to the
	 * server it waited on. Binding the record to the live config made the
	 * barrier lose the attempt's own error to the generic fallback as soon
	 * as anything replaced the definition, so headless `omp -p` printed
	 * "Connection closed before tools became available" for a server that
	 * had said exactly why it failed.
	 */
	it("keeps the failed attempt's error on the startup barrier after the config is replaced", async () => {
		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-bar-"));
		const barrier = new MCPManager(workDir, null, undefined, SINGLE_ATTEMPT);
		try {
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: process.execPath,
				args: ["-e", "process.exit(3)"],
				timeout: 2_000,
			};
			await barrier.connectServers({ gone: config }, {});
			const before = await barrier.waitForStartup(GUARD_MS);
			expect(before.failed[0]?.error).toContain("MCP subprocess closed stdout before responding");

			barrier.updateServerConfig("gone", { ...config });
			const after = await barrier.waitForStartup(GUARD_MS);
			expect(after.failed[0]?.error).toContain("MCP subprocess closed stdout before responding");
			expect(after.failed[0]?.error).not.toContain("Connection closed before tools became available");
		} finally {
			await barrier.disconnectAll();
			await removeWithRetries(workDir);
		}
	}, 30_000);

	/**
	 * R3-a. The login a failed attempt did not have can arrive while that
	 * attempt is still on the wire: another process writes the row and any
	 * ordinary credential poll in this one adopts it. Deciding at emit time
	 * that a login is already stored — and therefore that none is awaited —
	 * disarms the only recovery a lazy server has, for a 401 that went out
	 * unauthenticated. The record has to describe the attempt: it sent no
	 * login, so a login in the store is new to it.
	 */
	it("recovers a server whose login was stored while its unauthenticated attempt was in flight", async () => {
		const onWire = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let held = false;
		const inflight = startLoginRequiredServer({
			onRefusedPost: async () => {
				if (held) return;
				held = true;
				onWire.resolve();
				await release.promise;
			},
		});
		const racing = new MCPManager(tempDir, null, undefined, SINGLE_ATTEMPT);
		racing.setAuthStorage(session);
		try {
			const connecting = racing.connectServers({ remote: { type: "http", url: inflight.url, timeout: 10_000 } }, {});
			// The initialize is at the server, sent without Authorization.
			await onWire.promise;
			// Another omp process signs the server in, and this process's pool
			// adopts the row — what any other missing-tool lookup's poll does.
			await otherSession.credentials.set(mcpOAuthCredentialId(inflight.url), {
				type: "oauth",
				access: GOOD_TOKEN,
				refresh: "unused-refresh",
				expires: Date.now() + 3_600_000,
			});
			await session.credentials.poll();
			release.resolve();
			await connecting;
			await racing.waitForStartup(GUARD_MS);
			expect(racing.getConnectionStatus("remote")).toBe("disconnected");
			expect(inflight.state.authorizedPosts).toBe(0);

			const note = racing.explainMissingTool("mcp__remote_ping");
			expect(note).toContain("omp is checking now whether a login was stored for remote");
			await Promise.race([connectionEstablished(racing, "remote"), Bun.sleep(5_000)]);
			expect(racing.getConnectionStatus("remote")).toBe("connected");
			expect(inflight.state.authorizedPosts).toBeGreaterThan(0);
		} finally {
			release.resolve();
			await racing.disconnectAll();
			inflight.stop();
			await otherSession.credentials.remove(mcpOAuthCredentialId(inflight.url));
			await session.credentials.poll();
		}
	}, 30_000);

	/**
	 * R3-b. The same defect in its other spelling: a credential is present
	 * and is exactly what the server refused. A rotated or revoked token
	 * made the note promise no login check and `/mcp reconnect` unable to
	 * succeed, while a credential poll plus the same reconnect did — which
	 * is #18014's own user story, told about a token instead of about none.
	 */
	it("reconnects with a login that replaced the token the server refused", async () => {
		const rotating = startLoginRequiredServer();
		const stale = new MCPManager(tempDir, null, undefined, SINGLE_ATTEMPT);
		stale.setAuthStorage(session);
		try {
			await otherSession.credentials.set(mcpOAuthCredentialId(rotating.url), {
				type: "oauth",
				access: "rotated-away",
				refresh: "unused-refresh",
				expires: Date.now() + 3_600_000,
			});
			await session.credentials.poll();
			await stale.connectServers({ remote: { type: "http", url: rotating.url, timeout: 2_000 } }, {});
			await stale.waitForStartup(GUARD_MS);
			expect(stale.getConnectionStatus("remote")).toBe("disconnected");
			expect(rotating.state.authorizedPosts).toBe(0);

			const note = stale.explainMissingTool("mcp__remote_ping");
			expect(note).toContain("omp is checking now whether a login was stored for remote");
			// The only login in the store is still the refused one.
			await session.credentials.poll();
			expect(stale.getConnectionStatus("remote")).toBe("disconnected");

			await otherSession.credentials.set(mcpOAuthCredentialId(rotating.url), {
				type: "oauth",
				access: GOOD_TOKEN,
				refresh: "unused-refresh",
				expires: Date.now() + 3_600_000,
			});
			stale.explainMissingTool("mcp__remote_ping");
			await Promise.race([connectionEstablished(stale, "remote"), Bun.sleep(5_000)]);
			expect(stale.getConnectionStatus("remote")).toBe("connected");
			expect(rotating.state.authorizedPosts).toBeGreaterThan(0);
		} finally {
			await stale.disconnectAll();
			rotating.stop();
			await otherSession.credentials.remove(mcpOAuthCredentialId(rotating.url));
			await session.credentials.poll();
		}
	}, 30_000);

	/**
	 * R3-c. Arming the check on the auth challenge alone would be a
	 * reconnect storm if the check then acted on a credential's mere
	 * presence: every miss would re-handshake a server whose stored token
	 * the server has already refused. Comparing against the credential the
	 * attempt sent is what bounds it — the store is polled on every miss,
	 * the network is not touched again.
	 */
	it("polls on every miss without re-handshaking while the stored login is unchanged", async () => {
		const refusing = startLoginRequiredServer();
		const quiet = new MCPManager(tempDir, null, undefined, SINGLE_ATTEMPT);
		quiet.setAuthStorage(session);
		try {
			await otherSession.credentials.set(mcpOAuthCredentialId(refusing.url), {
				type: "oauth",
				access: "rotated-away",
				refresh: "unused-refresh",
				expires: Date.now() + 3_600_000,
			});
			await session.credentials.poll();
			await quiet.connectServers({ remote: { type: "http", url: refusing.url, timeout: 2_000 } }, {});
			await quiet.waitForStartup(GUARD_MS);
			const afterConnect = refusing.state.refusedPosts;
			expect(afterConnect).toBeGreaterThan(0);

			for (let miss = 0; miss < 20; miss++) {
				expect(quiet.explainMissingTool("mcp__remote_ping")).toContain("omp is checking now");
				// Each check is one pool poll and a comparison; it was queued
				// first, so it has settled once this poll of the same pool has.
				await session.credentials.poll();
			}
			expect(refusing.state.refusedPosts).toBe(afterConnect);
			expect(refusing.state.authorizedPosts).toBe(0);
			expect(quiet.getConnectionStatus("remote")).toBe("disconnected");
		} finally {
			await quiet.disconnectAll();
			refusing.stop();
			await otherSession.credentials.remove(mcpOAuthCredentialId(refusing.url));
			await session.credentials.poll();
		}
	}, 30_000);

	/**
	 * R3-d. The barrier's string must not depend on who read the record
	 * first. `#liveFailure` used to delete the stale record it was asked
	 * about, so headless `omp -p` printed the server's own error or the
	 * generic fallback according to whether the model had asked for a
	 * missing MCP tool in between — identical manager and server state,
	 * different answer.
	 */
	it("reports the same barrier error whether or not a missing-tool lookup ran first", async () => {
		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-drift-"));
		const drift = new MCPManager(workDir, null, undefined, SINGLE_ATTEMPT);
		try {
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: process.execPath,
				args: ["-e", "process.exit(3)"],
				timeout: 2_000,
			};
			await drift.connectServers({ swapped: config }, {});
			const before = await drift.waitForStartup(GUARD_MS);
			expect(before.failed[0]?.error).toContain("MCP subprocess closed stdout before responding");

			// A replacement nobody has tried: the record is stale for the
			// reader that acts on the live config, and that reader says so
			// without changing what the barrier will say.
			drift.updateServerConfig("swapped", { ...config });
			expect(drift.explainMissingTool("mcp__swapped_ping")).toBeUndefined();

			const after = await drift.waitForStartup(GUARD_MS);
			expect(after.failed[0]?.error).toBe(before.failed[0]?.error);
		} finally {
			await drift.disconnectAll();
			await removeWithRetries(workDir);
		}
	}, 30_000);

	/**
	 * R3-e. A config that fails validation is never stored, so the server
	 * the manager holds is the one that was there before — and so is its
	 * last attempt. Binding the rejection's error to the live definition
	 * replaced a real HTTP 401 with `requires "url" field` and, because a
	 * validation failure refuses nothing, took the login recovery with it.
	 */
	it("keeps a live endpoint's failure and recovery when an invalid edit is rejected", async () => {
		const live = manager.getServerConfig("remote");
		await manager.connectServers({ remote: { type: "http", url: "" } }, {});
		expect(manager.getServerConfig("remote")).toBe(live);

		const note = manager.explainMissingTool("mcp__remote_ping");
		expect(note).toContain("401");
		expect(note).not.toContain('requires "url" field');
		expect(note).toContain("omp is checking now whether a login was stored for remote");

		// And the recovery the rejected edit used to strip still runs.
		await storeLoginInOtherSession();
		manager.explainMissingTool("mcp__remote_ping");
		await toolRegistered(manager, "mcp__remote_ping");
		expect(manager.getConnectionStatus("remote")).toBe("connected");
	}, 30_000);

	/**
	 * R3-f. The note's last sentence tells the model to run
	 * `/mcp reconnect <server>`. A name cut at 40 columns is not a name any
	 * command accepts, and two servers whose names share that prefix render
	 * as one string, so the note cannot even say which of them it means.
	 */
	it("renders long server names whole, as the reconnect command needs them", async () => {
		const alpha = "github-enterprise-internal-tools-server-alpha";
		const beta = "github-enterprise-internal-tools-server-beta";
		expect(alpha.length).toBeGreaterThan(40);
		expect(beta.length).toBeGreaterThan(40);
		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-names-"));
		const named = new MCPManager(workDir, null, undefined, SINGLE_ATTEMPT);
		try {
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: process.execPath,
				args: ["-e", "process.exit(3)"],
				timeout: 2_000,
			};
			await named.connectServers({ [alpha]: config, [beta]: { ...config } }, {});
			await named.waitForStartup(GUARD_MS);

			const note = named.explainMissingTool(`mcp__${alpha}_ping`);
			expect(note).toContain(alpha);
			expect(note).toContain(beta);
			expect(note).not.toContain("github-enterprise-internal-tools-server…");
		} finally {
			await named.disconnectAll();
			await removeWithRetries(workDir);
		}
	}, 30_000);
});
