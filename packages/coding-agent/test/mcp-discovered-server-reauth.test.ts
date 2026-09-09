/**
 * Regression coverage for `/mcp reauth` (and `/mcp test|unauth`) on a server
 * that `/mcp list` shows but that lives in no writable OMP config — e.g. a
 * server installed from a Claude Code marketplace plugin, registered under a
 * namespaced name like `cloudflare:cloudflare-api`.
 *
 * Two contracts together make that flow work, and each was independently
 * broken:
 *
 *  1. The manager must surface a *discovered* server's config even when the
 *     server never connected (an OAuth server that has not been authorized yet
 *     is exactly the "not connected" case the user is trying to fix). The
 *     command controller's auth fallback reads `getServerConfig`/`getSource`.
 *
 *  2. The config writer must accept the colon-namespaced name so `/mcp reauth`
 *     can persist the resolved config + OAuth `auth` block into the user config
 *     as an override (the native provider then shadows the plugin entry).
 *     `validateServerName` previously rejected the colon, so the persist threw.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../src/capability/types";
import { readMCPConfigFile, updateMCPServer, validateServerName } from "../src/mcp/config-writer";
import { MCPManager } from "../src/mcp/manager";
import type { MCPHttpServerConfig, MCPStdioServerConfig } from "../src/mcp/types";

const NAMESPACED_NAME = "cloudflare:cloudflare-api";
const BUN_EXEC = process.execPath;

describe("MCP discovered-server reauth", () => {
	describe("manager surfaces discovered configs for unconnected servers", () => {
		it("exposes config + source for a discovered server that failed to connect", async () => {
			const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-discovered-"));
			const manager = new MCPManager(workDir);

			// Exits before speaking MCP, so the connect attempt fails and the
			// server stays "not connected" — mirroring an OAuth server that needs
			// authorization. `connectServers` records config/source up front, so
			// the failure must not erase them.
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: BUN_EXEC,
				args: ["-e", "process.exit(0)"],
			};
			const source: SourceMeta = {
				provider: "claude-plugins",
				providerName: "Claude Code Marketplace",
				path: path.join(workDir, ".mcp.json"),
				level: "user",
			};

			try {
				const result = await manager.connectServers({ [NAMESPACED_NAME]: config }, { [NAMESPACED_NAME]: source });

				// Precondition: the server is discovered but not connected.
				expect(result.connectedServers).not.toContain(NAMESPACED_NAME);
				expect(manager.getConnectionStatus(NAMESPACED_NAME)).not.toBe("connected");

				// Contract: its config + source remain recoverable for reauth.
				expect(manager.getServerConfig(NAMESPACED_NAME)).toEqual(config);
				expect(manager.getSource(NAMESPACED_NAME)).toEqual(source);
			} finally {
				await manager.disconnectAll();
				removeSyncWithRetries(workDir);
			}
		}, 15_000);

		it("returns undefined for an unknown server", () => {
			const manager = new MCPManager(process.cwd());
			expect(manager.getServerConfig("never-registered")).toBeUndefined();
		});
	});

	describe("config writer persists namespaced plugin server names", () => {
		it("validateServerName accepts a colon-namespaced name", () => {
			expect(validateServerName(NAMESPACED_NAME)).toBeUndefined();
			// Sanity: genuinely invalid characters are still rejected.
			expect(validateServerName("has space")).toBeDefined();
		});

		it("updateMCPServer round-trips a namespaced HTTP server with an oauth auth block", async () => {
			const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-persist-"));
			const filePath = path.join(workDir, "mcp.json");

			// Exactly the shape `/mcp reauth` writes: the discovered config plus
			// the resolved OAuth credential reference.
			const persisted: MCPHttpServerConfig = {
				type: "http",
				url: "https://api.cloudflare.com/mcp",
				auth: {
					type: "oauth",
					credentialId: "mcp_oauth_test",
					tokenUrl: "https://auth.cloudflare.com/token",
				},
			};

			try {
				await updateMCPServer(filePath, NAMESPACED_NAME, persisted);
				const readBack = await readMCPConfigFile(filePath);
				expect(readBack.mcpServers?.[NAMESPACED_NAME]).toEqual(persisted);
			} finally {
				removeSyncWithRetries(workDir);
			}
		});
	});
});
