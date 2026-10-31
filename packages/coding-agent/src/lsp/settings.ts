/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// LSP
export const cfgLspEnabled = register({
	id: "lsp.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "LSP",
		label: "LSP",
		description: "Enable the lsp tool for code intelligence (definitions, references, diagnostics, rename)",
	},
});

export const cfgLspLazy = register({
	id: "lsp.lazy",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "LSP",
		label: "Lazy LSP Startup",
		description:
			"Start language servers on first use (lsp tool or editing a matching file type) instead of at session startup",
	},
});

export const cfgLspShared = register({
	id: "lsp.shared",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "LSP",
		label: "Shared Language Servers",
		description:
			"Start language servers through the per-project daemon broker. Each connection gets its own server. While another omp instance in the project is running, a released server stays warm and the next connection reuses it instead of cold-starting (falls back to private servers when unavailable)",
	},
});

export const cfgLspFormatOnWrite = register({
	id: "lsp.formatOnWrite",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "LSP",
		label: "Format on Write",
		description: "Automatically format code files using LSP after writing",
	},
});

export const cfgLspDiagnosticsOnWrite = register({
	id: "lsp.diagnosticsOnWrite",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "LSP",
		label: "Diagnostics on Write",
		description: "Return LSP diagnostics after writing code files",
	},
});

export const cfgLspDiagnosticsOnEdit = register({
	id: "lsp.diagnosticsOnEdit",
	type: "boolean",
	default: false,
	ui: {
		tab: "files",
		group: "LSP",
		label: "Diagnostics on Edit",
		description: "Return LSP diagnostics after editing code files",
	},
});

export const cfgLspDiagnosticsDeduplicate = register({
	id: "lsp.diagnosticsDeduplicate",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "LSP",
		label: "Deduplicate Diagnostics",
		description: "Suppress post-edit LSP diagnostics already shown for a file; only surface new or changed ones",
	},
});

export const cfgLspRequestTimeout = register({
	id: "lsp.requestTimeout",
	type: "number",
	default: 10,
	ui: {
		tab: "files",
		group: "LSP",
		label: "Request Timeout",
		description:
			"Seconds to wait for a language server's diagnostics, hover and other answers when the agent sets no timeout; late post-edit diagnostics wait at least this long. Raise it for servers that are slow on a cold start. The lsp tool's timeout argument can still raise or lower it per call",
		options: [
			{ value: "10", label: "10 seconds", description: "Default" },
			{ value: "20", label: "20 seconds" },
			{ value: "30", label: "30 seconds" },
			{ value: "60", label: "1 minute" },
			{ value: "120", label: "2 minutes" },
			{ value: "300", label: "5 minutes" },
		],
	},
});
