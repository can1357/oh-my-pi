import { type } from "@oh-my-pi/omptype";
import { TOOL_TIMEOUTS } from "../tools/tool-timeouts";

// =============================================================================
// Tool Schema
// =============================================================================

export const lspSchema = type({
	action:
		"'diagnostics' | 'definition' | 'references' | 'hover' | 'symbols' | 'rename' | 'rename_file' | 'code_actions' | 'type_definition' | 'implementation' | 'status' | 'reload' | 'capabilities' | 'request'",
	file: "string?",
	line: "number?",
	symbol: "string?",
	query: "string?",
	new_name: "string?",
	apply: "boolean?",
	"timeout?": type.number
		.atLeast(TOOL_TIMEOUTS.lsp.min)
		.atMost(TOOL_TIMEOUTS.lsp.max)
		.describe("Timeout in seconds (default 20; range 5–300)."),
	payload: "string?",
});

export type LspParams = typeof lspSchema.infer;

export interface LspToolDetails {
	serverName?: string;
	action: string;
	success: boolean;
	request?: LspParams;
}

// =============================================================================
// Core LSP Protocol Types
// =============================================================================

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface LocationLink {
	originSelectionRange?: Range;
	targetUri: string;
	targetRange: Range;
	targetSelectionRange: Range;
}

// =============================================================================
// Diagnostics
// =============================================================================

export type DiagnosticSeverity = 1 | 2 | 3 | 4; // error, warning, info, hint

export interface DiagnosticRelatedInformation {
	location: Location;
	message: string;
}

export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverity;
	code?: string | number;
	codeDescription?: { href: string };
	source?: string;
	message: string;
	tags?: number[];
	relatedInformation?: DiagnosticRelatedInformation[];
	data?: unknown;
}

export interface PublishedDiagnostics {
	diagnostics: Diagnostic[];
	version: number | null;
}

export interface PublishDiagnosticsParams {
	uri: string;
	diagnostics: Diagnostic[];
	version?: number | null;
}

// =============================================================================
// Text Edits
// =============================================================================

export interface TextEdit {
	range: Range;
	newText: string;
	insertTextFormat?: 1 | 2;
}

export interface AnnotatedTextEdit extends TextEdit {
	annotationId?: string;
}

export interface TextDocumentIdentifier {
	uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version: number | null;
}

export interface OptionalVersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version?: number | null;
}

export interface TextDocumentEdit {
	textDocument: OptionalVersionedTextDocumentIdentifier;
	edits: (TextEdit | AnnotatedTextEdit)[];
}

// =============================================================================
// Resource Operations
// =============================================================================

export interface CreateFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

export interface CreateFile {
	kind: "create";
	uri: string;
	options?: CreateFileOptions;
}

export interface RenameFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

export interface RenameFile {
	kind: "rename";
	oldUri: string;
	newUri: string;
	options?: RenameFileOptions;
}

export interface DeleteFileOptions {
	recursive?: boolean;
	ignoreIfNotExists?: boolean;
}

export interface DeleteFile {
	kind: "delete";
	uri: string;
	options?: DeleteFileOptions;
}

export type DocumentChange = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;

export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: DocumentChange[];
	changeAnnotations?: Record<string, { label: string; needsConfirmation?: boolean; description?: string }>;
}

// =============================================================================
// Code Actions
// =============================================================================

export type CodeActionKind =
	| "quickfix"
	| "refactor"
	| "refactor.extract"
	| "refactor.inline"
	| "refactor.rewrite"
	| "source"
	| "source.organizeImports"
	| "source.fixAll"
	| string;

export interface Command {
	title: string;
	command: string;
	arguments?: unknown[];
}

export interface CodeAction {
	title: string;
	kind?: CodeActionKind;
	diagnostics?: Diagnostic[];
	isPreferred?: boolean;
	disabled?: { reason: string };
	edit?: WorkspaceEdit;
	command?: Command;
	data?: unknown;
}

export interface CodeActionContext {
	diagnostics: Diagnostic[];
	only?: CodeActionKind[];
	triggerKind?: 1 | 2; // Invoked = 1, Automatic = 2
}

// =============================================================================
// Symbols
// =============================================================================

export type SymbolKind =
	| 1 // File
	| 2 // Module
	| 3 // Namespace
	| 4 // Package
	| 5 // Class
	| 6 // Method
	| 7 // Property
	| 8 // Field
	| 9 // Constructor
	| 10 // Enum
	| 11 // Interface
	| 12 // Function
	| 13 // Variable
	| 14 // Constant
	| 15 // String
	| 16 // Number
	| 17 // Boolean
	| 18 // Array
	| 19 // Object
	| 20 // Key
	| 21 // Null
	| 22 // EnumMember
	| 23 // Struct
	| 24 // Event
	| 25 // Operator
	| 26; // TypeParameter

export const SYMBOL_KIND_NAMES: Record<SymbolKind, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKind;
	tags?: number[];
	deprecated?: boolean;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: SymbolKind;
	tags?: number[];
	deprecated?: boolean;
	location: Location;
	containerName?: string;
}

// =============================================================================
// Hover
// =============================================================================

export interface MarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

export type MarkedString = string | { language: string; value: string };

export interface Hover {
	contents: MarkupContent | MarkedString | MarkedString[];
	range?: Range;
}

