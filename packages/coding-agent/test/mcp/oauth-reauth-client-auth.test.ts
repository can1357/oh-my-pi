/**
 * Contracts for the post-reauth reconnect path. `/mcp reauth` writes a fresh
 * url-keyed credential row, and the host's next auth resolution must be able
 * to pick it up: while a client-supplied `Authorization` header is present,
 * `lookupMcpOAuthCredential` disables the url-keyed fallback, and a stale
 * `auth` block answers first. The host reconnect hooks therefore clear that
 * surface (`clearMcpClientAuthSurface`) and install the cleaned definition
 * (`MCPManager.updateServerConfig`) before reconnecting.
 *
 * `reconnectMcpManagerServer` owns the host-side sequencing: it installs the
 * cleared definition, awaits a pending automatic reconnect (which captured the
 * old definition and aborts on the identity check) before starting a fresh
 * manual attempt, and refuses to touch a manager entry that is not the
 * reauthorized definition (an ACP name collision must not reconnect the
 * unrelated live server).
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { clearMcpClientAuthSurface, reconnectMcpManagerServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { MCPAuthConfig, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const staleAuth: MCPAuthConfig = {
	type: "oauth",
	credentialId: "mcp_oauth:profile:old",
	tokenUrl: "https://auth.example.com/token",
};

function asHttpServerConfig(
	config: MCPServerConfig,
): MCPServerConfig & { url: string; headers?: Record<string, string> } {
	if (config.type !== "http" && config.type !== "sse") {
		throw new Error(`expected an http/sse config, got ${config.type ?? "stdio"}`);
	}
	return config;
}

describe("clearMcpClientAuthSurface", () => {
	test("strips every Authorization header spelling and the auth block, keeping the rest", () => {
		const config: MCPServerConfig = {
			type: "http",
			url: "https://mcp.example.com/mcp",
			headers: {
				Authorization: "Bearer stale-token",
				authorization: "Bearer also-stale",
				"X-Custom": "keep",
			},
			auth: staleAuth,
		};
		const cleaned = asHttpServerConfig(clearMcpClientAuthSurface(config));
		// Every casing of the bearer header is gone; unrelated headers survive.
		expect(Object.keys(cleaned.headers ?? {})).toEqual(["X-Custom"]);
		expect(cleaned.auth).toBeUndefined();
		expect(cleaned.url).toBe("https://mcp.example.com/mcp");
		// The input definition is not mutated in place.
		const original = asHttpServerConfig(config);
		expect(original.auth).toBe(staleAuth);
		expect(Object.keys(original.headers ?? {})).toContain("Authorization");
	});

	test("drops the auth block from stdio definitions without touching the rest", () => {
		const config: MCPServerConfig = {
			type: "stdio",
			command: "some-server",
			args: ["--stdio"],
			auth: staleAuth,
		};
		const cleaned = clearMcpClientAuthSurface(config);
		if (cleaned.type !== "stdio") throw new Error(`expected a stdio config, got ${cleaned.type}`);
		expect(cleaned.auth).toBeUndefined();
		expect(cleaned.command).toBe("some-server");
		expect(cleaned.args).toEqual(["--stdio"]);
	});
});

/** Minimal fake of the manager surface {@link reconnectMcpManagerServer} uses. */
class FakeReconnectManager {
	readonly configs = new Map<string, MCPServerConfig>();
	readonly updated: Array<{ name: string; config: MCPServerConfig }> = [];
	readonly reconnected: Array<{ name: string; manual?: boolean }> = [];
	readonly order: string[] = [];
	pending: Promise<unknown> | undefined;
	status: "connected" | "connecting" | "disconnected" = "connected";

	getServerConfig(name: string): MCPServerConfig | undefined {
		return this.configs.get(name);
	}
	updateServerConfig(name: string, config: MCPServerConfig): Promise<unknown> | undefined {
		this.updated.push({ name, config });
		this.configs.set(name, config);
		this.order.push("update");
		return this.pending;
	}
	async reconnectServer(name: string, options?: { manual?: boolean }): Promise<null> {
		this.reconnected.push({ name, manual: options?.manual });
		this.order.push("reconnect");
		return null;
	}
	getConnectionStatus(_name: string): "connected" | "connecting" | "disconnected" {
		return this.status;
	}
}

