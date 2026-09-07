import * as fs from "node:fs";
import { isEnoent, logger, once, untilAborted } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import { isPermissionDeniedError, writeFileWithFallback } from "../tools/file-write-fallback";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "./client";
import { getServersForFile } from "./config";
import {
	captureDiagnosticVersions,
	captureOpenFileVersions,
	DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	type FileDiagnosticsResult,
	FileFormatResult,
	formatContent,
	getDiagnosticsForFile,
	INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	limitDiagnosticMessages,
	type ServerVersionMap,
} from "./diagnostics";
import { getConfig, notifyFileSaved, splitServers, syncFileContent } from "./servers";
import type { ServerConfig } from "./types";
import { summarizeDiagnosticMessages } from "./utils";

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

export interface WritethroughResult {
	diagnostics?: FileDiagnosticsResult;
	finalContent: string;
}

/** Callback type for the LSP writethrough */
export type WritethroughCallback = (
	dst: string,
	content: string,
	signal?: AbortSignal,
	file?: BunFile,
	batch?: LspWritethroughBatchRequest,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<WritethroughResult>;

/** No-op writethrough callback */
export async function writethroughNoop(
	dst: string,
	content: string,
	_signal?: AbortSignal,
	file?: BunFile,
	_batch?: LspWritethroughBatchRequest,
	_getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<WritethroughResult> {
	await writeFileWithFallback(dst, content, file);
	return { finalContent: content };
}

interface PendingWritethrough {
	dst: string;
	file?: BunFile;
	changeType: FileChangeType;
	/**
	 * The bytes this entry committed. The flush prefers a fresh read of `dst` so
	 * post-processing sees whatever else in the batch touched the file, and falls
	 * back to these when that read is denied.
	 */
	content: string;
}

interface RunLspWritethroughOptions {
	contentAlreadyWritten?: boolean;
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
	return (await flushWritethroughBatch(Array.from(state.entries.values()), "", cwd, state.options, signal))
		.diagnostics;
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
	let hasFailed = false;
	let hasUnsupported = false;

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
			} else if (result.formatter === FileFormatResult.FAILED) {
				hasFailed = true;
			} else if (result.formatter === FileFormatResult.UNSUPPORTED) {
				hasUnsupported = true;
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
	// Priority: FAILED > FORMATTED > UNCHANGED > UNSUPPORTED
	const formatter = hasFormatter
		? hasFailed
			? FileFormatResult.FAILED
			: formatted
				? FileFormatResult.FORMATTED
				: hasUnsupported && !formatted
					? FileFormatResult.UNSUPPORTED
					: FileFormatResult.UNCHANGED
		: undefined;

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
	changeType: FileChangeType,
	signal?: AbortSignal,
	file?: BunFile,
	deferred?: {
		onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
		signal: AbortSignal;
	},
	runOptions?: RunLspWritethroughOptions,
): Promise<WritethroughResult> {
	const { enableFormat, enableDiagnostics } = options;
	const contentAlreadyWritten = runOptions?.contentAlreadyWritten ?? false;

	let finalContent = content;
	const writeContent = async (value: string) => writeFileWithFallback(dst, value, file);
	const getWritePromise = once(() =>
		contentAlreadyWritten && finalContent === content ? Promise.resolve() : writeContent(finalContent),
	);
	let writeNotified = false;
	const notifyWriteCommitted = async (notifySignal: AbortSignal | undefined = signal) => {
		if (writeNotified) return;
		writeNotified = true;
		try {
			await notifyWorkspaceWatchedFiles(cwd, [{ filePath: dst, type: changeType }], notifySignal);
		} catch (error) {
			if (notifySignal?.aborted && !signal?.aborted) {
				// The operation budget died mid-notify while the caller is still
				// live: allow the post-write retry below to re-announce with the
				// caller's signal (didChangeWatchedFiles is idempotent).
				writeNotified = false;
				return;
			}
			throw error;
		}
	};
	if (!enableFormat && !enableDiagnostics) {
		await getWritePromise();
		await notifyWriteCommitted();
		return { finalContent, diagnostics: undefined };
	}

	const config = getConfig(cwd);
	const servers = getServersForFile(config, dst);

	if (servers.length === 0) {
		await getWritePromise();
		await notifyWriteCommitted();
		return { finalContent, diagnostics: undefined };
	}
	const { lspServers, customLinterServers } = splitServers(servers);
	const useCustomFormatter = enableFormat && customLinterServers.length > 0;

	// Capture diagnostic versions BEFORE syncing to detect stale diagnostics
	// Bound client creation by the writethrough budget: a hung/broken server
	// must not add its full init wait (30s default) to every edit.
	const minVersionsPromise = enableDiagnostics ? captureDiagnosticVersions(cwd, servers, 5_000, signal) : undefined;
	let minVersions = useCustomFormatter ? undefined : await minVersionsPromise;
	let expectedDocumentVersions: ServerVersionMap | undefined;

	let formatter: FileFormatResult | undefined;
	let diagnostics: FileDiagnosticsResult | undefined;
	let timedOut = false;
	let synced = false;
	let operationSignal: AbortSignal | undefined;
	try {
		const timeoutSignal = AbortSignal.timeout(5_000);
		timeoutSignal.addEventListener(
			"abort",
			() => {
				timedOut = true;
			},
			{ once: true },
		);
		operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		await untilAborted(operationSignal, async () => {
			if (useCustomFormatter) {
				// Custom linters operate on on-disk input; the shared pre-write also
				// supports implementations that inspect the file before formatting.
				if (!contentAlreadyWritten) await writeContent(content);
				const [formattedContent, capturedVersions] = await Promise.all([
					formatContent(dst, content, cwd, customLinterServers, operationSignal),
					minVersionsPromise,
				]);
				finalContent = formattedContent.content;
				minVersions = capturedVersions;
				if (formattedContent.failed) {
					formatter = FileFormatResult.FAILED;
				} else if (formattedContent.unsupported) {
					formatter = FileFormatResult.UNSUPPORTED;
				} else {
					formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				}
				if (!contentAlreadyWritten || finalContent !== content) await writeContent(finalContent);
				await notifyWriteCommitted(operationSignal);
				await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal, enableDiagnostics);
			} else {
				// 1. Sync original content to LSP servers
				await syncFileContent(dst, content, cwd, lspServers, operationSignal);

				// 2. Format in-memory via LSP
				if (enableFormat) {
					const formatted = await formatContent(dst, content, cwd, lspServers, operationSignal);
					finalContent = formatted.content;
					if (formatted.failed) {
						formatter = FileFormatResult.FAILED;
					} else if (formatted.unsupported) {
						formatter = FileFormatResult.UNSUPPORTED;
					} else {
						formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
					}
				}

				// 3. If formatted, sync formatted content to LSP servers
				if (finalContent !== content) {
					await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
				}

				// 4. Write to disk
				await getWritePromise();
				await notifyWriteCommitted(operationSignal);
			}

			if (enableDiagnostics) {
				expectedDocumentVersions = await captureOpenFileVersions(dst, cwd, lspServers, operationSignal);
			}

			// 5. Notify saved to LSP servers
			await notifyFileSaved(dst, cwd, lspServers, operationSignal, !useCustomFormatter || enableDiagnostics);
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
		// The write above committed even though the operation budget elapsed:
		// announce it on the caller's signal — the dead `operationSignal` would
		// abort the notify before it ever reaches the server.
		await notifyWriteCommitted();
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

	return { finalContent, diagnostics };
}

async function flushWritethroughBatch(
	batch: PendingWritethrough[],
	requestedDst: string | undefined,
	cwd: string,
	options: ResolvedWritethroughOptions,
	signal?: AbortSignal,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<WritethroughResult> {
	if (batch.length === 0) {
		return { finalContent: "" };
	}
	const results: Array<FileDiagnosticsResult | undefined> = [];
	const finalContents = new Map<string, string>();
	for (const entry of batch) {
		const bundle = getDeferred?.(entry.dst);
		let content: string;
		try {
			content = await fs.promises.readFile(entry.dst, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				bundle?.finalize(undefined);
				continue;
			}
			// A brokered write may deny read-back even after the write succeeds.
			// Keep the committed request content as the source for diagnostics.
			if (!isPermissionDeniedError(error)) throw error;
			content = entry.content;
		}
		const deferredInner =
			bundle &&
			({
				onDeferredDiagnostics: bundle.onDeferredDiagnostics,
				signal: bundle.signal,
			} as const);
		const diag = await runLspWritethrough(
			entry.dst,
			content,
			cwd,
			options,
			entry.changeType,
			signal,
			entry.file,
			deferredInner,
			{ contentAlreadyWritten: true },
		);
		finalContents.set(entry.dst, diag.finalContent);
		bundle?.finalize(diag.diagnostics);
		results.push(diag.diagnostics);
	}
	const finalContent = requestedDst
		? (finalContents.get(requestedDst) ?? batch.find(entry => entry.dst === requestedDst)?.content ?? "")
		: "";
	return {
		finalContent,
		diagnostics: mergeDiagnostics(results, options),
	};
}

/** Create a writethrough callback for LSP aware write operations */
export function createLspWritethrough(cwd: string, options?: WritethroughOptions): WritethroughCallback {
	const resolvedOptions: ResolvedWritethroughOptions = {
		enableFormat: options?.enableFormat ?? false,
		enableDiagnostics: options?.enableDiagnostics ?? false,
		transformDiagnostics: options?.transformDiagnostics,
	};
	return async (
		dst: string,
		content: string,
		signal?: AbortSignal,
		file?: BunFile,
		batch?: LspWritethroughBatchRequest,
		getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
	) => {
		const changeType = (await Bun.file(dst).exists()) ? FileChangeType.Changed : FileChangeType.Created;
		if (!batch) {
			const bundle = getDeferred?.(dst);
			const deferredInner =
				bundle &&
				({
					onDeferredDiagnostics: bundle.onDeferredDiagnostics,
					signal: bundle.signal,
				} as const);
			const diagnostics = await runLspWritethrough(
				dst,
				content,
				cwd,
				resolvedOptions,
				changeType,
				signal,
				file,
				deferredInner,
			);
			bundle?.finalize(diagnostics.diagnostics);
			return diagnostics;
		}

		// File commits are never deferred: the batch owns only LSP post-processing,
		// so a later flush cannot replay an obsolete whole-file snapshot.
		try {
			await writethroughNoop(dst, content, signal, file);
		} catch (error) {
			if (batch.flush) {
				const pending = writethroughBatches.get(batch.id);
				if (pending) {
					writethroughBatches.delete(batch.id);
					try {
						await flushWritethroughBatch(
							Array.from(pending.entries.values()),
							"",
							cwd,
							pending.options,
							signal,
							getDeferred,
						);
					} catch (flushError) {
						logger.warn("Failed to flush pending LSP batch after final write failure", {
							batchId: batch.id,
							error: flushError instanceof Error ? flushError.message : String(flushError),
						});
					}
				}
			}
			throw error;
		}

		const state = getOrCreateWritethroughBatch(batch.id, resolvedOptions);
		state.entries.set(dst, { dst, file, changeType, content });
		if (!batch.flush) return { finalContent: content };
		writethroughBatches.delete(batch.id);
		const result = await flushWritethroughBatch(
			Array.from(state.entries.values()),
			dst,
			cwd,
			state.options,
			signal,
			getDeferred,
		);
		return result;
	};
}
