import * as fs from "node:fs";
import path from "node:path";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { throwIfAborted } from "../tools/tool-errors";
import { getOrCreateClient, sendRequest, supportsDocumentDiagnostics, waitForProjectLoaded } from "./client";
import { getLinterClient } from "./clients";
import { hasRootMarkerAncestor } from "./config";
import { applyTextEditsToString } from "./edits";
import { resolveFormatOptions } from "./format-options";
import { isProjectAwareLspServer } from "./servers";
import type {
	Diagnostic,
	Location,
	LocationLink,
	LspClient,
	Position,
	PublishedDiagnostics,
	ServerConfig,
	TextEdit,
} from "./types";
import {
	fileToUri,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatLocation,
	readLocationContext,
	sortDiagnostics,
	uriToFile,
} from "./utils";

const DIAGNOSTIC_MESSAGE_LIMIT = 50;
export const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
/**
 * Single-file diagnostics wait budget for project-aware servers (Roslyn, tsserver, …).
 * Their first pull-diagnostic response computes analysis on demand and routinely
 * takes several seconds, overrunning {@link SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS};
 * an explicit `lsp diagnostics` request can afford to wait, so give it more room
 * (still capped by the tool-level timeout).
 */
export const PROJECT_DIAGNOSTICS_WAIT_TIMEOUT_MS = 10_000;
export const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
const DIAGNOSTICS_POLL_MS = 100;
const DIAGNOSTICS_SETTLE_MS = 250;
/**
 * How long the edit/write writethrough blocks inline waiting for fresh
 * diagnostics before handing slow servers off to the deferred late-injection
 * channel. Keeps the common fast-server case inline while letting an edit
 * return promptly when a server (e.g. a large-monorepo tsserver) is slow to
 * publish fresh diagnostics.
 */
export const INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 500;
/**
 * Inner per-server diagnostics wait budget for the background/deferred fetch.
 * Longer than the inline cap (and the old 3s default) so a slow server still
 * delivers late instead of giving up before it ever publishes.
 */
export const DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS = 12_000;
/**
 * Extra wall-clock headroom granted to each per-server diagnostics pipeline on
 * top of its diagnostics wait budget. The pipeline includes client creation
 * (spawn + initialize), project load, and custom linter runs — steps that have
 * no own deadline when the caller passes a user-abort-only signal (the edit
 * tool does exactly that: `sendRequest` skips its default timeout whenever a
 * signal is present). A wedged server or hung linter subprocess then blocks
 * the edit forever, and because the edit tool is `exclusive`, every later edit
 * queues behind it (issue #4910). This grace period turns that infinite hang
 * into a bounded skip: the slow server is dropped from this round's results
 * and the edit returns.
 */
export const DIAGNOSTICS_PIPELINE_GRACE_MS = 10_000;
export const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
export const WORKSPACE_SYMBOL_LIMIT = 200;
export const PROJECT_INDEXED_ACTIONS: ReadonlySet<string> = new Set([
	"definition",
	"type_definition",
	"implementation",
	"references",
	"rename",
	"hover",
]);

const RUST_WORKSPACE_MARKERS = ["Cargo.toml", "rust-analyzer.toml"] as const;

export function hasRustWorkspaceAncestor(filePath: string): boolean {
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

export function limitDiagnosticMessages(messages: string[]): string[] {
	if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
		return messages;
	}
	return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}

const ORPHAN_TYPESCRIPT_PROJECT_DIAGNOSTIC_CODES: Record<number, true> = {
	1375: true,
	1378: true,
	2307: true,
	2580: true,
	2591: true,
	2792: true,
	2867: true,
};

function diagnosticCodeNumber(diagnostic: Diagnostic): number | null {
	if (typeof diagnostic.code === "number") return diagnostic.code;
	if (typeof diagnostic.code === "string" && /^\d+$/.test(diagnostic.code)) return Number(diagnostic.code);
	return null;
}
function isTypeScriptProjectDiagnostic(serverName: string, diagnostic: Diagnostic): boolean {
	if (diagnostic.source !== "typescript" && !serverName.toLowerCase().includes("typescript")) {
		return false;
	}
	const code = diagnosticCodeNumber(diagnostic);
	return code !== null && ORPHAN_TYPESCRIPT_PROJECT_DIAGNOSTIC_CODES[code] === true;
}

function filterOrphanProjectDiagnostics(
	absolutePath: string,
	serverName: string,
	serverConfig: ServerConfig,
	diagnostics: Diagnostic[],
): Diagnostic[] {
	if (!serverConfig.rootMarkers.length || hasRootMarkerAncestor(absolutePath, serverConfig.rootMarkers)) {
		return diagnostics;
	}
	return diagnostics.filter(diagnostic => !isTypeScriptProjectDiagnostic(serverName, diagnostic));
}

const LOCATION_CONTEXT_LINES = 1;
export const REFERENCE_CONTEXT_LIMIT = 50;

export const REFERENCES_RETRY_COUNT = 2;
export const REFERENCES_RETRY_DELAY_MS = 250;

