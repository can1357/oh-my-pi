import * as fs from "node:fs";
import path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { isEnoent, isFsError, logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Theme, theme } from "../modes/theme/theme";
import lspDescription from "../prompts/tools/lsp.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { truncateForPrompt } from "../tools/approval";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/path-utils";
import { replaceTabs, shortenPath } from "../tools/render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";
import { clampTimeout } from "../tools/tool-timeouts";
import {
	applyWorkspaceEditWithLsp,
	clearInitializationFailure,
	ensureFileOpen,
	getActiveClients,
	getOrCreateClient,
	isRustAnalyzerClient,
	type LspServerStatus,
	refreshFile,
	sendNotification,
	sendRequest,
	shutdownStaleClients,
	waitForProjectLoaded,
} from "./client";
import { getLinterClient } from "./clients";
import { getServersForFile } from "./config";
import {
	BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	formatLocationWithContext,
	hasRustWorkspaceAncestor,
	isOnlyQueriedDeclaration,
	MAX_GLOB_DIAGNOSTIC_TARGETS,
	normalizeLocationResult,
	PROJECT_INDEXED_ACTIONS,
	REFERENCE_CONTEXT_LIMIT,
	REFERENCES_RETRY_COUNT,
	REFERENCES_RETRY_DELAY_MS,
	SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	WORKSPACE_SYMBOL_LIMIT,
	waitForDiagnostics,
} from "./diagnostics";
import {
	applyEditsThenRename,
	flattenWorkspaceTextEdits,
	type RenameReferenceEdit,
	rangesOverlap,
	sortAndValidateTextEdits,
} from "./edits";
import { detectLspmux } from "./lspmux";
import {
	configCache,
	getConfig,
	getLspServerForFile,
	getLspServers,
	getLspServersForFile,
	isMethodNotFoundError,
	isProjectAwareLspServer,
	LSP_READONLY_ACTIONS,
	reloadServer,
} from "./servers";
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
	resolveDiagnosticTargets,
	resolveSymbolColumn,
	sortDiagnostics,
	symbolKindToIcon,
	uriToFile,
} from "./utils";
import { runWorkspaceDiagnostics } from "./workspace-diagnostics";

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

function formatRenameStatPath(filePath: string, cwd: string): string {
	const relative = formatPathRelativeToCwd(filePath, cwd);
	// formatPathRelativeToCwd normalizes Windows separators. Shorten the
	// original native path first when it stayed absolute so home matching uses
	// the same separator form as os.homedir().
	return replaceTabs(path.isAbsolute(relative) ? shortenPath(filePath) : relative);
}

