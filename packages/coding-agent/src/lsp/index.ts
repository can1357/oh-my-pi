import * as fs from "node:fs";
import path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@pk-nerdsaver-ai/pi-agent-core";
import { logger, once, prompt, untilAborted } from "@pk-nerdsaver-ai/pi-utils";
import type { BunFile } from "bun";
import { type Theme, theme } from "../modes/theme/theme";
import lspDescription from "../prompts/tools/lsp.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { truncateForPrompt } from "../tools/approval";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";
import { clampTimeout } from "../tools/tool-timeouts";
import {
	ensureFileOpen,
	getActiveClients,
	getOrCreateClient,
	type LspServerStatus,
	notifySaved,
	refreshFile,
	sendNotification,
	sendRequest,
	setIdleTimeout,
	syncContent,
	WARMUP_TIMEOUT_MS,
	waitForProjectLoaded,
} from "./client";
import { getLinterClient } from "./clients";
import { getServersForFile, type LspConfig, loadConfig } from "./config";
import {
	applyTextEdits,
	applyTextEditsToString,
	applyWorkspaceEdit,
	flattenWorkspaceTextEdits,
	rangesOverlap,
} from "./edits";
import { resolveFormatOptions } from "./format-options";
import { detectLspmux } from "./lspmux";
import {
	type CodeAction,
	type CodeActionContext,
	type Command,
	type Diagnostic,
	type DocumentSymbol,
	type Hover,
	type Location,
	type LocationLink,
	type LspClient,
	type LspParams,
	type LspToolDetails,
	lspSchema,
	type Position,
	type PublishedDiagnostics,
	type ServerConfig,
	type SymbolInformation,
	type TextEdit,
	type WorkspaceEdit,
} from "./types";
import {
	applyCodeAction,
	dedupeWorkspaceSymbols,
	extractHoverText,
	fileToUri,
	filterWorkspaceSymbols,
	formatCodeAction,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatDocumentSymbol,
	formatGroupedDiagnosticMessages,
	formatLocation,
	formatSymbolInformation,
	formatWorkspaceEdit,
	readLocationContext,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
	sortDiagnostics,
	summarizeDiagnosticMessages,
	symbolKindToIcon,
	uriToFile,
} from "./utils";

export type { LspServerStatus } from "./client";
export type { LspToolDetails } from "./types";

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
async function syncFileContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd);
			throwIfAborted(signal);
			await syncContent(client, absolutePath, content, signal);
		}),
	);
}

/**
 * Notify all LSP servers that a file was saved.
 * Assumes content was already synced via syncFileContent.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to notify
 */
async function notifyFileSaved(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd);
			await notifySaved(client, absolutePath, signal);
		}),
	);
}

// Cache config per cwd to avoid repeated file I/O
const configCache = new Map<string, LspConfig>();

function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		setIdleTimeout(config.idleTimeoutMs);
		configCache.set(cwd, config);
	}
	return config;
}

function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}

function splitServers(servers: Array<[string, ServerConfig]>): {
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

function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
		([, serverConfig]) => !isCustomLinter(serverConfig),
	);
}

function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	return getServersForFile(config, filePath).filter(([, serverConfig]) => !isCustomLinter(serverConfig));
}

function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getLspServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.createClient && !serverConfig.isLinter;
}

const DIAGNOSTIC_MESSAGE_LIMIT = 50;
const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
const DIAGNOSTICS_POLL_MS = 100;
const DIAGNOSTICS_SETTLE_MS = 250;
/**
 * How long the edit/write writethrough blocks inline waiting for fresh
 * diagnostics before handing slow servers off to the deferred late-injection
 * channel. Keeps the common fast-server case inline while letting an edit
 * return promptly when a server (e.g. a large-monorepo tsserver) is slow to
 * publish fresh diagnostics.
 */
const INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 500;
/**
 * Inner per-server diagnostics wait budget for the background/deferred fetch.
 * Longer than the inline cap (and the old 3s default) so a slow server still
 * delivers late instead of giving up before it ever publishes.
 */
const DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS = 12_000;
const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
const WORKSPACE_SYMBOL_LIMIT = 200;
const PROJECT_INDEXED_ACTIONS: ReadonlySet<string> = new Set([
	"definition",
	"type_definition",
	"implementation",
	"references",
	"rename",
	"hover",
]);

const RUST_WORKSPACE_MARKERS = ["Cargo.toml", "rust-analyzer.toml"] as const;

function hasRustWorkspaceAncestor(filePath: string): boolean {
	let dir = path.dirname(filePath);
	while (true) {
		for (const marker of RUST_WORKSPACE_MARKERS) {
			if (fs.existsSync(path.join(dir, marker))) {
				return true;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return false;
		}
		dir = parent;
	}
}

function limitDiagnosticMessages(messages: string[]): string[] {
	if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
		return messages;
	}
	return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}

const LOCATION_CONTEXT_LINES = 1;
const REFERENCE_CONTEXT_LIMIT = 50;

const REFERENCES_RETRY_COUNT = 2;
const REFERENCES_RETRY_DELAY_MS = 250;

function comparePosition(a: Position, b: Position): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function rangeContainsPosition(range: Location["range"], position: Position): boolean {
	return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

function isOnlyQueriedDeclaration(locations: Location[], uri: string, position: Position): boolean {
	return locations.length === 1 && locations[0]?.uri === uri && rangeContainsPosition(locations[0].range, position);
}

function normalizeLocationResult(result: Location | Location[] | LocationLink | LocationLink[] | null): Location[] {
	if (!result) return [];
	const raw = Array.isArray(result) ? result : [result];
	return raw.flatMap(loc => {
		if ("uri" in loc) {
			return [loc as Location];
		}
		if ("targetUri" in loc) {
			const link = loc as LocationLink;
			return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
		}
		return [];
	});
}

async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
	const header = `  ${formatLocation(location, cwd)}`;
	const context = await readLocationContext(
		uriToFile(location.uri),
		location.range.start.line + 1,
		LOCATION_CONTEXT_LINES,
	);
	if (context.length === 0) {
		return header;
	}
	return `${header}\n${context.map(lineText => `    ${lineText}`).join("\n")}`;
}

const MAX_RENAME_PAIRS = 1000;

interface FileRenamePair {
	oldUri: string;
	newUri: string;
}

/**
 * Enumerate the {oldUri, newUri} pairs needed for an LSP willRenameFiles/didRenameFiles request.
 * For files this is a single pair. For directories this walks every regular file underneath
 * and produces a parallel pair anchored at the new directory root.
 */
async function enumerateRenamePairs(
	source: string,
	dest: string,
): Promise<{ pairs: FileRenamePair[]; directory: boolean; exceeded: boolean }> {
	const stat = await fs.promises.stat(source);
	if (!stat.isDirectory()) {
		return {
			pairs: [{ oldUri: fileToUri(source), newUri: fileToUri(dest) }],
			directory: false,
			exceeded: false,
		};
	}
	const entries = await fs.promises.readdir(source, { recursive: true, withFileTypes: true });
	const pairs: FileRenamePair[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (pairs.length >= MAX_RENAME_PAIRS) {
			return { pairs, directory: true, exceeded: true };
		}
		const parent = entry.parentPath ?? source;
		const absOld = path.join(parent, entry.name);
		const rel = path.relative(source, absOld);
		pairs.push({
			oldUri: fileToUri(absOld),
			newUri: fileToUri(path.join(dest, rel)),
		});
	}
	return { pairs, directory: true, exceeded: false };
}

/** True when an LSP error indicates the server doesn't implement the requested method. */
function isMethodNotFoundError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("method not found") ||
		msg.includes("unhandled method") ||
		msg.includes("not supported") ||
		msg.includes("-32601")
	);
}

async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	// rust-analyzer exposes a real reload request.
	try {
		await sendRequest(client, "rust-analyzer/reloadWorkspace", null, signal);
		return `Reloaded ${serverName}`;
	} catch {
		// Method not supported — fall through.
	}
	// workspace/didChangeConfiguration is a notification per spec; sending it
	// as a request hangs until the tool deadline on servers that route it to
	// the notification handler and never respond.
	try {
		await sendNotification(client, "workspace/didChangeConfiguration", { settings: {} });
		return `Reloaded ${serverName}`;
	} catch {
		client.proc.kill();
		return `Restarted ${serverName}`;
	}
}