// =============================================================================
// Linter Client Interface
// =============================================================================

/**
 * Interface for linter/formatter clients.
 * Can be implemented using LSP protocol or CLI tools.
 */
export interface LinterClient {
	/** Format file content. Returns formatted content. */
	format(filePath: string, content: string): Promise<string>;

	/** Get diagnostics for a file. Content should already be written to disk. */
	lint(filePath: string, signal?: AbortSignal): Promise<Diagnostic[]>;

	/** Dispose of any resources (e.g., LSP connection) */
	dispose?(): void;
}

/** Factory function to create a LinterClient */
export type LinterClientFactory = (config: ServerConfig, cwd: string) => LinterClient;

// =============================================================================
// Server Configuration
// =============================================================================

export interface ServerCapabilities {
	flycheck?: boolean;
	ssr?: boolean;
	expandMacro?: boolean;
	runnables?: boolean;
	relatedTests?: boolean;
}

export interface ServerConfig {
	command: string;
	args?: string[];
	fileTypes: string[];
	/** LSP language identifier sent in didOpen; inferred from the file path when omitted. */
	languageId?: string;
	rootMarkers: string[];
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
	disabled?: boolean;
	/** Per-server warmup timeout in milliseconds. Overrides the global WARMUP_TIMEOUT_MS for this server during startup. */
	warmupTimeoutMs?: number;
	/**
	 * Per-server overrides for rust-analyzer workspace-ready polling. When omitted, the module
	 * defaults are used. Primarily a tuning/test seam to bound the multi-second settle window.
	 */
	workspaceReadyTimings?: {
		timeoutMs?: number;
		pollMs?: number;
		settleMs?: number;
		statusRequestTimeoutMs?: number;
	};
	capabilities?: ServerCapabilities;
	/** If true, this is a linter/formatter server (e.g., Biome) - used only for diagnostics/actions, not type intelligence */
	isLinter?: boolean;
	/** Resolved absolute path to the command binary (set during config loading) */
	resolvedCommand?: string;
	/**
	 * Custom linter client factory. If provided, creates a custom client instead of using LSP.
	 * The client handles format/lint operations. Useful for tools with buggy LSP implementations.
	 */
	createClient?: LinterClientFactory;
}

// =============================================================================
// Transport
// =============================================================================

/** Minimal write sink for the server-bound byte stream (satisfied by `Bun.FileSink` and the mux socket adapter). */
export interface LspWriteSink {
	write(data: string | Uint8Array): number | Promise<number>;
	flush(): number | void | Promise<number | void>;
}

/**
 * Byte transport carrying one LSP JSON-RPC link. Structurally satisfied by
 * `ptree.ChildProcess<"pipe">` (local server spawn) and by the socket adapter
 * in `mux/daemon.ts` (broker-shared server). `exited` may reject (ptree kill).
 */
export interface LspTransport {
	readonly stdin: LspWriteSink;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	readonly pid?: number;
	/** Present and true on broker-shared mux links; `lsp reload` uses it to request a shared-server restart. */
	readonly sharedMux?: boolean;
	kill(): void;
	peekStderr(): string;
}

// =============================================================================
// Client State
// =============================================================================

export interface OpenFile {
	version: number;
	languageId: string;
}

export interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	method: string;
}

export interface LspServerCapabilities {
	renameProvider?: boolean | { prepareProvider?: boolean };
	codeActionProvider?: boolean | { resolveProvider?: boolean };
	hoverProvider?: boolean;
	definitionProvider?: boolean;
	referencesProvider?: boolean;
	documentSymbolProvider?: boolean;
	workspaceSymbolProvider?: boolean;
	diagnosticProvider?: boolean | Record<string, unknown>;
	[key: string]: unknown;
}

export interface LspClient {
	name: string;
	cwd: string;
	config: ServerConfig;
	proc: LspTransport;
	requestId: number;
	diagnostics: Map<string, PublishedDiagnostics>;
	diagnosticsVersion: number;
	/** Dynamic capability registrations keyed by the server-provided registration ID. */
	dynamicCapabilityRegistrations?: Map<string, string>;
	openFiles: Map<string, OpenFile>;
	pendingRequests: Map<number | string, PendingRequest>;
	messageBuffer: Uint8Array;
	isReading: boolean;
	/** Lifecycle state: "connecting" until initialize completes, then "ready"; "error" on init failure or reader death. */
	status: "connecting" | "ready" | "error";
	serverCapabilities?: LspServerCapabilities;
	lastActivity: number;
	/** Serializes outbound JSON-RPC writes to the server process. */
	writeQueue: Promise<void>;
	/** Tracks active work-done progress tokens from the server */
	activeProgressTokens: Set<string | number>;
	/** Resolves when the server's initial project loading completes (or after timeout) */
	projectLoaded: Promise<void>;
	/** Call to signal that project loading has completed */
	resolveProjectLoaded: () => void;
}

// =============================================================================
// JSON-RPC Protocol Types
// =============================================================================

/** JSON-RPC request/response identifier accepted by LSP peers. */
export type LspJsonRpcId = number | string;

export interface LspJsonRpcRequest {
	jsonrpc: "2.0";
	id: LspJsonRpcId;
	method: string;
	params: unknown;
}

export interface LspJsonRpcResponse {
	jsonrpc: "2.0";
	id?: LspJsonRpcId;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface LspJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}
