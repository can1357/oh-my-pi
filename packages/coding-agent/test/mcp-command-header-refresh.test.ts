/**
 * `!command` header values on remote MCP servers mint short-lived bearer tokens
 * (e.g. an OAuth2 `client_credentials` grant). The command result is
 * process-cached, so without invalidation a server dies at the first token
 * expiry and stays 401 until restart — `/mcp reconnect` and `/mcp reload`
 * re-sent the first result (issue #18631).
 *
 * Contracts: after the server rotates its token, a tool call recovers by
 * re-running the command on 401, and a manual reconnect or a reload
 * (`disconnectAll` + connect) sends the newly minted value.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager, type MCPReconnectPolicy } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPHttpServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { type FlakyHttpMcpServer, startFlakyHttpMcpServer } from "./fixtures/flaky-http-mcp";

const GUARD_MS = 5_000;
/** One quick retry per reconnect, no background schedule within a test. */
const FAST: MCPReconnectPolicy = { ladderMs: [10], retryBaseMs: 60_000, retryMaxMs: 60_000 };
const noop = () => {};
const noCtx = {} as Parameters<MCPTool["execute"]>[3];

describe("MCP command-backed headers", () => {
	let workDir: string;
	let manager: MCPManager | undefined;
	let server: FlakyHttpMcpServer | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		server?.stop();
		manager = undefined;
		server = undefined;
		if (workDir) removeSyncWithRetries(workDir);
	});

	/** Connect a server whose `Authorization` header is minted by `!cat <token file>`. */
	async function connected() {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-command-header-"));
		const tokenFile = path.join(workDir, "token");
		let token = "Bearer token-1";
		fs.writeFileSync(tokenFile, token);
		const rotate = (next: string) => {
			token = next;
			fs.writeFileSync(tokenFile, next);
		};
		server = startFlakyHttpMcpServer({ authorization: () => token });
		manager = new MCPManager(workDir, null, undefined, FAST);
		const config: MCPHttpServerConfig = {
			type: "http",
			url: server.url,
			timeout: GUARD_MS,
			headers: { Authorization: `!cat '${tokenFile}'` },
		};
		await manager.connectServers({ minted: config }, {});
		expect((await manager.waitForStartup(0)).connected).toEqual(["minted"]);
		return { manager, server, config, rotate };
	}

	function ping(manager: MCPManager) {
		const tool = manager.getTools().find(tool => tool.mcpServerName === "minted");
		if (!tool) throw new Error("ping tool not registered");
		return tool;
	}

	it("re-runs the command and retries in place when a call gets 401 after the token rotates", async () => {
		const { manager, server, rotate } = await connected();
		const initializes = server.initializes;
		rotate("Bearer token-2");

		const result = await ping(manager).execute("call-1", {}, noop, noCtx);
		expect(result.isError).toBeFalsy();
		// Recovered by the transport's auth retry, not a full reconnect.
		expect(server.initializes).toBe(initializes);
	});

	it("sends a freshly minted value on a manual reconnect", async () => {
		const { manager, rotate } = await connected();
		rotate("Bearer token-2");

		expect(await manager.reconnectServer("minted", { manual: true })).not.toBeNull();
		expect(manager.getConnectionStatus("minted")).toBe("connected");
	});

	it("sends a freshly minted value after a reload", async () => {
		const { manager, config, rotate } = await connected();
		rotate("Bearer token-2");

		await manager.disconnectAll();
		await manager.connectServers({ minted: config }, {});
		expect((await manager.waitForStartup(0)).connected).toEqual(["minted"]);
	});
});
