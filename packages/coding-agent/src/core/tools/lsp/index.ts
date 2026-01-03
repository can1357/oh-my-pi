import * as fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import { resolveToCwd } from "../path-utils.js";
import {
	ensureFileOpen,
	getActiveClients,
	getOrCreateClient,
	type LspServerStatus,
	refreshFile,
	sendRequest,
} from "./client.js";
import { getServerForFile, getServersForFile, hasCapability, type LspConfig, loadConfig } from "./config.js";
import { applyTextEdits, applyWorkspaceEdit } from "./edits.js";
import { renderCall, renderResult } from "./render.js";
import * as rustAnalyzer from "./rust-analyzer.js";
import {
	type CallHierarchyIncomingCall,
	type CallHierarchyItem,
	type CallHierarchyOutgoingCall,
	type CodeAction,
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
} from "./types.js";
import {
	extractHoverText,
	fileToUri,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatDocumentSymbol,
	formatLocation,
	formatSymbolInformation,
	formatWorkspaceEdit,
	sleep,
	symbolKindToIcon,
	uriToFile,
} from "./utils.js";

export type { LspServerStatus } from "./client.js";
export type { LspToolDetails } from "./types.js";

/** Result from warming up LSP servers */
export interface LspWarmupResult {
	servers: Array<{
		name: string;
		status: "ready" | "error";
		fileTypes: string[];
		error?: string;
	}>;
}

/**
 * Warm up LSP servers for a directory by connecting to all detected servers.
 * This should be called at startup to avoid cold-start delays.
 *
 * @param cwd - Working directory to detect and start servers for
 * @returns Status of each server that was started
 */
export async function warmupLspServers(cwd: string): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	const servers: LspWarmupResult["servers"] = [];

	// Start all detected servers in parallel
	const results = await Promise.allSettled(
		Object.entries(config.servers).map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (const result of results) {
		if (result.status === "fulfilled") {
			servers.push({
				name: result.value.name,
				status: "ready",
				fileTypes: result.value.fileTypes,
			});
		} else {
			// Extract server name from error if possible
			const errorMsg = result.reason?.message ?? String(result.reason);
			servers.push({
				name: "unknown",
				status: "error",
				fileTypes: [],
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

// Cache config per cwd to avoid repeated file I/O
const configCache = new Map<string, LspConfig>();

function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		configCache.set(cwd, config);
	}
	return config;
}

const FILE_SEARCH_MAX_DEPTH = 5;
const IGNORED_DIRS = new Set(["node_modules", "target", "dist", "build", ".git"]);

function findFileByExtensions(baseDir: string, extensions: string[], maxDepth: number): string | null {
	const normalized = extensions.map((ext) => ext.toLowerCase());
	const search = (dir: string, depth: number): string | null => {
		if (depth > maxDepth) return null;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return null;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
			const fullPath = path.join(dir, entry.name);

			if (entry.isFile()) {
				const lowerName = entry.name.toLowerCase();
				if (normalized.some((ext) => lowerName.endsWith(ext))) {
					return fullPath;
				}
			} else if (entry.isDirectory()) {
				const found = search(fullPath, depth + 1);
				if (found) return found;
			}
		}
		return null;
	};

	return search(baseDir, 0);
}

function findFileForServer(cwd: string, serverConfig: ServerConfig): string | null {
	return findFileByExtensions(cwd, serverConfig.fileTypes, FILE_SEARCH_MAX_DEPTH);
}

function getRustServer(config: LspConfig): [string, ServerConfig] | null {
	const entries = Object.entries(config.servers) as Array<[string, ServerConfig]>;
	const byName = entries.find(([name, server]) => name === "rust-analyzer" || server.command === "rust-analyzer");
	if (byName) return byName;

	for (const [name, server] of entries) {
		if (
			hasCapability(server, "flycheck") ||
			hasCapability(server, "ssr") ||
			hasCapability(server, "runnables") ||
			hasCapability(server, "expandMacro") ||
			hasCapability(server, "relatedTests")
		) {
			return [name, server];
		}
	}

	return null;
}

function getServerForWorkspaceAction(config: LspConfig, action: string): [string, ServerConfig] | null {
	const entries = Object.entries(config.servers) as Array<[string, ServerConfig]>;
	if (entries.length === 0) return null;

	if (action === "workspace_symbols") {
		return entries[0];
	}

	if (action === "flycheck" || action === "ssr" || action === "runnables" || action === "reload_workspace") {
		return getRustServer(config);
	}

	return null;
}

async function waitForDiagnostics(client: LspClient, uri: string, timeoutMs = 3000): Promise<Diagnostic[]> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const diagnostics = client.diagnostics.get(uri);
		if (diagnostics !== undefined) return diagnostics;
		await sleep(100);
	}
	return client.diagnostics.get(uri) ?? [];
}