/** Filesystem error detail safe for model/TUI output: never echo raw paths. */
function formatRenameStatError(error: unknown): string {
	if (!isFsError(error)) return "unknown filesystem error";
	const syscall = error.syscall ? ` during ${replaceTabs(error.syscall)}` : "";
	return `${replaceTabs(error.code)}${syscall}`;
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
		if (this.session.lspReadOnly && !LSP_READONLY_ACTIONS.has(action)) {
			throw new ToolError(`LSP action ${action} is disabled in this read-only session`);
		}
		const timeoutSec = clampTimeout("lsp", timeout, this.session.settings.get("tools.maxTimeout"));
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
			let totalServerAttempts = 0;
			let totalServerSuccesses = 0;
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
				const failedServers: string[] = [];
				let succeededServers = 0;

				// Query all applicable servers for this file
				for (const [serverName, serverConfig] of servers) {
					allServerNames.add(serverName);
					totalServerAttempts++;
					try {
						throwIfAborted(signal);
						if (serverConfig.createClient) {
							const linterClient = getLinterClient(serverName, serverConfig, this.session.cwd);
							const diagnostics = await linterClient.lint(resolved, signal);
							allDiagnostics.push(...diagnostics);
							succeededServers++;
							totalServerSuccesses++;
							continue;
						}
						const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
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
						succeededServers++;
						totalServerSuccesses++;
					} catch (err) {
						if (err instanceof ToolAbortError || signal?.aborted) {
							throw err;
						}
						// Server failed; record it so a total failure is not reported as clean.
						failedServers.push(serverName);
						logger.debug("LSP diagnostics server failed", {
							server: serverName,
							file: relPath,
							error: err instanceof Error ? err.message : String(err),
						});
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
					if (succeededServers === 0) {
						return {
							content: [
								{
									type: "text",
									text: `${theme.status.error} ${relPath}: all language servers failed (${failedServers.join(", ")})`,
								},
							],
							details: { action, serverName: Array.from(allServerNames).join(", "), success: false },
						};
					}

					if (uniqueDiagnostics.length === 0) {
						const text =
							failedServers.length > 0
								? `OK\n${theme.status.warning} some servers failed: ${failedServers.join(", ")}`
								: "OK";
						return {
							content: [{ type: "text", text }],
							details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
						};
					}

					const summary = formatDiagnosticsSummary(uniqueDiagnostics);
					const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
					let output = `${summary}:\n${formatGroupedDiagnosticMessages(formatted)}`;
					if (failedServers.length > 0) {
						output += `\n${theme.status.warning} some servers failed: ${failedServers.join(", ")}`;
					}
					return {
						content: [{ type: "text", text: output }],
						details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
					};
				}

				if (uniqueDiagnostics.length === 0) {
					if (succeededServers === 0) {
						results.push(
							`${theme.status.error} ${relPath}: all language servers failed (${failedServers.join(", ")})`,
						);
					} else {
						results.push(`${theme.status.success} ${relPath}: no issues`);
						if (failedServers.length > 0) {
							results.push(
								`${theme.status.warning} ${relPath}: some servers failed (${failedServers.join(", ")})`,
							);
						}
					}
				} else {
					const summary = formatDiagnosticsSummary(uniqueDiagnostics);
					results.push(`${theme.status.error} ${relPath}: ${summary}`);
					const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
					results.push(formatGroupedDiagnosticMessages(formatted));
					if (failedServers.length > 0) {
						results.push(`${theme.status.warning} ${relPath}: some servers failed (${failedServers.join(", ")})`);
					}
				}
			}

			const allServersFailed = totalServerAttempts > 0 && totalServerSuccesses === 0;
			return {
				content: [{ type: "text", text: results.join("\n") }],
				details: { action, serverName: Array.from(allServerNames).join(", "), success: !allServersFailed },
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
			} catch (err) {
				// Only ENOENT means "missing". Reporting EACCES/ELOOP/EIO as a
				// missing path sends the caller hunting the wrong problem — and
				// silently invites them to recreate a file that is already there.
				const relSource = formatRenameStatPath(source, this.session.cwd);
				return {
					content: [
						{
							type: "text",
							text: isEnoent(err)
								? `Error: source path does not exist: ${relSource}`
								: `Error: cannot read source path ${relSource}: ${formatRenameStatError(err)}`,
						},
					],
					details: { action, success: false, request: params },
				};
			}

			try {
				await fs.promises.lstat(dest);
				return {
					content: [
						{
							type: "text",
							text: `Error: destination already exists: ${formatRenameStatPath(dest, this.session.cwd)}`,
						},
					],
					details: { action, success: false, request: params },
				};
			} catch (err) {
				// ENOENT is the success case: the destination is free. Any other
				// failure means we never established that, so renaming onto it
				// could clobber a file we simply could not see.
				if (!isEnoent(err)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: cannot read destination path ${formatRenameStatPath(dest, this.session.cwd)}: ${formatRenameStatError(err)}`,
							},
						],
						details: { action, success: false, request: params },
					};
				}
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
			// Servers that support workspace/willRenameFiles (i.e. did not reply
			// method-not-found) but failed the request. Their semantic edits are
			// owed but missing, so on apply the rename MUST NOT mutate the workspace
			// — moving the path without those edits leaves dangling references
			// (issue #8380).
			const hardFailures: string[] = [];

			for (const [serverName, serverConfig] of servers) {
				throwIfAborted(signal);
				let client: LspClient;
				try {
					client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
					if (isProjectAwareLspServer(serverConfig)) {
						await waitForProjectLoaded(client, signal);
					}
				} catch (err) {
					if (err instanceof ToolAbortError || signal?.aborted) {
						throw err;
					}
					// Could not reach the server at all; note it but don't block —
					// this is not a willRenameFiles failure.
					const msg = err instanceof Error ? err.message : String(err);
					serverNotes.push(`  ${serverName}: ${msg}`);
					continue;
				}
				try {
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
					// method-not-found means the server doesn't implement the request;
					// skip it silently. Any other error is a genuine failure from a
					// server that supports willRenameFiles.
					if (!isMethodNotFoundError(err)) {
						const msg = err instanceof Error ? err.message : String(err);
						serverNotes.push(`  ${serverName}: ${msg}`);
						hardFailures.push(serverName);
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

			// A relevant server that supports willRenameFiles failed. Applying
			// partial edits and moving the path would leave references dangling,
			// so abort before any mutation and surface the failure (issue #8380).
			if (hardFailures.length > 0) {
				const lines: string[] = [
					`Error: aborted rename; workspace/willRenameFiles failed on ${hardFailures.join(", ")}, so semantic references would not be updated. No files were moved.`,
				];
				lines.push("  Server notes:");
				lines.push(...serverNotes);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						action,
						serverName: Array.from(respondingServers).join(", "),
						success: false,
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

			// Validate every accepted bucket (overlap + snippet-format rejection)
			// before writing any file, so a snippet edit in a later URI cannot
			// leave earlier files half-applied.
			for (const bucket of acceptedByUri.values()) {
				sortAndValidateTextEdits(bucket.edits);
			}

			const referenceEdits: RenameReferenceEdit[] = [];
			for (const [uri, bucket] of acceptedByUri) {
				const filePath = uriToFile(uri);
				referenceEdits.push({ filePath, edits: bucket.edits });
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

			// Apply the reference edits and move as one unit: a failed move rolls
			// the reference edits back so the source, destination, and every
			// reference file are left unchanged.
			await applyEditsThenRename(referenceEdits, source, dest);
			summary.push(`  Renamed ${sourceLabel} → ${destLabel}`);

			for (const [serverName, serverConfig] of servers) {
				try {
					const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
					for (const { oldUri } of pairs) {
						if (client.openFiles.has(oldUri)) {
							await sendNotification(client, "textDocument/didClose", { textDocument: { uri: oldUri } }, signal);
							client.openFiles.delete(oldUri);
						}
					}
					await sendNotification(client, "workspace/didRenameFiles", lspParams, signal);
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
					const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
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
				const client = await getOrCreateClient(chosenConfig, this.session.cwd, undefined, signal);
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
					const workspaceClient = await getOrCreateClient(
						workspaceServerConfig,
						this.session.cwd,
						undefined,
						signal,
					);
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
			// Identity-aware client keys make a changed server resolve to a fresh
			// client below, but the process spawned from the superseded config
			// would stay registered and running otherwise (#8384). This also
			// clears every old client when the refreshed config removes all servers.
			const stopped = await shutdownStaleClients(
				this.session.cwd,
				servers.map(([, serverConfig]) => serverConfig),
				signal,
			);
			if (servers.length === 0) {
				return {
					content: [{ type: "text", text: "No language server found for this action" }],
					details: { action, success: false, request: params },
				};
			}
			const outputs: string[] = [];
			if (stopped.length > 0) {
				outputs.push(`Stopped ${stopped.length} server(s) with superseded configuration: ${stopped.join(", ")}`);
			}
			for (const [workspaceServerName, workspaceServerConfig] of servers) {
				throwIfAborted(signal);
				clearInitializationFailure(workspaceServerConfig, this.session.cwd);
				try {
					const workspaceClient = await getOrCreateClient(
						workspaceServerConfig,
						this.session.cwd,
						undefined,
						signal,
					);
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

		if (action === "reload") clearInitializationFailure(serverConfig, this.session.cwd);

		try {
			const client = await getOrCreateClient(serverConfig, this.session.cwd, undefined, signal);
			const targetFile = resolvedFile;
			const isRustAnalyzerServer = isRustAnalyzerClient(client) || serverName === "rust-analyzer";
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
							applyWorkspaceEdit: async edit => applyWorkspaceEditWithLsp(edit, this.session.cwd, signal),
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
							const applied = await applyWorkspaceEditWithLsp(result, this.session.cwd, signal);
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
