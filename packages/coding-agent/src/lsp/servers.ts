import { logger } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tools/tool-errors";
import {
	getActiveClients,
	getActiveOrPendingClient,
	getOrCreateClient,
	isRustAnalyzerClient,
	type LspServerStatus,
	notifySaved,
	sendNotification,
	sendRequest,
	setIdleTimeout,
	shutdownClientInstance,
	syncContent,
	WARMUP_TIMEOUT_MS,
} from "./client";
import { getServersForFile, type LspConfig, loadConfig } from "./config";
import { MUX_RESTART_METHOD } from "./mux/protocol";
import type { LspClient, ServerConfig } from "./types";

/**
 * LSP actions that do not mutate the workspace or language-server state.
 * Anything not in this set (rename, code_actions with apply, rename_file,
 * reload, raw request, etc.) is classified as write-tier.
 */
export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

export interface LspStartupServerInfo {
	name: string;
	status: "connecting" | "ready" | "error" | "available";
	fileTypes: string[];
	error?: string;
}

/** Result from warming up LSP servers */
export interface LspWarmupResult {
	servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
}

/** Options for warming up LSP servers */
export interface LspWarmupOptions {
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
}

export function discoverStartupLspServers(
	cwd: string,
	status: LspStartupServerInfo["status"] = "connecting",
): LspStartupServerInfo[] {
	const config = loadConfig(cwd);
	return getLspServers(config).map(([name, serverConfig]) => ({
		name,
		status,
		fileTypes: serverConfig.fileTypes,
	}));
}

/**
 * Warm up LSP servers for a directory by connecting to all detected servers.
 * This should be called at startup to avoid cold-start delays.
 *
 * @param cwd - Working directory to detect and start servers for
 * @param options - Optional callbacks for progress reporting
 * @returns Status of each server that was started
 */
export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const servers: LspWarmupResult["servers"] = [];
	const lspServers = getLspServers(config);

	// Notify caller which servers we're connecting to
	if (lspServers.length > 0 && options?.onConnecting) {
		options.onConnecting(lspServers.map(([name]) => name));
	}

	// Start all detected servers in parallel with a short timeout
	// Servers that don't respond quickly will be initialized lazily on first use
	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const [name, serverConfig] = lspServers[i];
		if (result.status === "fulfilled") {
			servers.push({
				name: result.value.name,
				status: "ready",
				fileTypes: result.value.fileTypes,
			});
		} else {
			const errorMsg = result.reason?.message ?? String(result.reason);
			logger.warn("LSP server failed to start", { server: name, error: errorMsg });
			servers.push({
				name,
				status: "error",
				fileTypes: serverConfig.fileTypes,
				error: errorMsg,
			});
		}
	}

	return { servers };
}

/**
 * Get status of currently active LSP servers.
 */
export function getLspStatus(): LspServerStatus[] {
	return getActiveClients();
}

/**
 * Sync in-memory file content to all applicable LSP servers.
 * Sends didOpen (if new) or didChange (if already open).
 *
 * @param absolutePath - Absolute path to the file
 * @param content - The new file content
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to sync to
 */
export async function syncFileContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
	createMissing = true,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = createMissing
				? await getOrCreateClient(serverConfig, cwd, undefined, signal)
				: await getActiveOrPendingClient(serverConfig, cwd, signal);
			if (!client) return;
			throwIfAborted(signal);
			await syncContent(client, absolutePath, content, signal);
		}),
	);
	throwIfAborted(signal);
}

/**
 * Notify all LSP servers that a file was saved.
 * Assumes content was already synced via syncFileContent.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to notify
 */
export async function notifyFileSaved(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
	createMissing = true,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = createMissing
				? await getOrCreateClient(serverConfig, cwd, undefined, signal)
				: await getActiveOrPendingClient(serverConfig, cwd, signal);
			if (!client) return;
			await notifySaved(client, absolutePath, signal);
		}),
	);
	throwIfAborted(signal);
}

// Cache config per cwd to avoid repeated file I/O
export const configCache = new Map<string, LspConfig>();