/** Result from getDiagnosticsForFile */
export interface FileDiagnosticsResult {
	/** Whether an LSP server was available for the file type */
	available: boolean;
	/** Name of the LSP server used (if available) */
	serverName?: string;
	/** Formatted diagnostic messages */
	diagnostics: string[];
	/** Summary string (e.g., "2 error(s), 1 warning(s)") */
	summary: string;
	/** Whether there are any errors (severity 1) */
	hasErrors: boolean;
	/** Whether there are any warnings (severity 2) */
	hasWarnings: boolean;
}

/**
 * Get LSP diagnostics for a file after it has been written.
 * Queries all applicable language servers (e.g., TypeScript + Biome) and merges results.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param timeoutMs - Timeout for waiting for diagnostics (default: 5000ms)
 * @returns Diagnostic results or null if no LSP server available
 */
export async function getDiagnosticsForFile(
	absolutePath: string,
	cwd: string,
	timeoutMs = 5000,
): Promise<FileDiagnosticsResult> {
	const config = getConfig(cwd);
	const servers = getServersForFile(config, absolutePath);

	if (servers.length === 0) {
		return {
			available: false,
			diagnostics: [],
			summary: "",
			hasErrors: false,
			hasWarnings: false,
		};
	}

	const uri = fileToUri(absolutePath);
	const relPath = path.relative(cwd, absolutePath);
	const allDiagnostics: Diagnostic[] = [];
	const serverNames: string[] = [];

	// Query all applicable servers in parallel
	const results = await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd);
			await refreshFile(client, absolutePath);
			const diagnostics = await waitForDiagnostics(client, uri, timeoutMs);
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
		// All servers failed
		return {
			available: false,
			diagnostics: [],
			summary: "",
			hasErrors: false,
			hasWarnings: false,
		};
	}

	if (allDiagnostics.length === 0) {
		return {
			available: true,
			serverName: serverNames.join(", "),
			diagnostics: [],
			summary: "No issues",
			hasErrors: false,
			hasWarnings: false,
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

	const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath));
	const summary = formatDiagnosticsSummary(uniqueDiagnostics);
	const hasErrors = uniqueDiagnostics.some((d) => d.severity === 1);
	const hasWarnings = uniqueDiagnostics.some((d) => d.severity === 2);

	return {
		available: true,
		serverName: serverNames.join(", "),
		diagnostics: formatted,
		summary,
		hasErrors,
		hasWarnings,
	};
}

/** Result from formatFile */
export interface FileFormatResult {
	/** Whether an LSP server with formatting support was available */
	available: boolean;
	/** Name of the LSP server used (if available) */
	serverName?: string;
	/** Whether formatting was applied */
	formatted: boolean;
	/** Error message if formatting failed */
	error?: string;
}

/** Default formatting options for LSP */
const DEFAULT_FORMAT_OPTIONS = {
	tabSize: 3,
	insertSpaces: true,
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
};

/**
 * Format a file using LSP.
 * Uses the first available server that supports formatting.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @returns Format result indicating success/failure
 */
