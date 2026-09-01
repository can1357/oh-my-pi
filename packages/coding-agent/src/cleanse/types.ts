/** Severity normalized across checker-specific output formats. */
export type CleanseSeverity = "error" | "warning" | "info";

/** One actionable problem reported by a project checker. */
export interface CleanseDiagnostic {
	checker: string;
	file?: string;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	code?: string;
	severity: CleanseSeverity;
	message: string;
	suggestion?: string;
}

/** Result metadata for one checker invocation. */
export interface CleanseCheckResult {
	id: string;
	label: string;
	language: string;
	cwd: string;
	command: string;
	exitCode: number | null;
	diagnostics: CleanseDiagnostic[];
}

/** Checker discovery result omitted because its required executable was unavailable. */
export interface SkippedCleanseCheck {
	label: string;
	language: string;
	reason: string;
}

/** Aggregate diagnostics from every checker selected for a project. */
export interface CleanseDiagnosticReport {
	checks: CleanseCheckResult[];
	diagnostics: CleanseDiagnostic[];
	skipped: SkippedCleanseCheck[];
}

/** All diagnostics attached to one file, which scheduling never splits across agents. */
export interface CleanseFileIssues {
	file?: string;
	diagnostics: CleanseDiagnostic[];
	weight: number;
}

/** One weighted, file-disjoint workload handed to a subagent. */
export interface CleanseAssignment {
	index: number;
	groups: CleanseFileIssues[];
	weight: number;
}

/** Outcome of an interactive cleanse target picker (CLI one-shot TUI or in-session overlay). */
export type CleanseTargetChoice =
	| { kind: "all" }
	| { kind: "checker"; id: string }
	| { kind: "request"; request: string }
	| { kind: "cancel" };

/** Terminal status of one cleanse run. */
export type CleanseRunStatus = "clean" | "unresolved" | "unsupported" | "cancelled";

/** Observable completion state returned to the CLI and overlay adapters. */
export interface CleanseCommandResult {
	exitCode: number;
	status: CleanseRunStatus;
	report: CleanseDiagnosticReport;
	sessionFile?: string;
}

/** Settled result from one cleanse subagent. */
export interface CleanseAgentOutcome {
	name: string;
	success: boolean;
	output: string;
	error?: string;
	resolvedModel?: string;
}

/** Final state after streamed repair dispatch and the verification pass. */
export interface CleanseLoopResult {
	status: "clean" | "stalled" | "cancelled";
	/** Total repair subagents dispatched during the run. */
	workers: number;
	report: CleanseDiagnosticReport;
	outcomes: CleanseAgentOutcome[];
}
