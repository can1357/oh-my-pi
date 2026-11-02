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
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { resolveMcpOAuthEndpointsFromServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
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
});
