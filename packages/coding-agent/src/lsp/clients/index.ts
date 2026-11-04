import { findLinterRoot, resolveLinterCommand } from "../../lsp/config";
import type { LinterClient, ServerConfig } from "../../lsp/types";
import { LspLinterClient } from "./lsp-linter-client";

/**
 * Linter client implementations.
 *
 * The LinterClient interface provides a common API for formatters and linters.
 * Different implementations can use LSP protocol, CLI tools, or other mechanisms.
 */

export { BiomeClient } from "./biome-client";
export { LspLinterClient } from "./lsp-linter-client";
export { SwiftLintClient } from "./swiftlint-client";

// Cache of linter clients by server name + linter root + executable
const clientCache = new Map<string, LinterClient>();

/**
 * Get or create the linter client that serves `filePath`.
 *
 * The client is bound to the file's own project root (`findLinterRoot`: the
 * nearest ancestor of the file's physical location holding one of the server's
 * root markers) and to the executable `resolveLinterCommand` picks for that
 * root: the session configuration's own for the session cwd, the root's own
 * for any other root. Returns null when the file has no such root or the root
 * has no executable: the linter does not apply to the file.
 * A server without root markers keeps `cwd` and its configured executable.
 */
export function getLinterClient(
	serverName: string,
	config: ServerConfig,
	filePath: string,
	cwd: string,
): LinterClient | null {
	let root = cwd;
	let bound = config;
	if (config.rootMarkers.length > 0) {
		const fileRoot = findLinterRoot(filePath, config.rootMarkers);
		if (fileRoot === null) return null;
		const command = resolveLinterCommand(config, fileRoot, cwd);
		if (command === null) return null;
		root = fileRoot;
		if (command !== config.resolvedCommand) bound = { ...config, resolvedCommand: command };
	}

	const key = JSON.stringify([serverName, root, bound.resolvedCommand ?? bound.command]);
	let client = clientCache.get(key);
	if (client) {
		return client;
	}

	// Use custom factory if provided
	client = bound.createClient ? bound.createClient(bound, root) : LspLinterClient.create(bound, root);

	clientCache.set(key, client);
	return client;
}

/**
 * Clear all cached linter clients.
 */
export function clearLinterClientCache(): void {
	for (const client of clientCache.values()) {
		client.dispose?.();
	}
	clientCache.clear();
}
