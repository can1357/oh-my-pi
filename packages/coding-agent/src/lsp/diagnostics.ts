import { type FileDiagnosticsResult } from "@oh-my-pi/pi-tui/tools/lsp";
import * as fs from "node:fs";
import path from "node:path";
import { isRecord, logger, untilAborted } from "@oh-my-pi/pi-utils";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { throwIfAborted } from "../tools/tool-errors";
import {
	getOrCreateClient,
	LspRequestTimeoutError,
	LspResponseError,
	sendRequest,
	supportsDocumentDiagnostics,
	waitForProjectLoaded,
} from "./client";
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
export const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
const DIAGNOSTICS_POLL_MS = 100;
/** Build-status notifications for a document that did not change arrive ~10–90 ms apart. */
const BUILD_STATUS_POLL_MS = 20;
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

/**
 * Per-server wait budget (ms) for late post-edit diagnostics: at least
 * {@link DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS}, raised to `lsp.requestTimeout`
 * so a server still loading its project on a cold start delivers late instead of
 * being dropped.
 */
export function deferredDiagnosticsWaitMs(requestTimeoutSec: number | undefined): number {
	return Math.max(DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS, (requestTimeoutSec ?? 0) * 1000);
}
export const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
export const WORKSPACE_SYMBOL_LIMIT = 200;

/**
 * Summary for a file some servers sent no fresh report on, appended to the summary of
 * the reports that did arrive, so the file never reads as clean.
 */
export function unreportedSummary(servers: readonly string[], reported?: string): string {
	const unverified = `no diagnostics report yet from ${servers.join(", ")}`;
	return reported ? `${reported}; ${unverified}` : unverified;
}

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
	/**
	 * Hold the wait while the server loads its project, once it supports pulls: a pull
	 * during load answers from a half-loaded project (rust-analyzer: an empty report).
	 * The budget restarts when the load settles, as if the caller had waited first.
	 * Push-only servers are never held.
	 */
	afterProjectLoad?: boolean;
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

/** JSON-RPC `ContentModified`: the document changed while the server computed its answer. */
const LSP_CONTENT_MODIFIED = -32801;
/** JSON-RPC `ServerCancelled`; on a diagnostic pull, `data.retriggerRequest` says whether to ask again. */
const LSP_SERVER_CANCELLED = -32802;

/**
 * Whether a failed pull asks to be retried rather than reporting a failure. rust-analyzer,
 * for one, cancels pulls with `retriggerRequest: true` while it primes caches after start.
 */
function shouldRetriggerPull(failure: unknown): boolean {
	if (!(failure instanceof LspResponseError)) return false;
	if (failure.code === LSP_CONTENT_MODIFIED) return true;
	if (failure.code !== LSP_SERVER_CANCELLED) return false;
	return !(isRecord(failure.data) && failure.data.retriggerRequest === false);
}

/**
 * Whether a failed pull means the server failed, not that its report is still missing:
 * a pull the server asks to have retried, or one it was still computing when the wait's
 * budget ran out, leaves the file unverified.
 */
function isPullFailure(failure: unknown): boolean {
	return !(failure instanceof LspRequestTimeoutError) && !shouldRetriggerPull(failure);
}

function isProvisionalColdPublish(
	client: LspClient,
	uri: string,
	published: PublishedDiagnostics,
	expectedDocumentVersion: number | undefined,
	now: number,
): boolean {
	if (expectedDocumentVersion === undefined) return false;
	// A document OMP closed and reopened can still receive publishes from before the
	// close: the empty one that cleared it, or one versioned for its earlier life.
	const reopenedAt = client.openFiles.get(uri)?.reopenedAt;
	if (reopenedAt !== undefined && now - reopenedAt < DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS) {
		if (published.diagnostics.length === 0) return true;
		if (published.version !== null && published.version < expectedDocumentVersion) return true;
	}
	if (published.diagnostics.length > 0) return false;
	return (
		published.version === null &&
		client.startedAt !== undefined &&
		now - client.startedAt < DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS
	);
}