function comparePosition(a: Position, b: Position): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function rangeContainsPosition(range: Location["range"], position: Position): boolean {
	return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

export function isOnlyQueriedDeclaration(locations: Location[], uri: string, position: Position): boolean {
	return locations.length === 1 && locations[0]?.uri === uri && rangeContainsPosition(locations[0].range, position);
}

export function normalizeLocationResult(
	result: Location | Location[] | LocationLink | LocationLink[] | null,
): Location[] {
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

export async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
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

/**
 * Outcome of one document pull-diagnostic request.
 *
 * Distinguishes a usable report from a failed request so a timeout or RPC error
 * is never mistaken for a clean file. `diagnostics` holds the report's items (an
 * empty array means the server reported the file clean); `failed` carries the
 * error when the pull could not complete.
 */
interface PullDiagnosticsOutcome {
	diagnostics?: Diagnostic[];
	failed?: unknown;
}

function requestDocumentDiagnostics(
	client: LspClient,
	uri: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<PullDiagnosticsOutcome> {
	return sendRequest(client, "textDocument/diagnostic", { textDocument: { uri } }, signal, timeoutMs)
		.then(report => {
			if (!report || typeof report !== "object" || !("kind" in report) || report.kind !== "full") {
				return {};
			}
			if (!("items" in report) || !Array.isArray(report.items)) return {};
			return { diagnostics: report.items };
		})
		.catch(err => {
			if (!signal?.aborted) {
				logger.debug("LSP document diagnostic pull failed", { server: client.name, uri, error: String(err) });
			}
			return { failed: err };
		});
}

export async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, settleMs = DIAGNOSTICS_SETTLE_MS } = options;
	const deadline = Date.now() + timeoutMs;
	let pullAttempted = false;
	let pullResultPromise: Promise<PullDiagnosticsOutcome> | undefined;
	let pulled: Diagnostic[] | undefined;
	let pullFailure: unknown;
	let settledRef: PublishedDiagnostics | undefined;
	let settledAt = 0;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		if (!pullAttempted && supportsDocumentDiagnostics(client)) {
			pullAttempted = true;
			pullResultPromise = requestDocumentDiagnostics(client, uri, signal, Math.max(1, deadline - Date.now()));
		}

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

		const pollMs = Math.min(DIAGNOSTICS_POLL_MS, Math.max(0, deadline - Date.now()));
		if (!pullResultPromise) {
			await Bun.sleep(pollMs);
			continue;
		}
		const pullResult = await Promise.race([pullResultPromise, Bun.sleep(pollMs).then(() => undefined)]);
		if (pullResult) {
			pullResultPromise = undefined;
			if (pullResult.diagnostics !== undefined) {
				pulled = pullResult.diagnostics;
				break;
			}
			if (pullResult.failed !== undefined) {
				// A pull failure leaves the report unknown, but a dual-mode server
				// may still publish fresh diagnostics within the remaining budget.
				pullFailure = pullResult.failed;
			}
		}
	}

	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	const published = client.diagnostics.get(uri);
	if (published && versionOk) {
		if (expectedDocumentVersion !== undefined && published.version === expectedDocumentVersion) {
			return published.diagnostics;
		}
		if (published === settledRef && Date.now() - settledAt >= settleMs) {
			return published.diagnostics;
		}
	}
	if (pullResultPromise) {
		const outcome = await pullResultPromise;
		if (outcome.diagnostics !== undefined) pulled = outcome.diagnostics;
		else if (outcome.failed !== undefined) pullFailure = outcome.failed;
	}
	throwIfAborted(signal);
	if (pulled === undefined) {
		// A failed pull (timeout/RPC error) leaves the file's state unknown; never
		// let it collapse into a clean empty result the caller renders as "OK".
		if (pullFailure !== undefined) {
			throw pullFailure instanceof Error ? pullFailure : new Error(String(pullFailure));
		}
		return [];
	}
	client.diagnostics.set(uri, {
		diagnostics: pulled,
		version: expectedDocumentVersion ?? client.openFiles.get(uri)?.version ?? null,
	});
	client.diagnosticsVersion += 1;
	return pulled;
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

export type ServerVersionMap = Map<string, number>;

interface GetDiagnosticsForFileOptions {
	signal?: AbortSignal;
	minVersions?: ServerVersionMap;
	expectedDocumentVersions?: ServerVersionMap;
	/** Per-server wait budget (ms). Defaults to {@link SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS}. */
	timeoutMs?: number;
	/**
	 * Hard wall-clock bound (ms) for each server's whole pipeline (client init,
	 * project load, linting, diagnostics wait). Defaults to the wait budget plus
	 * {@link DIAGNOSTICS_PIPELINE_GRACE_MS}. Exposed as a test seam.
	 */
	pipelineBudgetMs?: number;
}

/**
 * Capture current diagnostic versions for all LSP servers.
 * Call this BEFORE syncing content to detect stale diagnostics later.
 */
export async function captureDiagnosticVersions(
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	initTimeoutMs?: number,
	signal?: AbortSignal,
): Promise<ServerVersionMap> {
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			if (serverConfig.createClient) return;
			const client = await getOrCreateClient(serverConfig, cwd, initTimeoutMs, signal);
			versions.set(serverName, client.diagnosticsVersion);
		}),
	);
	return versions;
}