export async function formatFile(absolutePath: string, cwd: string): Promise<FileFormatResult> {
	const config = getConfig(cwd);
	const servers = getServersForFile(config, absolutePath);

	if (servers.length === 0) {
		return { available: false, formatted: false };
	}

	const uri = fileToUri(absolutePath);

	// Try each server until one successfully formats
	for (const [serverName, serverConfig] of servers) {
		try {
			const client = await getOrCreateClient(serverConfig, cwd);

			// Check if server supports formatting
			const caps = client.serverCapabilities;
			if (!caps?.documentFormattingProvider) {
				continue;
			}

			// Ensure file is open and synced
			await ensureFileOpen(client, absolutePath);
			await refreshFile(client, absolutePath);

			// Request formatting
			const edits = (await sendRequest(client, "textDocument/formatting", {
				textDocument: { uri },
				options: DEFAULT_FORMAT_OPTIONS,
			})) as TextEdit[] | null;

			if (!edits || edits.length === 0) {
				// No changes needed - file already formatted
				return { available: true, serverName, formatted: false };
			}

			// Apply the formatting edits
			await applyTextEdits(absolutePath, edits);

			// Notify LSP of the change so diagnostics update
			await refreshFile(client, absolutePath);

			return { available: true, serverName, formatted: true };
		} catch {}
	}

	// No server could format
	return { available: false, formatted: false };
}

