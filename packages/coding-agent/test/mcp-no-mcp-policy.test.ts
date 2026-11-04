/**
 * `PI_NO_MCP=1` (what `--no-mcp` exports) means no MCP server starts and no MCP
 * `!command` value runs, even when a caller names the server explicitly: a
 * `/mcp test`, an OAuth reauth probe, an ACP client's or an SDK host's
 * `connectServers`. These go through two points in-process; each must refuse.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { callBuiltinSearchMCP, callMCP } from "@oh-my-pi/pi-coding-agent/mcp/json-rpc";
import { discoverOAuthEndpoints, fetchResourceMetadataScopes } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { mcpFetch } from "@oh-my-pi/pi-coding-agent/mcp/transports/header-policy";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as mcpPolicy from "@oh-my-pi/pi-coding-agent/mcp/policy";
import { resolveMcpOAuthEndpointsFromServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import { createHttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { createSseTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/sse";
import { createStdioTransport, StdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, getMCPConfigPath, getProjectDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { allowMCPDiscoveryInTests, allowMCPInTests } from "./helpers/mcp-policy";
import { setNoMcpEnvForTest } from "./helpers/no-mcp-env";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-mcp-policy-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("PI_NO_MCP=1 and explicitly named MCP servers", () => {
	it("refuses to spawn a server handed straight to connectToServer", async () => {
		setNoMcpEnvForTest("1");
		const marker = path.join(await tempDir(), "spawned");
		await expect(
			mcpClient.connectToServer("marker", {
				type: "stdio",
				command: process.execPath,
				args: ["--eval", `await Bun.write(${JSON.stringify(marker)}, "spawned")`],
				timeout: 5_000,
			}),
		).rejects.toThrow("MCP is disabled");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("runs no `!command` config value when a config is prepared for a connect", async () => {
		setNoMcpEnvForTest("1");
		const marker = path.join(await tempDir(), "command-ran");
		await expect(
			new MCPManager(process.cwd()).prepareConfig({
				type: "stdio",
				command: "unused",
				env: { TOKEN: `!printf ran > ${marker}` },
			}),
		).rejects.toThrow("MCP is disabled");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("connects none of the servers an SDK host or ACP client supplies and reports no failure", async () => {
		setNoMcpEnvForTest("1");
		const connect = vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(new Error("must not connect"));
		const result = await new MCPManager(process.cwd()).connectServers(
			{ supplied: { type: "stdio", command: "never-started" } },
			{},
		);
		expect(connect).not.toHaveBeenCalled();
		expect(result.connectedServers).toEqual([]);
		expect([...result.errors]).toEqual([]);
	});

	it("contacts no server while resolving reauth endpoints", async () => {
		setNoMcpEnvForTest("1");
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch() {
				requests += 1;
				return new Response("unauthorized", {
					status: 401,
					headers: { "WWW-Authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource"' },
				});
			},
		});
		const authStorage = await AuthStorage.create(path.join(await tempDir(), "auth.db"));
		try {
			await expect(
				resolveMcpOAuthEndpointsFromServer(
					{ type: "http", url: `http://127.0.0.1:${server.port}/mcp` },
					{ authStorage, signal: AbortSignal.timeout(30_000) },
				),
			).rejects.toThrow("MCP is disabled");
			expect(requests).toBe(0);
		} finally {
			authStorage.close();
			server.stop(true);
		}
	});

	// Round-2 review: the exported transports started servers that
	// `connectToServer` refused.
	it("refuses to spawn a server through the exported stdio transport, class or factory", async () => {
		setNoMcpEnvForTest("1");
		const marker = path.join(await tempDir(), "spawned");
		const config = {
			type: "stdio" as const,
			command: process.execPath,
			args: ["--eval", `await Bun.write(${JSON.stringify(marker)}, "spawned")`],
		};
		await expect(new StdioTransport(config).connect()).rejects.toThrow("MCP is disabled");
		await expect(createStdioTransport(config)).rejects.toThrow("MCP is disabled");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	// Round-3 review: the exported JSON-RPC helper reached a caller-supplied server;
	// round 4: so did the helper for omp's own hosted search.
	it("contacts no caller-supplied server through callMCP or the hosted-search helper", async () => {
		setNoMcpEnvForTest("1");
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch() {
				requests += 1;
				return Response.json({ jsonrpc: "2.0", id: "x", result: {} });
			},
		});
		try {
			const url = `http://127.0.0.1:${server.port}/mcp`;
			await expect(callMCP(url, "initialize")).rejects.toThrow("MCP is disabled");
			await expect(callBuiltinSearchMCP(url, "initialize")).rejects.toThrow("hosted search endpoints");
			expect(requests).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	// Round-5 review: other exported helpers that contact an MCP server reached a
	// loopback server under PI_NO_MCP=1.
	it("contacts no server through the exported MCP HTTP and OAuth discovery helpers", async () => {
		setNoMcpEnvForTest("1");
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch() {
				requests += 1;
				return Response.json({});
			},
		});
		try {
			const url = `http://127.0.0.1:${server.port}`;
			await expect(
				mcpFetch(`${url}/mcp`, { method: "POST", body: "{}" }, { generated: {}, configured: {} }, false),
			).rejects.toThrow("MCP is disabled");
			await expect(discoverOAuthEndpoints(`${url}/mcp`)).rejects.toThrow("MCP is disabled");
			await expect(fetchResourceMetadataScopes(`${url}/.well-known/oauth-protected-resource`)).rejects.toThrow(
				"MCP is disabled",
			);
			expect(requests).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	it("keeps omp's own hosted search reachable with MCP off", async () => {
		setNoMcpEnvForTest("1");
		const reached: string[] = [];
		const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
			reached.push(String(input));
			const { id } = JSON.parse(String(init?.body)) as { id: string };
			return Response.json({ jsonrpc: "2.0", id, result: { tools: [] } });
		}) as typeof fetch;
		await callBuiltinSearchMCP("https://mcp.exa.ai/mcp?tools=web_search_exa", "tools/list", {}, { fetch: fetchStub });
		expect(reached).toEqual(["https://mcp.exa.ai/mcp?tools=web_search_exa"]);
	});

	it("contacts no server through the exported HTTP and SSE transports", async () => {
		setNoMcpEnvForTest("1");
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch() {
				requests += 1;
				return new Response("{}", { headers: { "content-type": "application/json" } });
			},
		});
		try {
			const url = `http://127.0.0.1:${server.port}/mcp`;
			await expect(createHttpTransport({ type: "http", url })).rejects.toThrow("MCP is disabled");
			await expect(createSseTransport({ type: "sse", url })).rejects.toThrow("MCP is disabled");
			expect(requests).toBe(0);
		} finally {
			server.stop(true);
		}
	});
});

// Round-2 review: the test opt-in let discovery find and start the
// developer's own server. Starting a stub a test builds stays possible;
// discovery of configured servers does not.
describe("allowMCPInTests", () => {
	allowMCPInTests();

	it("lets a test start a server it builds, but discovers none of the configured ones", async () => {
		setNoMcpEnvForTest("1");
		const dir = await tempDir();
		const configured = path.join(dir, "configured-started");
		const explicit = path.join(dir, "explicit-started");
		const markerServer = (marker: string) => ({
			type: "stdio" as const,
			command: process.execPath,
			args: ["--eval", `await Bun.write(${JSON.stringify(marker)}, "started")`],
			timeout: 5_000,
		});
		const originalAgentDir = getAgentDir();
		setAgentDir(path.join(dir, "agent"));
		try {
			await Bun.write(
				getMCPConfigPath("user", dir),
				JSON.stringify({ mcpServers: { configured: markerServer(configured) } }),
			);
			const manager = new MCPManager(dir);
			const result = await manager.discoverAndConnect();
			expect(result.connectedServers).toEqual([]);
			expect(await Bun.file(configured).exists()).toBe(false);

			// The explicit stub starts (and exits without answering).
			await mcpClient.connectToServer("explicit", markerServer(explicit)).catch(() => {});
			expect(await Bun.file(explicit).exists()).toBe(true);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});
});

describe("allowMCPDiscoveryInTests", () => {
	allowMCPDiscoveryInTests();

	// Round-3 review: a discovery call given a project directory outside the
	// temp dir found that project's server and ran its `!command`.
	// Round-4 review: an extension root (relative here; invocation-scoped or from
	// settings alike) outside the temp dir let discovery find a server there.
	it("fails a test whose discovery finds a server outside the temp dir, however it was found", async () => {
		const outside = path.join(import.meta.dir, "fixtures", "mcp-outside-temp-extension");
		const manager = new MCPManager(getProjectDir());
		await expect(
			manager.discoverAndConnect({
				startupTimeoutMs: 0,
				extensionRoots: {
					explicit: [path.relative(getProjectDir(), outside)],
					mode: "explicit-only",
					configuredLevel: "user",
					configured: [],
				},
			}),
		).rejects.toThrow("MCP discovery found");
	});

	it("fails a discovery call given a directory outside the temp dir", async () => {
		const outside = path.join(path.parse(os.tmpdir()).root, "not-a-temp-root", "project");
		await expect(new MCPManager(outside).discoverAndConnect()).rejects.toThrow("allowMCPDiscoveryInTests");
	});

	it("fails a test whose configuration roots are outside the temp dir", () => {
		const previous = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = path.join(path.parse(os.tmpdir()).root, "not-a-temp-root", ".claude");
		try {
			expect(() => mcpPolicy.isMCPDisabled()).toThrow("allowMCPDiscoveryInTests");
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previous;
		}
	});
});
