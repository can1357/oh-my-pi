import * as path from "node:path";
import { discoverAndLoadMCPTools, type MCPToolsLoadOptions, type MCPToolsLoadResult } from "./loader";
import type { MCPManager } from "./manager";

export type MCPToolsLoader = (cwd: string, options?: MCPToolsLoadOptions) => Promise<MCPToolsLoadResult>;

function poolKey(cwd: string, options?: MCPToolsLoadOptions): string {
	return JSON.stringify([
		path.resolve(cwd),
		options?.enableProjectConfig ?? true,
		options?.filterExa ?? true,
		options?.filterBrowser ?? false,
	]);
}

/**
 * Shard-owned MCP transport pool. Equivalent sessions reuse one manager and
 * therefore one subprocess/HTTP connection set while keeping their own tool
 * registries, approval state, and event queues.
 */
export class MCPManagerPool {
	readonly #load: MCPToolsLoader;
	readonly #entries = new Map<string, Promise<MCPToolsLoadResult>>();
	#disposePromise: Promise<void> | undefined;

	constructor(load: MCPToolsLoader = discoverAndLoadMCPTools) {
		this.#load = load;
	}

	acquire(cwd: string, options?: MCPToolsLoadOptions): Promise<MCPToolsLoadResult> {
		if (this.#disposePromise) throw new Error("MCP manager pool is disposed");
		const key = poolKey(cwd, options);
		const existing = this.#entries.get(key);
		if (existing) return existing;
		const loaded = this.#load(cwd, options).catch(error => {
			this.#entries.delete(key);
			throw error;
		});
		this.#entries.set(key, loaded);
		return loaded;
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposePromise = (async () => {
			const settled = await Promise.allSettled(this.#entries.values());
			const managers = new Set<MCPManager>();
			for (const result of settled) {
				if (result.status === "fulfilled") managers.add(result.value.manager);
			}
			await Promise.allSettled(Array.from(managers, manager => manager.disconnectAll()));
			this.#entries.clear();
		})();
		return this.#disposePromise;
	}
}