interface WaitForDiagnosticsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	minVersion?: number;
	expectedDocumentVersion?: number;
	/**
	 * Quiescence window (ms). typescript-language-server never echoes the document
	 * version (issue #983) and emits diagnostics from several sources at different
	 * times, so there is no single "complete, version-matched" publish to gate on.
	 * When the server does not exact-version-match, accept the latest publish only
	 * after no newer one has arrived for this long, letting an in-flight pre-edit
	 * publish be superseded by the fresh one.
	 */
	settleMs?: number;
}

async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, settleMs = DIAGNOSTICS_SETTLE_MS } = options;
	const start = Date.now();
	let settledRef: PublishedDiagnostics | undefined;
	let settledAt = 0;
	while (Date.now() - start < timeoutMs) {
		throwIfAborted(signal);
		const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
		const published = client.diagnostics.get(uri);
		if (published && versionOk) {
			// Server honored our exact document version → authoritative, accept now.
			if (expectedDocumentVersion !== undefined && published.version === expectedDocumentVersion) {
				return published.diagnostics;
			}
			// Unversioned/mismatched publish: wait for the stream to go quiet so an
			// in-flight publish for the pre-edit content is superseded by the fresh one.
			if (published !== settledRef) {
				settledRef = published;
				settledAt = Date.now();
			} else if (Date.now() - settledAt >= settleMs) {
				return published.diagnostics;
			}
		}
		await Bun.sleep(DIAGNOSTICS_POLL_MS);
	}
	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	if (!versionOk) {
		return [];
	}
	return client.diagnostics.get(uri)?.diagnostics ?? [];
}

/** Project type detection result */
interface ProjectType {
	type: "rust" | "typescript" | "go" | "python" | "unknown";
	command?: string[];
	description: string;
}

/** Detect project type from root markers */
function detectProjectType(cwd: string): ProjectType {
	// Check for Rust (Cargo.toml)
	if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
		return { type: "rust", command: ["cargo", "check", "--message-format=short"], description: "Rust (cargo check)" };
	}

	// Check for TypeScript (tsconfig.json)
	if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
		return { type: "typescript", command: ["npx", "tsc", "--noEmit"], description: "TypeScript (tsc --noEmit)" };
	}

	// Check for Go (go.mod)
	if (fs.existsSync(path.join(cwd, "go.mod"))) {
		return { type: "go", command: ["go", "build", "./..."], description: "Go (go build)" };
	}

	// Check for Python (pyproject.toml or pyrightconfig.json)
	if (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "pyrightconfig.json"))) {
		return { type: "python", command: ["pyright"], description: "Python (pyright)" };
	}

	return { type: "unknown", description: "Unknown project type" };
}

/** Run workspace diagnostics command and parse output */
async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType }> {
	throwIfAborted(signal);
	const projectType = detectProjectType(cwd);
	if (!projectType.command) {
		return {
			output: `Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.mod), Python (pyproject.toml)`,
			projectType,
		};
	}
	const proc = Bun.spawn(projectType.command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const abortHandler = () => {
		proc.kill();
	};
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		await proc.exited;
		throwIfAborted(signal);
		const combined = (stdout + stderr).trim();
		if (!combined) {
			return { output: "No issues found", projectType };
		}
		// Limit output length
		const lines = combined.split("\n");
		if (lines.length > 50) {
			return { output: `${lines.slice(0, 50).join("\n")}\n[…${lines.length - 50}ln elided…]`, projectType };
		}
		return { output: combined, projectType };
	} catch (e) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}
		return { output: `Failed to run ${projectType.command.join(" ")}: ${e}`, projectType };
	} finally {
		signal?.removeEventListener("abort", abortHandler);
	}
}

/** Result from getDiagnosticsForFile */
export interface FileDiagnosticsResult {
	/** Name of the LSP server used (if available) */
	server?: string;
	/** Formatted diagnostic messages */
	messages: string[];
	/** Summary string (e.g., "2 error(s), 1 warning(s)") */
	summary: string;
	/** Whether there are any errors (severity 1) */
	errored: boolean;
	/** Whether the file was formatted */
	formatter?: FileFormatResult;
}

type ServerVersionMap = Map<string, number>;

interface GetDiagnosticsForFileOptions {
	signal?: AbortSignal;
	minVersions?: ServerVersionMap;
	expectedDocumentVersions?: ServerVersionMap;
	/** Per-server wait budget (ms). Defaults to {@link SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/**
 * Capture current diagnostic versions for all LSP servers.
 * Call this BEFORE syncing content to detect stale diagnostics later.
 */
async function captureDiagnosticVersions(
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	initTimeoutMs?: number,
): Promise<ServerVersionMap> {
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			if (serverConfig.createClient) return;
			const client = await getOrCreateClient(serverConfig, cwd, initTimeoutMs);
			versions.set(serverName, client.diagnosticsVersion);
		}),
	);
	return versions;
}

async function captureOpenFileVersions(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
): Promise<ServerVersionMap> {
	const uri = fileToUri(absolutePath);
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd);
			const version = client.openFiles.get(uri)?.version;
			if (version !== undefined) {
				versions.set(serverName, version);
			}
		}),
	);
	return versions;
}

/**
 * Get diagnostics for a file using LSP or custom linter client.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to query diagnostics for
 * @param minVersions - Minimum diagnostic versions per server (to detect stale results)
 * @returns Diagnostic results or undefined if no servers
 */
async function getDiagnosticsForFile(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	options: GetDiagnosticsForFileOptions = {},
): Promise<FileDiagnosticsResult | undefined> {
	const { signal, minVersions, expectedDocumentVersions, timeoutMs } = options;
	if (servers.length === 0) {
		return undefined;
	}

	const uri = fileToUri(absolutePath);
	const relPath = formatPathRelativeToCwd(absolutePath, cwd);
	const allDiagnostics: Diagnostic[] = [];
	const serverNames: string[] = [];

	// Wait for diagnostics from all servers in parallel
	const results = await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			throwIfAborted(signal);
			// Use custom linter client if configured
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				const diagnostics = await linterClient.lint(absolutePath);
				return { serverName, diagnostics };
			}

			// Default: use LSP
			const client = await getOrCreateClient(serverConfig, cwd);
			throwIfAborted(signal);
			if (isProjectAwareLspServer(serverConfig)) {
				await waitForProjectLoaded(client, signal);
				throwIfAborted(signal);
			}
			// Content already synced + didSave sent, wait for fresh diagnostics
			const minVersion = minVersions?.get(serverName);
			const expectedDocumentVersion = expectedDocumentVersions?.get(serverName);
			const diagnostics = await waitForDiagnostics(client, uri, {
				timeoutMs: timeoutMs ?? SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
				signal,
				minVersion,
				expectedDocumentVersion,
			});
			return { serverName, diagnostics };
		}),
	);

	for (const result of results) {
		if (result.status === "fulfilled") {
			serverNames.push(result.value.serverName);
			allDiagnostics.push(...result.value.diagnostics);
		}
	}

	if (serverNames.length === 0) {
		return undefined;
	}

	if (allDiagnostics.length === 0) {
		return {
			server: serverNames.join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
	}

	// Deduplicate diagnostics by range + message (different servers might report similar issues)
	const seen = new Set<string>();
	const uniqueDiagnostics: Diagnostic[] = [];
	for (const d of allDiagnostics) {
		const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
		if (!seen.has(key)) {
			seen.add(key);
			uniqueDiagnostics.push(d);
		}
	}

	sortDiagnostics(uniqueDiagnostics);
	const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
	const limited = limitDiagnosticMessages(formatted);
	const summary = formatDiagnosticsSummary(uniqueDiagnostics);
	const hasErrors = uniqueDiagnostics.some(d => d.severity === 1);

	return {
		server: serverNames.join(", "),
		messages: limited,
		summary,
		errored: hasErrors,
	};
}

export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
}

/**
 * Format content using LSP or custom linter client.
 *
 * @param absolutePath - Absolute path (for URI)
 * @param content - Content to format
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to try formatting with
 * @returns Formatted content, or original if no formatter available
 */
async function formatContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<string> {
	if (servers.length === 0) {
		return content;
	}

	const uri = fileToUri(absolutePath);

	for (const [serverName, serverConfig] of servers) {
		try {
			throwIfAborted(signal);
			// Use custom linter client if configured
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				return await linterClient.format(absolutePath, content);
			}

			// Default: use LSP
			const client = await getOrCreateClient(serverConfig, cwd);
			throwIfAborted(signal);

			const caps = client.serverCapabilities;
			if (!caps?.documentFormattingProvider) {
				continue;
			}

			// Request formatting (content already synced)
			const edits = (await sendRequest(
				client,
				"textDocument/formatting",
				{
					textDocument: { uri },
					options: resolveFormatOptions(absolutePath, content),
				},
				signal,
			)) as TextEdit[] | null;

			if (!edits || edits.length === 0) {
				return content;
			}

			// Apply edits in-memory and return
			return applyTextEditsToString(content, edits);
		} catch {}
	}

	return content;
}