/**
 * Wait for a fresh diagnostics report for `uri`: a pull answer, or a publish that
 * passes the freshness checks. Resolves `undefined` when none arrives within the
 * budget, which callers MUST NOT read as a clean file; `[]` is a clean report.
 */
export async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[] | undefined> {
	const {
		timeoutMs = 3000,
		signal,
		minVersion,
		expectedDocumentVersion,
		settleMs = DIAGNOSTICS_SETTLE_MS,
		afterProjectLoad = false,
	} = options;
	let deadline = Date.now() + timeoutMs;
	let awaitingProjectLoad = afterProjectLoad;
	// When to send the next pull; `undefined` once one is in flight or answered.
	let nextPullAt: number | undefined = 0;
	let pullResultPromise: Promise<PullDiagnosticsOutcome> | undefined;
	let pulled: Diagnostic[] | undefined;
	let pullFailure: unknown;
	let settledRef: PublishedDiagnostics | undefined;
	let settledAt = 0;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		// Decided per turn: a server can register pulls after the wait began (Roslyn).
		if (awaitingProjectLoad && supportsDocumentDiagnostics(client)) {
			awaitingProjectLoad = false;
			// Also waits out rust-analyzer's workspace load, which outlasts its `$/progress`.
			await waitForProjectLoaded(client, signal);
			throwIfAborted(signal);
			deadline = Math.max(deadline, Date.now() + timeoutMs);
		}
		if (nextPullAt !== undefined && Date.now() >= nextPullAt && supportsDocumentDiagnostics(client)) {
			nextPullAt = undefined;
			pullResultPromise = requestDocumentDiagnostics(client, uri, signal, Math.max(1, deadline - Date.now()));
		}

		const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
		const published = client.diagnostics.get(uri);
		if (published && versionOk) {
			// Server honored our exact document version → authoritative, accept now.
			if (expectedDocumentVersion !== undefined && published.version === expectedDocumentVersion) {
				return published.diagnostics;
			}
			// An empty unversioned publish from a newly started server is often its
			// pre-analysis placeholder, and a publish for a reopened document may
			// predate its close. Keep waiting so the writethrough
			// crosses its inline deadline and preserves this fetch for deferred delivery.
			const now = Date.now();
			if (published !== settledRef) {
				settledRef = published;
				settledAt = now;
			} else if (
				now - settledAt >= settleMs &&
				!isProvisionalColdPublish(client, uri, published, expectedDocumentVersion, now)
			) {
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
				if (shouldRetriggerPull(pullResult.failed)) {
					// The server asked to be asked again.
					nextPullAt = Date.now() + DIAGNOSTICS_POLL_MS;
				} else if (isPullFailure(pullResult.failed)) {
					// A pull failure leaves the report unknown, but a dual-mode server
					// may still publish fresh diagnostics within the remaining budget.
					pullFailure = pullResult.failed;
				}
			}
		}
	}

	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	const published = client.diagnostics.get(uri);
	if (published && versionOk) {
		if (expectedDocumentVersion !== undefined && published.version === expectedDocumentVersion) {
			return published.diagnostics;
		}
		const now = Date.now();
		if (
			published === settledRef &&
			now - settledAt >= settleMs &&
			!isProvisionalColdPublish(client, uri, published, expectedDocumentVersion, now)
		) {
			return published.diagnostics;
		}
	}
	if (pullResultPromise) {
		const outcome = await pullResultPromise;
		if (outcome.diagnostics !== undefined) pulled = outcome.diagnostics;
		else if (outcome.failed !== undefined && isPullFailure(outcome.failed)) pullFailure = outcome.failed;
	}
	throwIfAborted(signal);
	if (pulled === undefined) {
		// A pull the server failed leaves the file's state unknown; never let it
		// collapse into a clean empty result the caller renders as "OK".
		if (pullFailure !== undefined) {
			throw pullFailure instanceof Error ? pullFailure : new Error(String(pullFailure));
		}
		return undefined;
	}
	client.diagnostics.set(uri, {
		diagnostics: pulled,
		version: expectedDocumentVersion ?? client.openFiles.get(uri)?.version ?? null,
	});
	client.diagnosticsVersion += 1;
	return pulled;
}

