import type { CoordinationDetails } from "./wait";
import { type ProcWriteDetails } from "./proc-render";
import { type CfgWriteDetails } from "./cfg-render";
import type { FileDiagnosticsResult } from "./lsp";
import type { OutputMeta } from "../output-meta-format";

/** Details returned by the write tool for transcript rendering. */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
	/** Set when the file was auto-chmod'd because content begins with a `#!` shebang. */
	madeExecutable?: boolean;
	/** Absolute filesystem path the write resolved to. Used by the renderer to wrap
	 * the (possibly cwd-relative) header path in an OSC 8 `file://` hyperlink. */
	resolvedPath?: string;
	message?: CoordinationDetails;
	proc?: ProcWriteDetails;
	cfg?: CfgWriteDetails;
	/** Set when the write touched no files: a peer message, a reply, process stdin, or background-work control. */
	touchesNoFiles?: boolean;
}