describe("reconnectMcpManagerServer", () => {
	test("awaits the superseded reconnect, then starts a fresh manual attempt and reports status", async () => {
		const manager = new FakeReconnectManager();
		// The manager entry carries the client's auth surface — the definition
		// a reauth of this server refreshes.
		manager.configs.set("client-server", {
			type: "http",
			url: "https://acp.example.com/mcp",
			headers: { Authorization: "Bearer client-token" },
			auth: staleAuth,
		});
		const release = Promise.withResolvers<void>();
		manager.pending = release.promise.then(() => {
			manager.order.push("pending-settled");
		});
		const selected: MCPServerConfig = { type: "http", url: "https://acp.example.com/mcp" };

		const call = reconnectMcpManagerServer(manager as unknown as MCPManager, "client-server", selected);
		// The old automatic attempt is still settling: no reconnect started yet.
		expect(manager.reconnected).toEqual([]);
		release.resolve();
		expect(await call).toBe("connected");
		// The pending attempt settled before the manual one started.
		expect(manager.order).toEqual(["update", "pending-settled", "reconnect"]);
		expect(manager.reconnected).toEqual([{ name: "client-server", manual: true }]);
		// The installed definition has the client auth surface cleared.
		const installed = manager.updated[0]!.config;
		expect(asHttpServerConfig(installed).url).toBe("https://acp.example.com/mcp");
		expect(Object.keys(asHttpServerConfig(installed).headers ?? {})).toEqual([]);
		expect(installed.auth).toBeUndefined();
	});

	test("refuses a manager entry that is not the reauthorized definition", async () => {
		const manager = new FakeReconnectManager();
		// ACP client declares `foo` at URL B while the reauthorized config-file
		// `foo` lives at URL A: reconnecting the manager entry would strip the
		// client bearer and reconnect an unrelated server.
		manager.configs.set("foo", {
			type: "http",
			url: "https://b.example.com/mcp",
			headers: { Authorization: "Bearer client-token" },
		});
		const selected: MCPServerConfig = { type: "http", url: "https://a.example.com/mcp" };

		expect(await reconnectMcpManagerServer(manager as unknown as MCPManager, "foo", selected)).toBeUndefined();
		expect(manager.updated).toEqual([]);
		expect(manager.reconnected).toEqual([]);
	});

	test("treats an env-expanded URL as the same server, and no manager as nothing to reconnect", async () => {
		const manager = new FakeReconnectManager();
		manager.configs.set("env-server", { type: "http", url: "https://mcp.example.com/mcp" });
		// eslint-disable-next-line no-template-curly-in-string -- raw `${...}` placeholder: the contract under test is that it does NOT interpolate here.
		const selected: MCPServerConfig = { type: "http", url: "https://${MCP_HOST}/mcp" };
		// Restore rather than delete: a caller-supplied MCP_HOST must survive
		// this test, or later files observe a different environment and the
		// full suite becomes order-dependent.
		const originalBunHost = Bun.env.MCP_HOST;
		const originalProcessHost = process.env.MCP_HOST;
		Bun.env.MCP_HOST = "mcp.example.com";
		process.env.MCP_HOST = "mcp.example.com";
		try {
			expect(await reconnectMcpManagerServer(manager as unknown as MCPManager, "env-server", selected)).toBe(
				"connected",
			);
		} finally {
			if (originalBunHost === undefined) delete Bun.env.MCP_HOST;
			else Bun.env.MCP_HOST = originalBunHost;
			if (originalProcessHost === undefined) delete process.env.MCP_HOST;
			else process.env.MCP_HOST = originalProcessHost;
		}
		// No manager at all (RPC/print hosts without one): nothing to do.
		expect(await reconnectMcpManagerServer(undefined, "env-server", selected)).toBeUndefined();
	});
});

describe("MCPManager.updateServerConfig", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns the in-flight reconnection so a fresh attempt can supersede it", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-manager-update-"));
		// Drive a real reconnect: the connect hangs until released, then fails;
		// the attempt aborts on the identity check once the definition is
		// replaced (no retry ladder is walked on that path).
		const connectCalls: Array<{ name: string; url: string | undefined }> = [];
		const blocker = Promise.withResolvers<never>();
		const reachedConnect = Promise.withResolvers<void>();
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(((name: string, config: MCPServerConfig) => {
			connectCalls.push({ name, url: config.type === "http" || config.type === "sse" ? config.url : undefined });
			reachedConnect.resolve();
			return blocker.promise;
		}) as never);
		try {
			const manager = new MCPManager(cwd);
			const oldConfig: MCPServerConfig = {
				type: "http",
				url: "https://mcp.example.com/mcp",
				headers: { Authorization: "Bearer old-token" },
				auth: staleAuth,
			};
			const newConfig = clearMcpClientAuthSurface(oldConfig);
			expect(manager.updateServerConfig("envserver", oldConfig)).toBeUndefined();
			const inFlight = manager.reconnectServer("envserver");
			// The automatic attempt captured the old definition; the async
			// reconnect chain signals when it reaches connectToServer.
			await reachedConnect.promise;
			expect(connectCalls).toEqual([{ name: "envserver", url: "https://mcp.example.com/mcp" }]);
			// …so replacing it hands the caller the dying promise to await.
			const pending = manager.updateServerConfig("envserver", newConfig);
			expect(pending).toBeInstanceOf(Promise);

			blocker.reject(new Error("connect failed"));
			expect(await pending).toBeNull();
			expect(await inFlight).toBeNull();
			// The stored definition is the fresh one the next auth resolution reads.
			expect(manager.getServerConfig("envserver")).toBe(newConfig);
			expect(Object.keys(asHttpServerConfig(newConfig).headers ?? {})).toEqual([]);
		} finally {
			await removeWithRetries(cwd);
		}
	});
});
