import { type Static, Type } from "@sinclair/typebox";
import type { Subprocess } from "bun";

// =============================================================================
// Tool Schema
// =============================================================================

export const lspSchema = Type.Object({
	action: Type.Union(
		[
			// Standard LSP operations
			Type.Literal("diagnostics"),
			Type.Literal("references"),
			Type.Literal("definition"),
			Type.Literal("hover"),
			Type.Literal("symbols"),
			Type.Literal("workspace_symbols"),
			Type.Literal("rename"),
			Type.Literal("actions"),
			Type.Literal("incoming_calls"),
			Type.Literal("outgoing_calls"),
			Type.Literal("status"),
			// Rust-analyzer specific operations
			Type.Literal("flycheck"),
			Type.Literal("expand_macro"),
			Type.Literal("ssr"),
			Type.Literal("runnables"),
			Type.Literal("related_tests"),
			Type.Literal("reload_workspace"),
		],
		{ description: "LSP action to perform" },
	),
	files: Type.Optional(Type.Array(Type.String({ description: "File paths for diagnostics" }))),
	file: Type.Optional(Type.String({ description: "File path for file-specific actions" })),
	line: Type.Optional(Type.Number({ description: "1-based line number" })),
	column: Type.Optional(Type.Number({ description: "1-based column number" })),
	end_line: Type.Optional(Type.Number({ description: "1-based end line number for ranges" })),
	end_character: Type.Optional(Type.Number({ description: "1-based end column number for ranges" })),
	query: Type.Optional(Type.String({ description: "Search query for symbols/SSR pattern" })),
	new_name: Type.Optional(Type.String({ description: "New name for rename action" })),
	replacement: Type.Optional(Type.String({ description: "Replacement for SSR action" })),
	kind: Type.Optional(Type.String({ description: "Code action kind filter (quickfix, refactor, source)" })),
	apply: Type.Optional(Type.Boolean({ description: "Apply edits instead of preview (default: true)" })),
	action_index: Type.Optional(Type.Number({ description: "Index of code action to apply" })),
	include_declaration: Type.Optional(
		Type.Boolean({ description: "Include declaration in references (default: true)" }),
	),
});

export type LspParams = Static<typeof lspSchema>;

export interface LspToolDetails {
	serverName?: string;
	action: string;
	success: boolean;
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

// =============================================================================
// Text Edits
// =============================================================================

export interface TextEdit {
	range: Range;
	newText: string;
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
	rootMarkers: string[];
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
	disabled?: boolean;
	capabilities?: ServerCapabilities;
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
	[key: string]: unknown;
}

export interface LspClient {
	name: string;
	cwd: string;
	config: ServerConfig;
	process: Subprocess;
	requestId: number;
	diagnostics: Map<string, Diagnostic[]>;
	openFiles: Map<string, OpenFile>;
	pendingRequests: Map<number, PendingRequest>;
	messageBuffer: Uint8Array;
	isReading: boolean;
	serverCapabilities?: LspServerCapabilities;
	lastActivity: number;
}

// =============================================================================
// Call Hierarchy Types
// =============================================================================

export interface CallHierarchyItem {
	name: string;
	kind: SymbolKind;
	tags?: number[];
	detail?: string;
	uri: string;
	range: Range;
	selectionRange: Range;
	data?: unknown;
}

export interface CallHierarchyIncomingCall {
	from: CallHierarchyItem;
	fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
	to: CallHierarchyItem;
	fromRanges: Range[];
}

// =============================================================================
// Rust-analyzer Specific Types
// =============================================================================

export interface ExpandMacroResult {
	name: string;
	expansion: string;
}

export interface Runnable {
	label: string;
	kind: string;
	args?: {
		workspaceRoot?: string;
		cargoArgs?: string[];
		cargoExtraArgs?: string[];
		executableArgs?: string[];
	};
	location?: {
		targetUri: string;
		targetRange?: Range;
		targetSelectionRange?: Range;
	};
}

export interface RelatedTest {
	runnable?: {
		label: string;
		kind: string;
		args?: Runnable["args"];
		location?: Runnable["location"];
	};
}

// =============================================================================
// JSON-RPC Protocol Types
// =============================================================================

export interface LspJsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params: unknown;
}

export interface LspJsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface LspJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}