export function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		configCache.set(cwd, config);
	}
	setIdleTimeout(config.idleTimeoutMs);
	return config;
}

function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}

export function splitServers(servers: Array<[string, ServerConfig]>): {
	lspServers: Array<[string, ServerConfig]>;
	customLinterServers: Array<[string, ServerConfig]>;
} {
	const lspServers: Array<[string, ServerConfig]> = [];
	const customLinterServers: Array<[string, ServerConfig]> = [];
	for (const entry of servers) {
		if (isCustomLinter(entry[1])) {
			customLinterServers.push(entry);
		} else {
			lspServers.push(entry);
		}
	}
	return { lspServers, customLinterServers };
}

export function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
		([, serverConfig]) => !isCustomLinter(serverConfig),
	);
}

export function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	return getServersForFile(config, filePath).filter(([, serverConfig]) => !isCustomLinter(serverConfig));
}

export function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getLspServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

export function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.createClient && !serverConfig.isLinter;
}

/** True when an LSP error indicates the server doesn't implement the requested method. */
export function isMethodNotFoundError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("method not found") ||
		msg.includes("unhandled method") ||
		msg.includes("not supported") ||
		msg.includes("-32601")
	);
}

/**
 * Build the params for the generic `workspace/didChangeConfiguration` reload.
 *
 * The handshake in `client.ts` pushes `{ settings: config.settings ?? {} }` right
 * after `initialized`, so a reload has to echo those same settings back. A bare
 * `{}` is well-formed LSP, but it means "the configuration is now empty" — the
 * opposite of a refresh. Servers that key behaviour off their configuration
 * (formatter options, analysis toggles, per-workspace overrides) silently drop it
 * and serve the rest of the session on defaults, so `lsp reload` ends up erasing
 * the configured settings instead of re-applying them (issue #8383).
 */
export function reloadConfigurationParams(config: ServerConfig): { settings: Record<string, unknown> } {
	return { settings: config.settings ?? {} };
}

export async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	// rust-analyzer exposes a real reload request. Only rust-analyzer implements
	// it, so gate the request on the binary (or registered name) rather than
	// probing every server: some servers (Roslyn) crash the whole process on an
	// unknown method instead of replying with method-not-found — killing the
	// server `lsp reload` was meant to refresh (issue #8571, dotnet/roslyn#84890).
	// A caller cancel or tool timeout must propagate, never be mistaken for an
	// unsupported method and swallowed into a bogus "Restarted" (issue #6369).
	if (isRustAnalyzerClient(client) || serverName === "rust-analyzer") {
		try {
			await sendRequest(client, "rust-analyzer/reloadWorkspace", undefined, signal);
			return `Reloaded ${serverName}`;
		} catch (err) {
			throwIfAborted(signal);
			if (!isMethodNotFoundError(err)) throw err;
			// Method not supported — fall through to the generic reload.
		}
	}
	// workspace/didChangeConfiguration is a notification per spec; sending it
	// as a request hangs until the tool deadline on servers that route it to
	// the notification handler and never respond.
	try {
		const params = reloadConfigurationParams(client.config);
		await sendNotification(client, "workspace/didChangeConfiguration", params, signal);
		return `Reloaded ${serverName}`;
	} catch {
		throwIfAborted(signal);
		// The reload notification could not be delivered — the connection is
		// wedged or the process already died. Tear the client down (removing it
		// from the registry by identity and awaiting confirmed process exit) so
		// the next request cold-starts a fresh client. A kill that never confirms
		// exit is not a restart: surface the teardown failure truthfully.
		//
		// On a broker-shared link a per-session teardown only detaches this
		// process while the wedged server keeps serving everyone else — ask the
		// mux to kill the shared server first (best-effort; it also severs us).
		if (client.proc.sharedMux) {
			await sendNotification(client, MUX_RESTART_METHOD, undefined, AbortSignal.timeout(2_000)).catch(() => {});
		}
		if (!(await shutdownClientInstance(client))) {
			throw new Error(`Failed to restart ${serverName}: server process did not exit after kill`);
		}
		return `Restarted ${serverName}`;
	}
}