export function createLspTool(cwd: string): AgentTool<typeof lspSchema, LspToolDetails, Theme> {
	return {
		name: "lsp",
		label: "LSP",
		description: `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Standard operations:
- diagnostics: Get errors/warnings for a file
- definition: Go to symbol definition
- references: Find all references to a symbol
- hover: Get type info and documentation
- symbols: List symbols in a file (functions, classes, etc.)
- workspace_symbols: Search for symbols across the project
- rename: Rename a symbol across the codebase
- actions: List and apply code actions (quick fixes, refactors)
- incoming_calls: Find all callers of a function
- outgoing_calls: Find all functions called by a function
- status: Show active language servers

Rust-analyzer specific (require rust-analyzer):
- flycheck: Run clippy/cargo check
- expand_macro: Show macro expansion at cursor
- ssr: Structural search-replace
- runnables: Find runnable tests/binaries
- related_tests: Find tests for a function
- reload_workspace: Reload Cargo.toml changes`,
		parameters: lspSchema,
		renderCall,
		renderResult,
		execute: async (_toolCallId, params: LspParams, _signal) => {
			const {
				action,
				file,
				files,
				line,
				column,
				end_line,
				end_character,
				query,
				new_name,
				replacement,
				kind,
				apply,
				action_index,
				include_declaration,
			} = params;

			const config = getConfig(cwd);

			// Status action doesn't need a file
			if (action === "status") {
				const servers = Object.keys(config.servers);
				const output =
					servers.length > 0
						? `Active language servers: ${servers.join(", ")}`
						: "No language servers configured for this project";
				return {
					content: [{ type: "text", text: output }],
					details: { action, success: true },
				};
			}

			// Diagnostics can be batch or single-file - queries all applicable servers
			if (action === "diagnostics") {
				const targets = files?.length ? files : file ? [file] : null;
				if (!targets) {
					return {
						content: [{ type: "text", text: "Error: file or files parameter required for diagnostics" }],
						details: { action, success: false },
					};
				}

				const detailed = Boolean(files?.length);
				const results: string[] = [];
				const allServerNames = new Set<string>();

				for (const target of targets) {
					const resolved = resolveToCwd(target, cwd);
					const servers = getServersForFile(config, resolved);
					if (servers.length === 0) {
						results.push(`✗ ${target}: No language server found`);
						continue;
					}

					const uri = fileToUri(resolved);
					const relPath = path.relative(cwd, resolved);
					const allDiagnostics: Diagnostic[] = [];

					// Query all applicable servers for this file
					for (const [serverName, serverConfig] of servers) {
						allServerNames.add(serverName);
						try {
							const client = await getOrCreateClient(serverConfig, cwd);
							await refreshFile(client, resolved);
							const diagnostics = await waitForDiagnostics(client, uri);
							allDiagnostics.push(...diagnostics);
						} catch {
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

					if (!detailed && targets.length === 1) {
						if (uniqueDiagnostics.length === 0) {
							return {
								content: [{ type: "text", text: "No diagnostics" }],
								details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
							};
						}

						const summary = formatDiagnosticsSummary(uniqueDiagnostics);
						const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath));
						const output = `${summary}:\n${formatted.map((f) => `  ${f}`).join("\n")}`;
						return {
							content: [{ type: "text", text: output }],
							details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
						};
					}

					if (uniqueDiagnostics.length === 0) {
						results.push(`✓ ${relPath}: no issues`);
					} else {
						const summary = formatDiagnosticsSummary(uniqueDiagnostics);
						results.push(`✗ ${relPath}: ${summary}`);
						for (const diag of uniqueDiagnostics) {
							results.push(`  ${formatDiagnostic(diag, relPath)}`);
						}
					}
				}

				return {
					content: [{ type: "text", text: results.join("\n") }],
					details: { action, serverName: Array.from(allServerNames).join(", "), success: true },
				};
			}

			const requiresFile =
				!file &&
				action !== "workspace_symbols" &&
				action !== "flycheck" &&
				action !== "ssr" &&
				action !== "runnables" &&
				action !== "reload_workspace";

			if (requiresFile) {
				return {
					content: [{ type: "text", text: "Error: file parameter required for this action" }],
					details: { action, success: false },
				};
			}

			const resolvedFile = file ? resolveToCwd(file, cwd) : null;
			const serverInfo = resolvedFile
				? getServerForFile(config, resolvedFile)
				: getServerForWorkspaceAction(config, action);

			if (!serverInfo) {
				return {
					content: [{ type: "text", text: "No language server found for this action" }],
					details: { action, success: false },
				};
			}

			const [serverName, serverConfig] = serverInfo;

			try {
				const client = await getOrCreateClient(serverConfig, cwd);
				let targetFile = resolvedFile;
				if (action === "runnables" && !targetFile) {
					targetFile = findFileForServer(cwd, serverConfig);
					if (!targetFile) {
						return {
							content: [{ type: "text", text: "Error: no matching files found for runnables" }],
							details: { action, serverName, success: false },
						};
					}
				}

				if (targetFile) {
					await ensureFileOpen(client, targetFile);
				}

				const uri = targetFile ? fileToUri(targetFile) : "";
				const position = { line: (line || 1) - 1, character: (column || 1) - 1 };

				let output: string;

				switch (action) {
					// =====================================================================
					// Standard LSP Operations
					// =====================================================================

					case "definition": {
						const result = (await sendRequest(client, "textDocument/definition", {
							textDocument: { uri },
							position,
						})) as Location | Location[] | LocationLink | LocationLink[] | null;

						if (!result) {
							output = "No definition found";
						} else {
							const raw = Array.isArray(result) ? result : [result];
							const locations = raw.flatMap((loc) => {
								if ("uri" in loc) {
									return [loc as Location];
								}
								if ("targetUri" in loc) {
									// Use targetSelectionRange (the precise identifier range) with fallback to targetRange
									const link = loc as LocationLink;
									return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
								}
								return [];
							});

							if (locations.length === 0) {
								output = "No definition found";
							} else {
								output = `Found ${locations.length} definition(s):\n${locations
									.map((loc) => `  ${formatLocation(loc, cwd)}`)
									.join("\n")}`;
							}
						}
						break;
					}

					case "references": {
						const result = (await sendRequest(client, "textDocument/references", {
							textDocument: { uri },
							position,
							context: { includeDeclaration: include_declaration ?? true },
						})) as Location[] | null;

						if (!result || result.length === 0) {
							output = "No references found";
						} else {
							const lines = result.map((loc) => `  ${formatLocation(loc, cwd)}`);
							output = `Found ${result.length} reference(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "hover": {
						const result = (await sendRequest(client, "textDocument/hover", {
							textDocument: { uri },
							position,
						})) as Hover | null;

						if (!result || !result.contents) {
							output = "No hover information";
						} else {
							output = extractHoverText(result.contents);
						}
						break;
					}

					case "symbols": {
						const result = (await sendRequest(client, "textDocument/documentSymbol", {
							textDocument: { uri },
						})) as (DocumentSymbol | SymbolInformation)[] | null;

						if (!result || result.length === 0) {
							output = "No symbols found";
						} else if (!targetFile) {
							return {
								content: [{ type: "text", text: "Error: file parameter required for symbols" }],
								details: { action, serverName, success: false },
							};
						} else {
							const relPath = path.relative(cwd, targetFile);
							// Check if hierarchical (DocumentSymbol) or flat (SymbolInformation)
							if ("selectionRange" in result[0]) {
								// Hierarchical
								const lines = (result as DocumentSymbol[]).flatMap((s) => formatDocumentSymbol(s));
								output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
							} else {
								// Flat
								const lines = (result as SymbolInformation[]).map((s) => {
									const line = s.location.range.start.line + 1;
									const icon = symbolKindToIcon(s.kind);
									return `${icon} ${s.name} @ line ${line}`;
								});
								output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
							}
						}
						break;
					}

					case "workspace_symbols": {
						if (!query) {
							return {
								content: [{ type: "text", text: "Error: query parameter required for workspace_symbols" }],
								details: { action, serverName, success: false },
							};
						}

						const result = (await sendRequest(client, "workspace/symbol", { query })) as
							| SymbolInformation[]
							| null;

						if (!result || result.length === 0) {
							output = `No symbols matching "${query}"`;
						} else {
							const lines = result.map((s) => formatSymbolInformation(s, cwd));
							output = `Found ${result.length} symbol(s) matching "${query}":\n${lines
								.map((l) => `  ${l}`)
								.join("\n")}`;
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

						const result = (await sendRequest(client, "textDocument/rename", {
							textDocument: { uri },
							position,
							newName: new_name,
						})) as WorkspaceEdit | null;

						if (!result) {
							output = "Rename returned no edits";
						} else {
							const shouldApply = apply !== false;
							if (shouldApply) {
								const applied = await applyWorkspaceEdit(result, cwd);
								output = `Applied rename:\n${applied.map((a) => `  ${a}`).join("\n")}`;
							} else {
								const preview = formatWorkspaceEdit(result, cwd);
								output = `Rename preview:\n${preview.map((p) => `  ${p}`).join("\n")}`;
							}
						}
						break;
					}

					case "actions": {
						if (!targetFile) {
							return {
								content: [{ type: "text", text: "Error: file parameter required for actions" }],
								details: { action, serverName, success: false },
							};
						}

						await refreshFile(client, targetFile);
						const diagnostics = await waitForDiagnostics(client, uri);
						const endLine = (end_line ?? line ?? 1) - 1;
						const endCharacter = (end_character ?? column ?? 1) - 1;
						const range = { start: position, end: { line: endLine, character: endCharacter } };
						const relevantDiagnostics = diagnostics.filter(
							(d) => d.range.start.line <= range.end.line && d.range.end.line >= range.start.line,
						);

						const codeActionContext: { diagnostics: Diagnostic[]; only?: string[] } = {
							diagnostics: relevantDiagnostics,
						};
						if (kind) {
							codeActionContext.only = [kind];
						}

						const result = (await sendRequest(client, "textDocument/codeAction", {
							textDocument: { uri },
							range,
							context: codeActionContext,
						})) as Array<CodeAction | Command> | null;

						if (!result || result.length === 0) {
							output = "No code actions available";
						} else if (action_index !== undefined) {
							// Apply specific action
							if (action_index < 0 || action_index >= result.length) {
								return {
									content: [
										{
											type: "text",
											text: `Error: action_index ${action_index} out of range (0-${result.length - 1})`,
										},
									],
									details: { action, serverName, success: false },
								};
							}

							const isCommand = (candidate: CodeAction | Command): candidate is Command =>
								typeof (candidate as Command).command === "string";
							const isCodeAction = (candidate: CodeAction | Command): candidate is CodeAction =>
								!isCommand(candidate);
							const getCommandPayload = (
								candidate: CodeAction | Command,
							): { command: string; arguments?: unknown[] } | null => {
								if (isCommand(candidate)) {
									return { command: candidate.command, arguments: candidate.arguments };
								}
								if (candidate.command) {
									return { command: candidate.command.command, arguments: candidate.command.arguments };
								}
								return null;
							};

							const codeAction = result[action_index];

							// Resolve if needed
							let resolvedAction = codeAction;
							if (
								isCodeAction(codeAction) &&
								!codeAction.edit &&
								codeAction.data &&
								client.serverCapabilities?.codeActionProvider
							) {
								const provider = client.serverCapabilities.codeActionProvider;
								if (typeof provider === "object" && provider.resolveProvider) {
									resolvedAction = (await sendRequest(client, "codeAction/resolve", codeAction)) as CodeAction;
								}
							}

							if (isCodeAction(resolvedAction) && resolvedAction.edit) {
								const applied = await applyWorkspaceEdit(resolvedAction.edit, cwd);
								output = `Applied "${codeAction.title}":\n${applied.map((a) => `  ${a}`).join("\n")}`;
							} else {
								const commandPayload = getCommandPayload(resolvedAction);
								if (commandPayload) {
									await sendRequest(client, "workspace/executeCommand", commandPayload);
									output = `Executed "${codeAction.title}"`;
								} else {
									output = `Code action "${codeAction.title}" has no edits or command to apply`;
								}
							}
						} else {
							// List available actions
							const lines = result.map((actionItem, i) => {
								if ("kind" in actionItem || "isPreferred" in actionItem || "edit" in actionItem) {
									const actionDetails = actionItem as CodeAction;
									const preferred = actionDetails.isPreferred ? " (preferred)" : "";
									const kindInfo = actionDetails.kind ? ` [${actionDetails.kind}]` : "";
									return `  [${i}] ${actionDetails.title}${kindInfo}${preferred}`;
								}
								return `  [${i}] ${actionItem.title}`;
							});
							output = `Available code actions:\n${lines.join(
								"\n",
							)}\n\nUse action_index parameter to apply a specific action.`;
						}
						break;
					}

					case "incoming_calls":
					case "outgoing_calls": {
						// First, prepare the call hierarchy item at the cursor position
						const prepareResult = (await sendRequest(client, "textDocument/prepareCallHierarchy", {
							textDocument: { uri },
							position,
						})) as CallHierarchyItem[] | null;

						if (!prepareResult || prepareResult.length === 0) {
							output = "No callable symbol found at this position";
							break;
						}

						const item = prepareResult[0];

						if (action === "incoming_calls") {
							const calls = (await sendRequest(client, "callHierarchy/incomingCalls", { item })) as
								| CallHierarchyIncomingCall[]
								| null;

							if (!calls || calls.length === 0) {
								output = `No callers found for "${item.name}"`;
							} else {
								const lines = calls.map((call) => {
									const loc = { uri: call.from.uri, range: call.from.selectionRange };
									const detail = call.from.detail ? ` (${call.from.detail})` : "";
									return `  ${call.from.name}${detail} @ ${formatLocation(loc, cwd)}`;
								});
								output = `Found ${calls.length} caller(s) of "${item.name}":\n${lines.join("\n")}`;
							}
						} else {
							const calls = (await sendRequest(client, "callHierarchy/outgoingCalls", { item })) as
								| CallHierarchyOutgoingCall[]
								| null;

							if (!calls || calls.length === 0) {
								output = `"${item.name}" doesn't call any functions`;
							} else {
								const lines = calls.map((call) => {
									const loc = { uri: call.to.uri, range: call.to.selectionRange };
									const detail = call.to.detail ? ` (${call.to.detail})` : "";
									return `  ${call.to.name}${detail} @ ${formatLocation(loc, cwd)}`;
								});
								output = `"${item.name}" calls ${calls.length} function(s):\n${lines.join("\n")}`;
							}
						}
						break;
					}

					// =====================================================================
					// Rust-Analyzer Specific Operations
					// =====================================================================

					case "flycheck": {
						if (!hasCapability(serverConfig, "flycheck")) {
							return {
								content: [{ type: "text", text: "Error: flycheck requires rust-analyzer" }],
								details: { action, serverName, success: false },
							};
						}

						await rustAnalyzer.flycheck(client, resolvedFile ?? undefined);
						const collected: Array<{ filePath: string; diagnostic: Diagnostic }> = [];
						for (const [diagUri, diags] of client.diagnostics.entries()) {
							const relPath = path.relative(cwd, uriToFile(diagUri));
							for (const diag of diags) {
								collected.push({ filePath: relPath, diagnostic: diag });
							}
						}

						if (collected.length === 0) {
							output = "Flycheck: no issues found";
						} else {
							const summary = formatDiagnosticsSummary(collected.map((d) => d.diagnostic));
							const formatted = collected.slice(0, 20).map((d) => formatDiagnostic(d.diagnostic, d.filePath));
							const more = collected.length > 20 ? `\n  ... and ${collected.length - 20} more` : "";
							output = `Flycheck ${summary}:\n${formatted.map((f) => `  ${f}`).join("\n")}${more}`;
						}
						break;
					}

					case "expand_macro": {
						if (!hasCapability(serverConfig, "expandMacro")) {
							return {
								content: [{ type: "text", text: "Error: expand_macro requires rust-analyzer" }],
								details: { action, serverName, success: false },
							};
						}

						if (!targetFile) {
							return {
								content: [{ type: "text", text: "Error: file parameter required for expand_macro" }],
								details: { action, serverName, success: false },
							};
						}

						const result = await rustAnalyzer.expandMacro(client, targetFile, line || 1, column || 1);
						if (!result) {
							output = "No macro expansion at this position";
						} else {
							output = `Macro: ${result.name}\n\nExpansion:\n${result.expansion}`;
						}
						break;
					}

					case "ssr": {
						if (!hasCapability(serverConfig, "ssr")) {
							return {
								content: [{ type: "text", text: "Error: ssr requires rust-analyzer" }],
								details: { action, serverName, success: false },
							};
						}

						if (!query) {
							return {
								content: [{ type: "text", text: "Error: query parameter (pattern) required for ssr" }],
								details: { action, serverName, success: false },
							};
						}

						if (!replacement) {
							return {
								content: [{ type: "text", text: "Error: replacement parameter required for ssr" }],
								details: { action, serverName, success: false },
							};
						}

						const shouldApply = apply === true;
						const result = await rustAnalyzer.ssr(client, query, replacement, !shouldApply);

						if (shouldApply) {
							const applied = await applyWorkspaceEdit(result, cwd);
							output =
								applied.length > 0
									? `Applied SSR:\n${applied.map((a) => `  ${a}`).join("\n")}`
									: "SSR: no matches found";
						} else {
							const preview = formatWorkspaceEdit(result, cwd);
							output =
								preview.length > 0
									? `SSR preview:\n${preview.map((p) => `  ${p}`).join("\n")}`
									: "SSR: no matches found";
						}
						break;
					}

					case "runnables": {
						if (!hasCapability(serverConfig, "runnables")) {
							return {
								content: [{ type: "text", text: "Error: runnables requires rust-analyzer" }],
								details: { action, serverName, success: false },
							};
						}

						if (!targetFile) {
							return {
								content: [{ type: "text", text: "Error: file parameter required for runnables" }],
								details: { action, serverName, success: false },
							};
						}

						const result = await rustAnalyzer.runnables(client, targetFile, line);
						if (result.length === 0) {
							output = "No runnables found";
						} else {
							const lines = result.map((r) => {
								const args = r.args?.cargoArgs?.join(" ") || "";
								return `  [${r.kind}] ${r.label}${args ? ` (cargo ${args})` : ""}`;
							});
							output = `Found ${result.length} runnable(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "related_tests": {
						if (!hasCapability(serverConfig, "relatedTests")) {
							return {
								content: [{ type: "text", text: "Error: related_tests requires rust-analyzer" }],
								details: { action, serverName, success: false },
							};
						}

						if (!targetFile) {
							return {
								content: [{ type: "text", text: "Error: file parameter required for related_tests" }],
								details: { action, serverName, success: false },
							};
						}

						const result = await rustAnalyzer.relatedTests(client, targetFile, line || 1, column || 1);
						if (result.length === 0) {
							output = "No related tests found";
						} else {
							output = `Found ${result.length} related test(s):\n${result.map((t) => `  ${t}`).join("\n")}`;
						}
						break;
					}

					case "reload_workspace": {
						await rustAnalyzer.reloadWorkspace(client);
						output = "Workspace reloaded successfully";
						break;
					}

					default:
						output = `Unknown action: ${action}`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: { serverName, action, success: true },
				};
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `LSP error: ${errorMessage}` }],
					details: { serverName, action, success: false },
				};
			}
		},
	};
}

export const lspTool = createLspTool(process.cwd());