interface WaitForRebuiltDiagnosticsOptions {
	/** Document version `rebuildFile` left the server on. */
	version: number;
	/** `client.buildStatusSeq` read before the rebuild was sent. */
	sinceSeq: number;
	timeoutMs: number;
	signal?: AbortSignal;
}

/**
 * Wait for clangd's report on a document `rebuildFile` rebuilt. clangd can publish the
 * rebuilt version twice: first against its cached headers, then again once it has rebuilt a
 * header that changed on disk, so the first matching publish is not final. The report is
 * final once the document's build status went busy and back to idle after the rebuild, and
 * a request queued behind that build has answered. Resolves `undefined` when that does not
 * happen within the budget, which callers MUST NOT read as a clean file.
 */
export async function waitForRebuiltDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForRebuiltDiagnosticsOptions,
): Promise<Diagnostic[] | undefined> {
	const { version, sinceSeq, timeoutMs, signal } = options;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		throwIfAborted(signal);
		const status = client.buildStatus?.get(uri);
		if (status && status.busySeq > sinceSeq && status.idleSeq > status.busySeq) break;
		const left = deadline - Date.now();
		if (left <= 0) return undefined;
		await Bun.sleep(Math.min(BUILD_STATUS_POLL_MS, left));
	}
	// clangd turns idle once its header check ends, which can precede the publish of the AST
	// built against rebuilt headers; a document request queues behind that build.
	try {
		await sendRequest(
			client,
			"textDocument/documentSymbol",
			{ textDocument: { uri } },
			signal,
			Math.max(1, deadline - Date.now()),
		);
	} catch {
		throwIfAborted(signal);
		return undefined;
	}
	const published = client.diagnostics.get(uri);
	return published?.version === version ? published.diagnostics : undefined;
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
				// Content already synced + didSave sent, wait for fresh diagnostics
				const minVersion = minVersions?.get(serverName);
				const expectedDocumentVersion = expectedDocumentVersions?.get(serverName);
				const diagnostics = await waitForDiagnostics(client, uri, {
					timeoutMs: waitBudgetMs,
					signal: boundSignal,
					minVersion,
					expectedDocumentVersion,
					afterProjectLoad: isProjectAwareLspServer(serverConfig),
				});
				return { serverName, serverConfig, diagnostics };
			});
		}),
	);

	const unreported: string[] = [];
	for (const result of results) {
		if (result.status !== "fulfilled") continue;
		// A server that sent no fresh report leaves the file unverified: counting it
		// as a server that answered would report the file as clean.
		if (result.value.diagnostics === undefined) {
			unreported.push(result.value.serverName);
			continue;
		}
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

	if (serverNames.length === 0 && unreported.length === 0) {
		return undefined;
	}
	const server = [...serverNames, ...unreported].join(", ");
	const unreportedField = unreported.length > 0 ? unreported : undefined;

	if (allDiagnostics.length === 0) {
		return {
			server,
			messages: [],
			summary: unreportedField ? unreportedSummary(unreportedField) : "OK",
			errored: false,
			unreported: unreportedField,
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
		server,
		messages: limited,
		summary: unreportedField ? unreportedSummary(unreportedField, summary) : summary,
		errored: hasErrors,
		unreported: unreportedField,
	};
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

	// Prefer dedicated formatter/linter servers (`isLinter`) over type-checkers
	// when choosing who formats. A type-checker such as tsserver also advertises
	// `documentFormattingProvider` but only reindents; without this preference a
	// configured external formatter (prettier via efm-langserver, ruff, dprint,
	// gofumpt) could never win for a file type the type-checker also claims,
	// since the loop returns at the first formatting-capable server. The sort is
	// stable, so same-class ordering (and the type-checker-first order used for
	// type-intelligence in `getServerForFile`) is otherwise preserved.
	const ordered =
		servers.length > 1 ? [...servers].sort((a, b) => (a[1].isLinter ? 0 : 1) - (b[1].isLinter ? 0 : 1)) : servers;

	for (const [serverName, serverConfig] of ordered) {
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