/** Options for creating the LSP writethrough callback */
export interface WritethroughOptions {
	/** Whether to format the file using LSP after writing */
	enableFormat?: boolean;
	/** Whether to get LSP diagnostics after writing */
	enableDiagnostics?: boolean;
	/** Called when diagnostics arrive after the main timeout. */
	onDeferredDiagnostics?: (diagnostics: FileDiagnosticsResult) => void;
	/** Signal to cancel a pending deferred diagnostics fetch. */
	deferredSignal?: AbortSignal;
	/** Transform diagnostics before surfacing them after a successful fetch. */
	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
}

/** Internal resolved form of {@link WritethroughOptions} that the writethrough machinery operates on. */
type ResolvedWritethroughOptions = {
	enableFormat: boolean;
	enableDiagnostics: boolean;
	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
};

/** Per-file deferred LSP diagnostics wiring for {@link WritethroughCallback}. */
export type WritethroughDeferredHandle = {
	onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
	signal: AbortSignal;
	finalize: (diagnostics: FileDiagnosticsResult | undefined) => void;
};

/** Callback type for the LSP writethrough */
export type WritethroughCallback = (
	dst: string,
	content: string,
	signal?: AbortSignal,
	file?: BunFile,
	batch?: LspWritethroughBatchRequest,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>;

/** No-op writethrough callback */
export async function writethroughNoop(
	dst: string,
	content: string,
	_signal?: AbortSignal,
	file?: BunFile,
	_batch?: LspWritethroughBatchRequest,
	_getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (file) {
		await file.write(content);
	} else {
		await Bun.write(dst, content);
	}
	return undefined;
}

interface PendingWritethrough {
	dst: string;
	content: string;
	file?: BunFile;
}

interface LspWritethroughBatchRequest {
	id: string;
	flush: boolean;
}

interface LspWritethroughBatchState {
	entries: Map<string, PendingWritethrough>;
	options: ResolvedWritethroughOptions;
}

const writethroughBatches = new Map<string, LspWritethroughBatchState>();

function getOrCreateWritethroughBatch(id: string, options: ResolvedWritethroughOptions): LspWritethroughBatchState {
	const existing = writethroughBatches.get(id);
	if (existing) {
		existing.options.enableFormat ||= options.enableFormat;
		existing.options.enableDiagnostics ||= options.enableDiagnostics;
		existing.options.transformDiagnostics ??= options.transformDiagnostics;
		return existing;
	}
	const batch: LspWritethroughBatchState = {
		entries: new Map<string, PendingWritethrough>(),
		options: { ...options },
	};
	writethroughBatches.set(id, batch);
	return batch;
}

export async function flushLspWritethroughBatch(
	id: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<FileDiagnosticsResult | undefined> {
	const state = writethroughBatches.get(id);
	if (!state) {
		return undefined;
	}
	writethroughBatches.delete(id);
	return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal);
}

function mergeDiagnostics(
	results: Array<FileDiagnosticsResult | undefined>,
	options: ResolvedWritethroughOptions,
): FileDiagnosticsResult | undefined {
	const messages: string[] = [];
	const servers = new Set<string>();
	let hasResults = false;
	let hasFormatter = false;
	let formatted = false;

	for (const result of results) {
		if (!result) continue;
		hasResults = true;
		if (result.server) {
			for (const server of result.server.split(",")) {
				const trimmed = server.trim();
				if (trimmed) {
					servers.add(trimmed);
				}
			}
		}
		if (result.messages.length > 0) {
			messages.push(...result.messages);
		}
		if (result.formatter !== undefined) {
			hasFormatter = true;
			if (result.formatter === FileFormatResult.FORMATTED) {
				formatted = true;
			}
		}
	}

	if (!hasResults && !hasFormatter) {
		return undefined;
	}

	let summary = options.enableDiagnostics ? "no issues" : "OK";
	let errored = false;
	let limitedMessages = messages;
	if (messages.length > 0) {
		const summaryInfo = summarizeDiagnosticMessages(messages);
		summary = summaryInfo.summary;
		errored = summaryInfo.errored;
		limitedMessages = limitDiagnosticMessages(messages);
	}
	const formatter = hasFormatter ? (formatted ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED) : undefined;

	return {
		server: servers.size > 0 ? Array.from(servers).join(", ") : undefined,
		messages: limitedMessages,
		summary,
		errored,
		formatter,
	};
}

async function scheduleDeferredDiagnosticsFetch(args: {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	signal: AbortSignal;
	callback: (diagnostics: FileDiagnosticsResult) => void;
}): Promise<void> {
	try {
		const deferredTimeout = AbortSignal.timeout(25_000);
		const combined = AbortSignal.any([args.signal, deferredTimeout]);
		const diagnostics = await getDiagnosticsForFile(args.dst, args.cwd, args.servers, {
			signal: combined,
			minVersions: args.minVersions,
			expectedDocumentVersions: args.expectedDocumentVersions,
			timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
		});
		if (args.signal.aborted || diagnostics === undefined) return;
		args.callback(diagnostics);
	} catch {
		// Cancelled or LSP gave up; silently discard.
	}
}

/**
 * Fetch post-write diagnostics without making the edit/write block on a slow
 * language server.
 *
 * Blocks inline only briefly ({@link INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS}) for a
 * fresh result. Freshness is enforced by the pre-edit `minVersions` baseline:
 * exact document-version matches return immediately, and unversioned/mismatched
 * publishes must settle with no newer publish before inline acceptance. If
 * nothing fresh arrives in the inline window and a deferred
 * channel is available, the in-flight fetch is handed off to deliver late via
 * `onDeferredDiagnostics`, and this returns `undefined` so the tool result
 * lands immediately. Without a deferred channel (direct/CI callers) it blocks
 * for the standard budget so the result is still returned inline.
 */
async function fetchDiagnosticsWithDeferral(args: {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	transformDiagnostics?: ResolvedWritethroughOptions["transformDiagnostics"];
	deferred?: { onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void; signal: AbortSignal };
	signal?: AbortSignal;
}): Promise<FileDiagnosticsResult | undefined> {
	const { dst, cwd, servers, minVersions, expectedDocumentVersions, transformDiagnostics, deferred, signal } = args;
	const apply = (d: FileDiagnosticsResult | undefined) =>
		d && transformDiagnostics ? transformDiagnostics(dst, d) : d;

	if (!deferred) {
		// No late-injection channel: block for the standard budget and return inline.
		return apply(
			await getDiagnosticsForFile(dst, cwd, servers, {
				signal,
				minVersions,
				expectedDocumentVersions,
			}),
		);
	}

	// One background fetch with a generous inner budget; await it only briefly inline.
	const fetchPromise = getDiagnosticsForFile(dst, cwd, servers, {
		signal: deferred.signal,
		minVersions,
		expectedDocumentVersions,
		timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	});
	const INLINE_TIMEOUT = Symbol("inline-diagnostics-timeout");
	const raced = await Promise.race([
		fetchPromise,
		Bun.sleep(INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS).then(() => INLINE_TIMEOUT),
	]);
	if (raced !== INLINE_TIMEOUT) {
		return apply(raced as FileDiagnosticsResult | undefined);
	}
	// Slow server: deliver late via the deferred channel; nothing inline. The
	// deferred sink (edit tool) applies its own dedup, so pass the raw result.
	void fetchPromise
		.then(diagnostics => {
			if (diagnostics && !deferred.signal.aborted) deferred.onDeferredDiagnostics(diagnostics);
		})
		.catch(() => {});
	return undefined;
}

async function runLspWritethrough(
	dst: string,
	content: string,
	cwd: string,
	options: ResolvedWritethroughOptions,
	signal?: AbortSignal,
	file?: BunFile,
	deferred?: {
		onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
		signal: AbortSignal;
	},
): Promise<FileDiagnosticsResult | undefined> {
	const { enableFormat, enableDiagnostics } = options;
	const config = getConfig(cwd);
	const servers = getServersForFile(config, dst);
	if (servers.length === 0) {
		return writethroughNoop(dst, content, signal, file);
	}
	const { lspServers, customLinterServers } = splitServers(servers);

	let finalContent = content;
	const writeContent = async (value: string) => (file ? file.write(value) : Bun.write(dst, value));
	const getWritePromise = once(() => writeContent(finalContent));
	const useCustomFormatter = enableFormat && customLinterServers.length > 0;

	// Capture diagnostic versions BEFORE syncing to detect stale diagnostics
	// Bound client creation by the writethrough budget: a hung/broken server
	// must not add its full init wait (30s default) to every edit.
	const minVersions = enableDiagnostics ? await captureDiagnosticVersions(cwd, servers, 5_000) : undefined;
	let expectedDocumentVersions: ServerVersionMap | undefined;

	let formatter: FileFormatResult | undefined;
	let diagnostics: FileDiagnosticsResult | undefined;
	let timedOut = false;
	let synced = false;
	try {
		const timeoutSignal = AbortSignal.timeout(5_000);
		timeoutSignal.addEventListener(
			"abort",
			() => {
				timedOut = true;
			},
			{ once: true },
		);
		const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		await untilAborted(operationSignal, async () => {
			if (useCustomFormatter) {
				// Custom linters (e.g. Biome CLI) require on-disk input.
				await writeContent(content);
				finalContent = await formatContent(dst, content, cwd, customLinterServers, operationSignal);
				formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				await writeContent(finalContent);
				await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
			} else {
				// 1. Sync original content to LSP servers
				await syncFileContent(dst, content, cwd, lspServers, operationSignal);

				// 2. Format in-memory via LSP
				if (enableFormat) {
					finalContent = await formatContent(dst, content, cwd, lspServers, operationSignal);
					formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				}

				// 3. If formatted, sync formatted content to LSP servers
				if (finalContent !== content) {
					await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
				}

				// 4. Write to disk
				await getWritePromise();
			}

			if (enableDiagnostics) {
				expectedDocumentVersions = await captureOpenFileVersions(dst, cwd, lspServers);
			}

			// 5. Notify saved to LSP servers
			await notifyFileSaved(dst, cwd, lspServers, operationSignal);
		});
		synced = true;
	} catch {
		if (timedOut) {
			formatter = undefined;
			diagnostics = undefined;
			// Schedule background diagnostic fetch if caller wants deferred results
			if (deferred && !deferred.signal.aborted && enableDiagnostics) {
				void scheduleDeferredDiagnosticsFetch({
					dst,
					cwd,
					servers,
					minVersions,
					expectedDocumentVersions,
					signal: deferred.signal,
					callback: deferred.onDeferredDiagnostics,
				});
			}
		}
		await getWritePromise();
	}

	if (synced && enableDiagnostics) {
		diagnostics = await fetchDiagnosticsWithDeferral({
			dst,
			cwd,
			servers,
			minVersions,
			expectedDocumentVersions,
			transformDiagnostics: options.transformDiagnostics,
			deferred,
			signal,
		});
	}

	if (formatter !== undefined) {
		diagnostics ??= {
			server: servers.map(([name]) => name).join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
		diagnostics.formatter = formatter;
	}

	return diagnostics;
}

async function flushWritethroughBatch(
	batch: PendingWritethrough[],
	cwd: string,
	options: ResolvedWritethroughOptions,
	signal?: AbortSignal,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (batch.length === 0) {
		return undefined;
	}
	const results: Array<FileDiagnosticsResult | undefined> = [];
	for (const entry of batch) {
		const bundle = getDeferred?.(entry.dst);
		const deferredInner =
			bundle &&
			({
				onDeferredDiagnostics: bundle.onDeferredDiagnostics,
				signal: bundle.signal,
			} as const);
		const diag = await runLspWritethrough(entry.dst, entry.content, cwd, options, signal, entry.file, deferredInner);
		bundle?.finalize(diag);
		results.push(diag);
	}
	return mergeDiagnostics(results, options);
}

/** Create a writethrough callback for LSP aware write operations */
export function createLspWritethrough(cwd: string, options?: WritethroughOptions): WritethroughCallback {
	const resolvedOptions: ResolvedWritethroughOptions = {
		enableFormat: options?.enableFormat ?? false,
		enableDiagnostics: options?.enableDiagnostics ?? false,
		transformDiagnostics: options?.transformDiagnostics,
	};
	if (!resolvedOptions.enableFormat && !resolvedOptions.enableDiagnostics) {
		return writethroughNoop;
	}
	return async (
		dst: string,
		content: string,
		signal?: AbortSignal,
		file?: BunFile,
		batch?: LspWritethroughBatchRequest,
		getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
	) => {
		if (!batch) {
			const bundle = getDeferred?.(dst);
			const deferredInner =
				bundle &&
				({
					onDeferredDiagnostics: bundle.onDeferredDiagnostics,
					signal: bundle.signal,
				} as const);
			const diagnostics = await runLspWritethrough(dst, content, cwd, resolvedOptions, signal, file, deferredInner);
			bundle?.finalize(diagnostics);
			return diagnostics;
		}

		const state = getOrCreateWritethroughBatch(batch.id, resolvedOptions);
		state.entries.set(dst, { dst, content, file });

		if (!batch.flush) {
			await writethroughNoop(dst, content, signal, file);
			return undefined;
		}

		writethroughBatches.delete(batch.id);
		return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal, getDeferred);
	};
}

/**
 * LSP tool for language server protocol operations.
 */
export class LspTool implements AgentTool<typeof lspSchema, LspToolDetails, Theme> {
	readonly name = "lsp";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawAction = (args as Partial<LspParams>).action;
		const action = typeof rawAction === "string" ? rawAction.toLowerCase() : "";
		return LSP_READONLY_ACTIONS.has(action) ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<LspParams>;
		const lines = [`Action: ${typeof params.action === "string" ? params.action : "(missing)"}`];
		if (typeof params.file === "string" && params.file.length > 0) {
			lines.push(`File: ${truncateForPrompt(params.file)}`);
		}
		return lines;
	};
	readonly label = "LSP";
	readonly loadMode = "discoverable";
	readonly summary = "Query LSP (language server) for diagnostics, hover info, and references";
	readonly description: string;
	readonly parameters = lspSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(lspDescription);
	}

	static createIf(session: ToolSession): LspTool | null {
		return session.enableLsp === false ? null : new LspTool(session);
	}

	async execute(
		_toolCallId: string,
		params: LspParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<LspToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file, line, symbol, query, new_name, apply, timeout } = params;
		const timeoutSec = clampTimeout("lsp", timeout);
		const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
		const callerSignal = signal;
		signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
		throwIfAborted(signal);

		const config = getConfig(this.session.cwd);

		// Status action doesn't need a file
		if (action === "status") {
			const configuredNames = Object.keys(config.servers);
			const lspmuxState = await detectLspmux();
			const lspmuxStatus = lspmuxState.available
				? lspmuxState.running
					? "lspmux: active (multiplexing enabled)"
					: "lspmux: installed but server not running"
				: "";

			// `Object.keys(config.servers)` reflects what is *configured & resolvable
			// on PATH* — it does NOT prove the server actually starts. A wrapper
			// binary that exits immediately (e.g. rustup without the rust-analyzer
			// component) still appears here. Distinguish "configured" from
			// "started" (have a live in-process client) so callers cannot mistake
			// presence-on-PATH for a working server.
			const startedClients = getActiveClients();
			const startedByConfigName = new Map<string, LspServerStatus>();
			// getActiveClients() reports `name = client.config.command` (the
			// unresolved binary name from defaults.json), so match against
			// `serverConfig.command`, not the resolved path.
			for (const [name, serverConfig] of Object.entries(config.servers)) {
				const matched = startedClients.find(c => c.name === serverConfig.command);
				if (matched) startedByConfigName.set(name, matched);
			}

			const lines: string[] = [];
			if (configuredNames.length === 0) {
				lines.push("No language servers configured for this project");
			} else {
				const labelled = configuredNames.map(name => {
					const started = startedByConfigName.get(name);
					if (!started) return `${name} (configured, not started)`;
					return `${name} (${started.status})`;
				});
				lines.push(`Language servers: ${labelled.join(", ")}`);
				lines.push(
					"  note: 'configured, not started' means the binary resolves on PATH but no request has spawned it yet; 'ready' means a client process is live for this cwd.",
				);
			}
			if (lspmuxStatus) lines.push(lspmuxStatus);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { action, success: true, request: params },
			};
		}

		// Diagnostics can be batch or single-file - queries all applicable servers
		if (action === "diagnostics") {
			if (file === "*") {
				// `*` => run workspace diagnostics across all configured servers
				const result = await runWorkspaceDiagnostics(this.session.cwd, signal);
				return {
					content: [
						{
							type: "text",
							text: `Workspace diagnostics (${result.projectType.description}):\n${result.output}`,
						},
					],
					details: { action, success: true, request: params },
				};
			}

			if (!file) {
				return {
					content: [
						{
							type: "text",
							text: "Error: file parameter required. Use `*` for workspace-wide diagnostics or a path/glob for specific files.",
						},
					],
					details: { action, success: false, request: params },
				};
			}

			let targets: string[];
			let truncatedGlobTargets = false;
			const resolvedTargets = await resolveDiagnosticTargets(file, this.session.cwd, MAX_GLOB_DIAGNOSTIC_TARGETS);
			targets = resolvedTargets.matches;
			truncatedGlobTargets = resolvedTargets.truncated;

			if (targets.length === 0) {
				return {
					content: [{ type: "text", text: `No files matched pattern: ${file}` }],
					details: { action, success: true, request: params },
				};
			}

			const detailed = targets.length > 1 || truncatedGlobTargets;
			const diagnosticsWaitTimeoutMs = detailed
				? Math.min(BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000)
				: Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000);
			const results: string[] = [];
			const allServerNames = new Set<string>();
			if (truncatedGlobTargets) {
				results.push(
					`${theme.status.warning} Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}. Narrow the glob or use workspace diagnostics.`,
				);
			}

			for (const target of targets) {
				throwIfAborted(signal);
				const resolved = resolveToCwd(target, this.session.cwd);
				const servers = getServersForFile(config, resolved);
				if (servers.length === 0) {
					results.push(`${theme.status.error} ${target}: No language server found`);
					continue;
				}

				const uri = fileToUri(resolved);
				const relPath = formatPathRelativeToCwd(resolved, this.session.cwd);
				const allDiagnostics: Diagnostic[] = [];

				// Query all applicable servers for this file
				for (const [serverName, serverConfig] of servers) {
					allServerNames.add(serverName);
					try {
						throwIfAborted(signal);
						if (serverConfig.createClient) {
							const linterClient = getLinterClient(serverName, serverConfig, this.session.cwd);
							const diagnostics = await linterClient.lint(resolved);
							allDiagnostics.push(...diagnostics);
							continue;
						}
						const client = await getOrCreateClient(serverConfig, this.session.cwd);
						if (isProjectAwareLspServer(serverConfig)) {
							await waitForProjectLoaded(client, signal);
							throwIfAborted(signal);
						}
						const minVersion = client.diagnosticsVersion;
						await refreshFile(client, resolved, signal);
						const expectedDocumentVersion = client.openFiles.get(uri)?.version;
						const diagnostics = await waitForDiagnostics(client, uri, {
							timeoutMs: diagnosticsWaitTimeoutMs,
							signal,
							minVersion,
							expectedDocumentVersion,
						});
						allDiagnostics.push(...diagnostics);
					} catch (err) {
						if (err instanceof ToolAbortError || signal?.aborted) {
							throw err;
						}
						// Server failed, continue with others
					}
				}

				// Deduplicate diagnostics
				const seen = new Set<string>();
				const uniqueDiagnostics: Diagnostic[] = [];
				for (const d of allDiagnostics) {
					const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
					if (!seen.has(key)) {
						seen.add(key);
						uniqueDiagnostics.push(d);
					}
				}

				sortDiagnostics(uniqueDiagnostics);

				if (!detailed && targets.length === 1) {
					if (uniqueDiagnostics.length === 0) {
						return {
							content: [{ type: "text", text: "OK" }],
							details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
						};
					}

					const summary = formatDiagnosticsSummary(uniqueDiagnostics);
					const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
					const output = `${summary}:\n${formatGroupedDiagnosticMessages(formatted)}`;
					return {
						content: [{ type: "text", text: output }],
						details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
					};
				}

				if (uniqueDiagnostics.length === 0) {
					results.push(`${theme.status.success} ${relPath}: no issues`);
				} else {
					const summary = formatDiagnosticsSummary(uniqueDiagnostics);
					results.push(`${theme.status.error} ${relPath}: ${summary}`);
					const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
					results.push(formatGroupedDiagnosticMessages(formatted));
				}
			}

			return {
				content: [{ type: "text", text: results.join("\n") }],
				details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
			};
		}

		if (action === "rename_file") {
			if (!file || !new_name) {
				return {
					content: [
						{
							type: "text",
							text: "Error: rename_file requires both `file` (source path) and `new_name` (destination path)",
						},
					],
					details: { action, success: false, request: params },
				};
			}

			const source = resolveToCwd(file, this.session.cwd);
			const dest = resolveToCwd(new_name, this.session.cwd);

			if (source === dest) {
				return {
					content: [{ type: "text", text: "Error: source and destination paths are identical" }],
					details: { action, success: false, request: params },
				};
			}

			let sourceStat: fs.Stats;
			try {
				sourceStat = await fs.promises.stat(source);
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Error: source path does not exist: ${formatPathRelativeToCwd(source, this.session.cwd)}`,
						},
					],
					details: { action, success: false, request: params },
				};
			}

			let destExists = false;
			try {
				await fs.promises.stat(dest);
				destExists = true;
			} catch {
				// expected: destination must not exist
			}
			if (destExists) {
				return {
					content: [
						{
							type: "text",
							text: `Error: destination already exists: ${formatPathRelativeToCwd(dest, this.session.cwd)}`,
						},
					],
					details: { action, success: false, request: params },
				};
			}

			const enumerated = await enumerateRenamePairs(source, dest);
			if (enumerated.exceeded) {
				return {
					content: [
						{
							type: "text",
							text: `Error: directory contains more than ${MAX_RENAME_PAIRS} files; rename in smaller batches to keep LSP edits accurate`,
						},
					],
					details: { action, success: false, request: params },
				};
			}
			const { pairs } = enumerated;
			if (pairs.length === 0) {
				return {
					content: [{ type: "text", text: "Error: no files to rename" }],
					details: { action, success: false, request: params },
				};
			}

			const lspParams = { files: pairs };
			// Filter to servers whose fileTypes match either the source or any
			// destination path. Asking every configured server about a .md/.sql/.txt
			// rename used to stack up willRenameFiles requests against irrelevant
			// language servers and hit the wall-clock timeout. A server only has
			// something useful to say about a rename if it understands one of the
			// affected file extensions.
			const allLspServers = getLspServers(config);
			const relevantNames = new Set<string>();
			const collectRelevant = (filePath: string) => {
				for (const [name] of getLspServersForFile(config, filePath)) {
					relevantNames.add(name);
				}
			};
			collectRelevant(source);
			collectRelevant(dest);
			for (const pair of pairs) {
				collectRelevant(uriToFile(pair.oldUri));
				collectRelevant(uriToFile(pair.newUri));
			}
			const servers = allLspServers.filter(([name]) => relevantNames.has(name));
			const respondingServers = new Set<string>();
			const perServerEdits: Array<{ serverName: string; edit: WorkspaceEdit }> = [];
			const serverNotes: string[] = [];

			for (const [serverName, serverConfig] of servers) {
				throwIfAborted(signal);
				try {
					const client = await getOrCreateClient(serverConfig, this.session.cwd);
					if (isProjectAwareLspServer(serverConfig)) {
						await waitForProjectLoaded(client, signal);
					}
					const result = (await sendRequest(
						client,
						"workspace/willRenameFiles",
						lspParams,
						signal,
					)) as WorkspaceEdit | null;
					respondingServers.add(serverName);
					if (result && (result.changes || result.documentChanges)) {
						perServerEdits.push({ serverName, edit: result });
					}
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
					if (!isMethodNotFoundError(err)) {
						const msg = err instanceof Error ? err.message : String(err);
						serverNotes.push(`  ${serverName}: ${msg}`);
					}
				}
			}

			const sourceLabel = formatPathRelativeToCwd(source, this.session.cwd);
			const destLabel = formatPathRelativeToCwd(dest, this.session.cwd);
			const fileCountLabel = sourceStat.isDirectory()
				? `${pairs.length} file${pairs.length !== 1 ? "s" : ""} under ${sourceLabel}`
				: sourceLabel;

			const shouldApply = apply !== false;
			if (!shouldApply) {
				const lines: string[] = [];
				lines.push(`Rename preview: ${fileCountLabel} → ${destLabel}`);
				if (perServerEdits.length === 0) {
					lines.push("  No LSP edits would be applied");
				} else {
					for (const { serverName, edit } of perServerEdits) {
						const edits = formatWorkspaceEdit(edit, this.session.cwd);
						if (edits.length === 0) continue;
						lines.push(`  ${serverName}:`);
						for (const e of edits) {
							lines.push(`    ${e}`);
						}
					}
				}
				if (serverNotes.length > 0) {
					lines.push("  Server notes:");
					lines.push(...serverNotes);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						action,
						serverName: Array.from(respondingServers).join(", "),
						success: true,
						request: params,
					},
				};
			}

			const summary: string[] = [];

			// Coalesce per-URI edits across servers before applying. Each server
			// computed positions against the pre-edit file content, so applying
			// server A then re-reading for server B yields stale positions and
			// produces malformed imports. Group all text edits by URI, prefer the
			// project-primary (project-aware) server on overlap, and apply once
			// per URI from a single snapshot.
			const serverConfigByName = new Map(servers);
			interface AcceptedBucket {
				primaryServer: string;
				edits: TextEdit[];
				discarded: number;
				conflictServers: Set<string>;
			}
			const acceptedByUri = new Map<string, AcceptedBucket>();
			for (const { serverName, edit } of perServerEdits) {
				const cfg = serverConfigByName.get(serverName);
				const incomingPrimary = cfg ? isProjectAwareLspServer(cfg) : false;
				const flat = flattenWorkspaceTextEdits(edit);
				for (const [uri, edits] of flat) {
					const existing = acceptedByUri.get(uri);
					if (!existing) {
						acceptedByUri.set(uri, {
							primaryServer: serverName,
							edits: [...edits],
							discarded: 0,
							conflictServers: new Set(),
						});
						continue;
					}
					const existingCfg = serverConfigByName.get(existing.primaryServer);
					const existingIsPrimary = existingCfg ? isProjectAwareLspServer(existingCfg) : false;
					if (incomingPrimary && !existingIsPrimary) {
						// Promote incoming to primary; keep existing edits that don't overlap.
						const keptOld: TextEdit[] = [];
						let discardedOld = 0;
						for (const oe of existing.edits) {
							if (edits.some(ne => rangesOverlap(ne.range, oe.range))) discardedOld++;
							else keptOld.push(oe);
						}
						if (discardedOld > 0) existing.conflictServers.add(existing.primaryServer);
						existing.discarded += discardedOld;
						existing.primaryServer = serverName;
						existing.edits = [...edits, ...keptOld];
					} else {
						// Existing wins; discard incoming edits that overlap any accepted edit.
						let discardedNew = 0;
						for (const ne of edits) {
							if (existing.edits.some(ae => rangesOverlap(ae.range, ne.range))) {
								discardedNew++;
							} else {
								existing.edits.push(ne);
							}
						}
						if (discardedNew > 0) {
							existing.conflictServers.add(serverName);
							existing.discarded += discardedNew;
						}
					}
				}
			}

			for (const [uri, bucket] of acceptedByUri) {
				const filePath = uriToFile(uri);
				await applyTextEdits(filePath, bucket.edits);
				const rel = formatPathRelativeToCwd(filePath, this.session.cwd);
				summary.push(`  ${bucket.primaryServer}: applied ${bucket.edits.length} edit(s) to ${rel}`);
				if (bucket.discarded > 0) {
					const others = Array.from(bucket.conflictServers).join(", ");
					summary.push(
						`    note: discarded ${bucket.discarded} overlapping edit(s) from ${others} (kept ${bucket.primaryServer})`,
					);
					logger.warn(
						`lsp rename_file: discarded ${bucket.discarded} overlapping edit(s) from ${others} on ${rel}; kept ${bucket.primaryServer}`,
					);
				}
			}

			await fs.promises.mkdir(path.dirname(dest), { recursive: true });
			await fs.promises.rename(source, dest);
			summary.push(`  Renamed ${sourceLabel} → ${destLabel}`);

			for (const [serverName, serverConfig] of servers) {
				try {
					const client = await getOrCreateClient(serverConfig, this.session.cwd);
					for (const { oldUri } of pairs) {
						if (client.openFiles.has(oldUri)) {
							await sendNotification(client, "textDocument/didClose", {
								textDocument: { uri: oldUri },
							});
							client.openFiles.delete(oldUri);
						}
					}
					await sendNotification(client, "workspace/didRenameFiles", lspParams);
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
					const msg = err instanceof Error ? err.message : String(err);
					serverNotes.push(`  ${serverName}: ${msg}`);
				}
			}

			if (serverNotes.length > 0) {
				summary.push("  Server notes:");
				summary.push(...serverNotes);
			}

			const header = `Renamed ${fileCountLabel} → ${destLabel}`;
			return {
				content: [{ type: "text", text: `${header}\n${summary.join("\n")}` }],
				details: {
					action,
					serverName: Array.from(respondingServers).join(", "),
					success: true,
					request: params,
				},
			};
		}

		if (action === "capabilities") {
			let serverList: Array<[string, ServerConfig]>;
			if (file && file !== "*") {
				const resolved = resolveToCwd(file, this.session.cwd);
				serverList = getLspServersForFile(config, resolved);
				if (serverList.length === 0) {
					return {
						content: [{ type: "text", text: "No language server found for this file" }],
						details: { action, success: false, request: params },
					};
				}
			} else {
				serverList = getLspServers(config);
			}

			if (serverList.length === 0) {
				return {
					content: [{ type: "text", text: "No language servers configured" }],
					details: { action, success: false, request: params },
				};
			}

			const sections: string[] = [];
			const respondingServers = new Set<string>();
			for (const [serverName, serverConfig] of serverList) {
				throwIfAborted(signal);
				try {
					const client = await getOrCreateClient(serverConfig, this.session.cwd);
					respondingServers.add(serverName);
					const caps = client.serverCapabilities ?? {};
					sections.push(`${serverName}:`);
					sections.push(`  capabilities: ${JSON.stringify(caps, null, 2).split("\n").join("\n  ")}`);
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
					const msg = err instanceof Error ? err.message : String(err);
					sections.push(`${serverName}: failed to start (${msg})`);
				}
			}

			return {
				content: [{ type: "text", text: sections.join("\n") }],
				details: {
					action,
					serverName: Array.from(respondingServers).join(", "),
					success: true,
					request: params,
				},
			};
		}

		if (action === "request") {
			const method = query?.trim();
			if (!method) {
				return {
					content: [
						{
							type: "text",
							text: "Error: action=request requires `query` to specify the LSP method name (e.g., 'rust-analyzer/expandMacro')",
						},
					],
					details: { action, success: false, request: params },
				};
			}

			let chosenServer: [string, ServerConfig] | null = null;
			let resolvedTarget: string | null = null;
			if (file && file !== "*") {
				resolvedTarget = resolveToCwd(file, this.session.cwd);
				chosenServer = getLspServerForFile(config, resolvedTarget);
				if (!chosenServer) {
					return {
						content: [{ type: "text", text: "No language server found for this file" }],
						details: { action, success: false, request: params },
					};
				}
			} else {
				const all = getLspServers(config);
				if (all.length === 0) {
					return {
						content: [{ type: "text", text: "No language servers configured" }],
						details: { action, success: false, request: params },
					};
				}
				chosenServer = all[0];
			}

			const [chosenName, chosenConfig] = chosenServer;
			let requestParams: unknown;
			if (params.payload !== undefined) {
				try {
					requestParams = JSON.parse(params.payload);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Error: invalid JSON in payload: ${msg}` }],
						details: { action, serverName: chosenName, success: false, request: params },
					};
				}
			} else if (resolvedTarget) {
				const uri = fileToUri(resolvedTarget);
				if (line !== undefined) {
					const character = await resolveSymbolColumn(resolvedTarget, line, symbol);
					requestParams = { textDocument: { uri }, position: { line: line - 1, character } };
				} else {
					requestParams = { textDocument: { uri } };
				}
			} else {
				requestParams = {};
			}

			try {
				const client = await getOrCreateClient(chosenConfig, this.session.cwd);
				if (resolvedTarget) {
					await ensureFileOpen(client, resolvedTarget, signal);
				}
				const result = await sendRequest(client, method, requestParams, signal);
				const formatted =
					result === null || result === undefined
						? "null"
						: typeof result === "string"
							? result
							: JSON.stringify(result, null, 2);
				return {
					content: [{ type: "text", text: `${chosenName} ← ${method}:\n${formatted}` }],
					details: { action, serverName: chosenName, success: true, request: params },
				};
			} catch (err) {
				if (err instanceof ToolAbortError || signal?.aborted) {
					throw new ToolAbortError();
				}
				const msg = err instanceof Error ? err.message : String(err);
				// Echo a (truncated) preview of the params we sent so the caller can
				// tell parse / shape errors (e.g. nested args dropped, missing field)
				// apart from genuine server errors without spinning up another debug call.
				const previewRaw = JSON.stringify(requestParams ?? null);
				const preview = previewRaw.length > 400 ? `${previewRaw.slice(0, 397)}...` : previewRaw;
				return {
					content: [
						{ type: "text", text: `LSP error from ${chosenName} on ${method}: ${msg}\n  params: ${preview}` },
					],
					details: { action, serverName: chosenName, success: false, request: params },
				};
			}
		}

		// `*` means workspace scope for symbols/reload; other actions need a concrete file.
		const isWorkspace = file === "*";
		const requiresFile = !file && action !== "reload";

		if (requiresFile) {
			return {
				content: [
					{
						type: "text",
						text: "Error: file parameter required. Use `*` for workspace scope where supported.",
					},
				],
				details: { action, success: false },
			};
		}

		const resolvedFile = file && !isWorkspace ? resolveToCwd(file, this.session.cwd) : null;
		if (action === "symbols" && (isWorkspace || !resolvedFile)) {
			const normalizedQuery = query?.trim();
			if (!normalizedQuery) {
				return {
					content: [{ type: "text", text: "Error: query parameter required for workspace symbol search" }],
					details: { action, success: false, request: params },
				};
			}
			const servers = getLspServers(config);
			if (servers.length === 0) {
				return {
					content: [{ type: "text", text: "No language server found for this action" }],
					details: { action, success: false, request: params },
				};
			}
			const aggregatedSymbols: SymbolInformation[] = [];
			const respondingServers = new Set<string>();
			for (const [workspaceServerName, workspaceServerConfig] of servers) {
				throwIfAborted(signal);
				try {
					const workspaceClient = await getOrCreateClient(workspaceServerConfig, this.session.cwd);
					const workspaceResult = (await sendRequest(
						workspaceClient,
						"workspace/symbol",
						{ query: normalizedQuery },
						signal,
					)) as SymbolInformation[] | null;
					if (!workspaceResult || workspaceResult.length === 0) {
						continue;
					}
					respondingServers.add(workspaceServerName);
					aggregatedSymbols.push(...filterWorkspaceSymbols(workspaceResult, normalizedQuery));
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
				}
			}
			const dedupedSymbols = dedupeWorkspaceSymbols(aggregatedSymbols);
			if (dedupedSymbols.length === 0) {
				return {
					content: [{ type: "text", text: `No symbols matching "${normalizedQuery}"` }],
					details: {
						action,
						serverName: Array.from(respondingServers).join(", "),
						success: true,
						request: params,
					},
				};
			}
			const limitedSymbols = dedupedSymbols.slice(0, WORKSPACE_SYMBOL_LIMIT);
			const lines = limitedSymbols.map(s => formatSymbolInformation(s, this.session.cwd));
			const truncationLine =
				dedupedSymbols.length > WORKSPACE_SYMBOL_LIMIT
					? `\n[…${dedupedSymbols.length - WORKSPACE_SYMBOL_LIMIT} symbols elided…]`
					: "";
			return {
				content: [
					{
						type: "text",
						text: `Found ${dedupedSymbols.length} symbol(s) matching "${normalizedQuery}":\n${lines.map(l => `  ${l}`).join("\n")}${truncationLine}`,
					},
				],
				details: {
					action,
					serverName: Array.from(respondingServers).join(", "),
					success: true,
					request: params,
				},
			};
		}

		if (action === "reload" && (isWorkspace || !resolvedFile)) {
			// `reload *` is the user's explicit request to re-read config from
			// disk. Drop the per-cwd cache entry so `.omp/lsp.json`, root markers,
			// and plugin configs added after the first LSP call become visible —
			// otherwise `getConfig` returns the first observation for the rest of
			// the process lifetime (#3546).
			configCache.delete(this.session.cwd);
			const refreshedConfig = getConfig(this.session.cwd);
			const servers = getLspServers(refreshedConfig);
			if (servers.length === 0) {
				return {
					content: [{ type: "text", text: "No language server found for this action" }],
					details: { action, success: false, request: params },
				};
			}
			const outputs: string[] = [];
			for (const [workspaceServerName, workspaceServerConfig] of servers) {
				throwIfAborted(signal);
				try {
					const workspaceClient = await getOrCreateClient(workspaceServerConfig, this.session.cwd);
					outputs.push(await reloadServer(workspaceClient, workspaceServerName, signal));
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
					const errorMessage = err instanceof Error ? err.message : String(err);
					outputs.push(`Failed to reload ${workspaceServerName}: ${errorMessage}`);
				}
			}
			return {
				content: [{ type: "text", text: outputs.join("\n") }],
				details: { action, serverName: servers.map(([name]) => name).join(", "), success: true, request: params },
			};
		}

		const serverInfo = resolvedFile ? getLspServerForFile(config, resolvedFile) : null;
		if (!serverInfo) {
			return {
				content: [{ type: "text", text: "No language server found for this action" }],
				details: { action, success: false },
			};
		}

		const [serverName, serverConfig] = serverInfo;

		try {
			const client = await getOrCreateClient(serverConfig, this.session.cwd);
			const targetFile = resolvedFile;
			const isRustAnalyzerServer =
				serverName === "rust-analyzer" ||
				path.basename(serverConfig.command) === "rust-analyzer" ||
				(serverConfig.resolvedCommand ? path.basename(serverConfig.resolvedCommand) === "rust-analyzer" : false);
			const needsProjectIndex =
				targetFile !== null && PROJECT_INDEXED_ACTIONS.has(action) && isProjectAwareLspServer(serverConfig);
			const rustWorkspaceWait =
				needsProjectIndex && isRustAnalyzerServer && targetFile !== null && hasRustWorkspaceAncestor(targetFile);

			if (targetFile) {
				await ensureFileOpen(client, targetFile, signal);
			}
			if (rustWorkspaceWait) {
				await waitForProjectLoaded(client, signal);
			}

			// For project-aware servers, references/rename/definition without a `symbol`
			// silently falls back to the first non-whitespace column on the line, which
			// frequently points at the wrong identifier (decorator, keyword, parameter)
			// and the server returns plausible-looking but unrelated results. Require
			// `symbol` explicitly so callers cannot accidentally trigger that fallback.
			if (
				targetFile &&
				line !== undefined &&
				!symbol &&
				(action === "references" || action === "rename" || action === "definition") &&
				isProjectAwareLspServer(serverConfig)
			) {
				throw new ToolError(
					`symbol is required for project-aware ${action}; pass symbol=<name>, optionally symbol#N for repeated occurrences`,
				);
			}
			const uri = targetFile ? fileToUri(targetFile) : "";
			const resolvedLine = line ?? 1;
			const resolvedCharacter = targetFile ? await resolveSymbolColumn(targetFile, resolvedLine, symbol) : 0;
			const position = { line: resolvedLine - 1, character: resolvedCharacter };

			let output: string;
			// Set on bare empty-lookup outcomes (no definition/references/…): the
			// result carries no information once consumed, so compaction may elide
			// it. Clean diagnostics runs are NOT useless — they are verification
			// evidence.
			let useless = false;

			if (needsProjectIndex && !isRustAnalyzerServer) {
				await waitForProjectLoaded(client, signal);
			}

			switch (action) {
				// =====================================================================
				// Standard LSP Operations
				// =====================================================================

				case "definition": {
					const result = (await sendRequest(
						client,
						"textDocument/definition",
						{
							textDocument: { uri },
							position,
						},
						signal,
					)) as Location | Location[] | LocationLink | LocationLink[] | null;

					const locations = normalizeLocationResult(result);

					if (locations.length === 0) {
						output = "No definition found";
						useless = true;
					} else {
						const lines = await Promise.all(
							locations.map(location => formatLocationWithContext(location, this.session.cwd)),
						);
						output = `Found ${locations.length} definition(s):\n${lines.join("\n")}`;
					}
					break;
				}

				case "type_definition": {
					const result = (await sendRequest(
						client,
						"textDocument/typeDefinition",
						{
							textDocument: { uri },
							position,
						},
						signal,
					)) as Location | Location[] | LocationLink | LocationLink[] | null;

					const locations = normalizeLocationResult(result);

					if (locations.length === 0) {
						output = "No type definition found";
						useless = true;
					} else {
						const lines = await Promise.all(
							locations.map(location => formatLocationWithContext(location, this.session.cwd)),
						);
						output = `Found ${locations.length} type definition(s):\n${lines.join("\n")}`;
					}
					break;
				}

				case "implementation": {
					const result = (await sendRequest(
						client,
						"textDocument/implementation",
						{
							textDocument: { uri },
							position,
						},
						signal,
					)) as Location | Location[] | LocationLink | LocationLink[] | null;

					const locations = normalizeLocationResult(result);

					if (locations.length === 0) {
						output = "No implementation found";
						useless = true;
					} else {
						const lines = await Promise.all(
							locations.map(location => formatLocationWithContext(location, this.session.cwd)),
						);
						output = `Found ${locations.length} implementation(s):\n${lines.join("\n")}`;
					}
					break;
				}
				case "references": {
					let result: Location[] | null = null;
					for (let attempt = 0; attempt <= REFERENCES_RETRY_COUNT; attempt++) {
						result = (await sendRequest(
							client,
							"textDocument/references",
							{
								textDocument: { uri },
								position,
								context: { includeDeclaration: true },
							},
							signal,
						)) as Location[] | null;

						const locations = result ?? [];
						if (!isProjectAwareLspServer(serverConfig) || attempt === REFERENCES_RETRY_COUNT) {
							break;
						}
						if (locations.length > 0 && !isOnlyQueriedDeclaration(locations, uri, position)) {
							break;
						}

						await waitForProjectLoaded(client, signal);
						throwIfAborted(signal);
						await untilAborted(signal, () => Bun.sleep(REFERENCES_RETRY_DELAY_MS));
					}

					if (!result || result.length === 0) {
						output = "No references found";
						useless = true;
					} else {
						const contextualReferences = result.slice(0, REFERENCE_CONTEXT_LIMIT);
						const plainReferences = result.slice(REFERENCE_CONTEXT_LIMIT);
						const contextualLines = await Promise.all(
							contextualReferences.map(location => formatLocationWithContext(location, this.session.cwd)),
						);
						const plainLines = plainReferences.map(location => `  ${formatLocation(location, this.session.cwd)}`);
						const lines = plainLines.length
							? [
									...contextualLines,
									`  ... ${plainLines.length} additional reference(s) shown without context`,
									...plainLines,
								]
							: contextualLines;
						output = `Found ${result.length} reference(s):\n${lines.join("\n")}`;
					}
					break;
				}

				case "hover": {
					const result = (await sendRequest(
						client,
						"textDocument/hover",
						{
							textDocument: { uri },
							position,
						},
						signal,
					)) as Hover | null;

					if (!result?.contents) {
						output = "No hover information";
					} else {
						output = extractHoverText(result.contents);
					}
					break;
				}

				case "code_actions": {
					const diagnostics = client.diagnostics.get(uri)?.diagnostics ?? [];
					const context: CodeActionContext = {
						diagnostics,
						only: !apply && query ? [query] : undefined,
						triggerKind: 1,
					};

					const result = (await sendRequest(
						client,
						"textDocument/codeAction",
						{
							textDocument: { uri },
							range: { start: position, end: position },
							context,
						},
						signal,
					)) as (CodeAction | Command)[] | null;

					if (!result || result.length === 0) {
						output = "No code actions available";
						break;
					}

					if (apply === true && query) {
						const normalizedQuery = query.trim();
						if (normalizedQuery.length === 0) {
							output = "Error: query parameter required when apply=true for code_actions";
							break;
						}
						const parsedIndex = /^\d+$/.test(normalizedQuery) ? Number.parseInt(normalizedQuery, 10) : null;
						const selectedAction =
							parsedIndex !== null
								? result[parsedIndex]
								: result.find(actionItem =>
										actionItem.title.toLowerCase().includes(normalizedQuery.toLowerCase()),
									);

						if (!selectedAction) {
							const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
							output = `No code action matches "${normalizedQuery}". Available actions:\n${actionLines.join("\n")}`;
							break;
						}

						const appliedAction = await applyCodeAction(selectedAction, {
							resolveCodeAction: async actionItem =>
								(await sendRequest(client, "codeAction/resolve", actionItem, signal)) as CodeAction,
							applyWorkspaceEdit: async edit => applyWorkspaceEdit(edit, this.session.cwd),
							executeCommand: async commandItem => {
								await sendRequest(
									client,
									"workspace/executeCommand",
									{
										command: commandItem.command,
										arguments: commandItem.arguments ?? [],
									},
									signal,
								);
							},
						});

						if (!appliedAction) {
							output = `Action "${selectedAction.title}" has no workspace edit or command to apply`;
							break;
						}

						const summaryLines: string[] = [];
						if (appliedAction.edits.length > 0) {
							summaryLines.push("  Workspace edit:");
							summaryLines.push(...appliedAction.edits.map(item => `    ${item}`));
						}
						if (appliedAction.executedCommands.length > 0) {
							summaryLines.push("  Executed command(s):");
							summaryLines.push(...appliedAction.executedCommands.map(commandName => `    ${commandName}`));
						}

						output = `Applied "${appliedAction.title}":\n${summaryLines.join("\n")}`;
						break;
					}

					const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
					output = `${result.length} code action(s):\n${actionLines.join("\n")}`;
					break;
				}
				case "symbols": {
					if (!targetFile) {
						output = "Error: file parameter required for document symbols";
						break;
					}
					// File-based document symbols
					const result = (await sendRequest(
						client,
						"textDocument/documentSymbol",
						{
							textDocument: { uri },
						},
						signal,
					)) as (DocumentSymbol | SymbolInformation)[] | null;

					if (!result || result.length === 0) {
						output = "No symbols found";
						useless = true;
					} else {
						const relPath = formatPathRelativeToCwd(targetFile, this.session.cwd);
						if ("selectionRange" in result[0]) {
							const lines = (result as DocumentSymbol[]).flatMap(s => formatDocumentSymbol(s));
							output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
						} else {
							const lines = (result as SymbolInformation[]).map(s => {
								const line = s.location.range.start.line + 1;
								const icon = symbolKindToIcon(s.kind);
								return `${icon} ${s.name} @ line ${line}`;
							});
							output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
						}
					}
					break;
				}

				case "rename": {
					if (!new_name) {
						return {
							content: [{ type: "text", text: "Error: new_name parameter required for rename" }],
							details: { action, serverName, success: false },
						};
					}

					const result = (await sendRequest(
						client,
						"textDocument/rename",
						{
							textDocument: { uri },
							position,
							newName: new_name,
						},
						signal,
					)) as WorkspaceEdit | null;

					if (!result) {
						output = "Rename returned no edits";
					} else {
						const shouldApply = apply !== false;
						if (shouldApply) {
							const applied = await applyWorkspaceEdit(result, this.session.cwd);
							output = `Applied rename:\n${applied.map(a => `  ${a}`).join("\n")}`;
						} else {
							const preview = formatWorkspaceEdit(result, this.session.cwd);
							output = `Rename preview:\n${preview.map(p => `  ${p}`).join("\n")}`;
						}
					}
					break;
				}

				case "reload": {
					output = await reloadServer(client, serverName, signal);
					break;
				}

				default:
					output = `Unknown action: ${action}`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: { serverName, action, success: true, request: params },
				...(useless ? { useless: true } : {}),
			};
		} catch (err) {
			if (err instanceof ToolError) throw err;
			if (err instanceof ToolAbortError || signal?.aborted) {
				// Distinguish a wall-clock timeout from a caller cancel:
				// callerSignal aborting → real cancel (re-throw ToolAbortError);
				// timeoutSignal aborting without callerSignal → emit a ToolError naming the
				// elapsed budget and server, instead of opaque "Operation aborted".
				if (timeoutSignal.aborted && !callerSignal?.aborted) {
					throw new ToolError(
						`LSP ${action} timed out after ${timeoutSec}s on ${serverName}. The server may still be indexing; try again or pass timeout=<larger>.`,
					);
				}
				throw new ToolAbortError();
			}
			const errorMessage = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `LSP error: ${errorMessage}` }],
				details: { serverName, action, success: false, request: params },
			};
		}
	}
}
