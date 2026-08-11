import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/manager";
import { MCPToolCache } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/tool-cache";
import type { MCPServerConfig } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-storage";
import { removeSyncWithRetries } from "@pk-nerdsaver-ai/pi-utils";

class MemoryCacheStorage {
	readonly values = new Map<string, string>();

	getCache(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setCache(key: string, value: string): void {
		this.values.set(key, value);
	}
}

class FailingCacheStorage extends MemoryCacheStorage {
	override setCache(): void {
		throw new Error("cache database is read-only");
	}
}

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "cache-policy-mcp.ts");
const BUN_EXEC = process.execPath;

function config(scope: "public" | "private", ttlMs: number): MCPServerConfig {
	return {
		type: "stdio",
		command: BUN_EXEC,
		args: [FIXTURE_PATH, "--scope", scope, "--ttl", String(ttlMs)],
	};
}

describe("MCPManager tool cache refresh policy", () => {
	let workDir: string;
	let manager: MCPManager | undefined;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-cache-manager-"));
	});

	afterEach(async () => {
		await manager?.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("persists and replaces only public fresh tool lists", async () => {
		const storage = new MemoryCacheStorage();
		const cache = new MCPToolCache(storage as unknown as AgentStorage);
		manager = new MCPManager(workDir, cache);
		const publicConfig = config("public", 60_000);
		const privateConfig = config("private", 60_000);
		const zeroConfig = config("public", 0);

		const connectedNames = new Set<string>();
		let resolveConnected: (() => void) | undefined;
		const allConnected = new Promise<void>(resolve => {
			resolveConnected = resolve;
		});
		await manager.connectServers({ public: publicConfig, private: privateConfig, zero: zeroConfig }, {}, event => {
			if (event.type !== "connected") return;
			connectedNames.add(event.serverName);
			if (connectedNames.size === 3) resolveConnected?.();
		});
		await allConnected;

		expect((await cache.get("public", publicConfig))?.[0]?.name).toBe("cached_tool_initial");
		expect(await cache.get("private", privateConfig)).toBeNull();
		expect(await cache.get("zero", zeroConfig)).toBeNull();
		expect(manager.getConnection("private")?.resultHints?.tools).toMatchObject({
			era: "modern",
			cacheScope: "private",
		});
		expect(manager.getConnection("zero")?.tools).toBeUndefined();

		await manager.refreshServerTools("public");
		expect((await cache.get("public", publicConfig))?.[0]?.name).toBe("cached_tool_refreshed");
	}, 20_000);

	it("keeps a healthy server connected when cache persistence fails", async () => {
		const cache = new MCPToolCache(new FailingCacheStorage() as unknown as AgentStorage);
		manager = new MCPManager(workDir, cache);
		const connected = Promise.withResolvers<void>();
		const statuses: string[] = [];

		await manager.connectServers({ public: config("public", 60_000) }, {}, event => {
			statuses.push(event.type);
			if (event.type === "connected") connected.resolve();
		});
		await connected.promise;

		expect(manager.getConnection("public")).toBeDefined();
		expect(manager.getTools()).toHaveLength(1);
		expect(statuses).toContain("connected");
		expect(statuses).not.toContain("failed");
	}, 20_000);
});