export async function captureOpenFileVersions(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<ServerVersionMap> {
	const uri = fileToUri(absolutePath);
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
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
export async function getDiagnosticsForFile(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	options: GetDiagnosticsForFileOptions = {},
): Promise<FileDiagnosticsResult | undefined> {
	const { signal, minVersions, expectedDocumentVersions, timeoutMs } = options;
	if (servers.length === 0) {
		return undefined;
	}
	const waitBudgetMs = timeoutMs ?? SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS;
	const pipelineBudgetMs = options.pipelineBudgetMs ?? waitBudgetMs + DIAGNOSTICS_PIPELINE_GRACE_MS;

	const uri = fileToUri(absolutePath);
	const relPath = formatPathRelativeToCwd(absolutePath, cwd);
	const allDiagnostics: Diagnostic[] = [];
	const serverNames: string[] = [];

	// Wait for diagnostics from all servers in parallel. Each server's whole
	// pipeline is wrapped in a hard wall-clock bound: the caller's signal is
	// typically user-abort-only (never fires on its own), and both `sendRequest`
	// during client init (no default timeout when a signal is present) and
	// custom `LinterClient.lint` (no signal at all) can otherwise block forever
	// on a wedged server (issue #4910). A server that overruns its budget is
	// rejected by `untilAborted`, lands as a rejected `allSettled` entry, and is
	// simply skipped for this round — the edit still returns.
	const results = await Promise.allSettled(
		servers.map(([serverName, serverConfig]) => {
			const budgetSignal = AbortSignal.timeout(pipelineBudgetMs);
			const boundSignal = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
			return untilAborted(boundSignal, async () => {
				throwIfAborted(boundSignal);
				// Use custom linter client if configured
				if (serverConfig.createClient) {
					const linterClient = getLinterClient(serverName, serverConfig, cwd);
					const diagnostics = await linterClient.lint(absolutePath, boundSignal);
					return { serverName, serverConfig, diagnostics };
				}

				// Default: use LSP
				const client = await getOrCreateClient(serverConfig, cwd, undefined, boundSignal);
				throwIfAborted(boundSignal);
				if (isProjectAwareLspServer(serverConfig)) {
					await waitForProjectLoaded(client, boundSignal);
					throwIfAborted(boundSignal);
				}
				// Content already synced + didSave sent, wait for fresh diagnostics
				const minVersion = minVersions?.get(serverName);
				const expectedDocumentVersion = expectedDocumentVersions?.get(serverName);
				const diagnostics = await waitForDiagnostics(client, uri, {
					timeoutMs: waitBudgetMs,
					signal: boundSignal,
					minVersion,
					expectedDocumentVersion,
				});
				return { serverName, serverConfig, diagnostics };
			});
		}),
	);

	for (const result of results) {
		if (result.status === "fulfilled") {
			serverNames.push(result.value.serverName);
			allDiagnostics.push(
				...filterOrphanProjectDiagnostics(
					absolutePath,
					result.value.serverName,
					result.value.serverConfig,
					result.value.diagnostics,
				),
			);
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
	FAILED = "failed",
	UNSUPPORTED = "unsupported",
}

/**
 * Result from formatContent, distinguishing successful formatting
 * (formatted or unchanged) from a failure or unsupported file type.
 */
export type FormatContentResult = {
	content: string;
	failed: boolean;
	unsupported: boolean;
};

/**
 * Format content using LSP or custom linter client.
 *
 * @param absolutePath - Absolute path (for URI)
 * @param content - Content to format
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to try formatting with
 * @returns Formatted content, or original if no formatter available
 */
export async function formatContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<FormatContentResult> {
	if (servers.length === 0) {
		// No formatters configured at all
		return { content, failed: false, unsupported: true };
	}

	const uri = fileToUri(absolutePath);
	let hadFailure = false;

	for (const [serverName, serverConfig] of servers) {
		try {
			throwIfAborted(signal);
			// Use custom linter client if configured
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				const formattedContent = await linterClient.format(absolutePath, content);
				return { content: formattedContent, failed: false, unsupported: false };
			}

			// Default: use LSP. Initialization failures are formatter failures;
			// a successfully initialized server without formatting support is unsupported.
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			throwIfAborted(signal);

			const caps = client.serverCapabilities;
			if (!caps?.documentFormattingProvider) {
				// Server exists but doesn't support formatting; not a failure
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
				return { content, failed: false, unsupported: false };
			}

			// Apply edits in-memory and return
			return { content: applyTextEditsToString(content, edits), failed: false, unsupported: false };
		} catch {
			// A formatter was available but the request failed;
			// record the failure and try the next server
			hadFailure = true;
		}
	}

	// A failure from any applicable server takes precedence over unsupported
	// servers when no later formatter succeeds.
	return {
		content,
		failed: hadFailure,
		unsupported: !hadFailure,
	};
}
