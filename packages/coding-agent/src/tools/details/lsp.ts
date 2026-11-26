/** Display arguments for an LSP tool request. */
export interface LspParams {
	action:
		| "diagnostics"
		| "definition"
		| "references"
		| "hover"
		| "symbols"
		| "rename"
		| "rename_file"
		| "code_actions"
		| "type_definition"
		| "implementation"
		| "status"
		| "reload"
		| "capabilities"
		| "request";
	file?: string;
	line?: number;
	symbol?: string;
	query?: string;
	new_name?: string;
	apply?: boolean;
	timeout?: number;
	payload?: string;
}

/** Details accompanying an LSP tool response. */
export interface LspToolDetails {
	serverName?: string;
	action: string;
	success: boolean;
	request?: LspParams;
}

/** Diagnostics and formatting status for one file. */
export interface FileDiagnosticsResult {
	/** Name of the LSP server used (if available) */
	server?: string;
	/** Formatted diagnostic messages */
	messages: string[];
	/** Summary string (e.g., "2 error(s), 1 warning(s)") */
	summary: string;
	/** Whether there are any errors (severity 1) */
	errored: boolean;
	/** Servers that sent no fresh report in time: the file is unverified for them, not clean. */
	unreported?: string[];
	/** Whether the file was formatted */
	formatter?: FileFormatResult;
}

/** Outcome of automatic file formatting. */
export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
	FAILED = "failed",
	UNSUPPORTED = "unsupported",
}
