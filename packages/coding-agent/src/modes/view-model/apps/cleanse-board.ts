import type { AgentProgress } from "../../../task/task-details";

/** Checker identity shown in live rows and verdicts. */
export interface CleanseCheckerDescriptor {
	id: string;
	label: string;
}

/** Checker result fields consumed by the verdict line. */
export interface CleanseCheckResult extends CleanseCheckerDescriptor {
	diagnostics: readonly unknown[];
}

/** Repair workload fields displayed in agent rows. */
export interface CleanseAssignment {
	index: number;
	groups: readonly { file?: string }[];
	weight: number;
}

/** Completion fields displayed when a repair agent settles. */
export interface CleanseAgentOutcome {
	name: string;
	success: boolean;
	error?: string;
	resolvedModel?: string;
}

/** Rendering surface for one `omp cleanse` run. */
export interface CleanseStatusBoard {
	readonly interactive: boolean;
	/** Print a permanent line above the live area (plain write when non-TTY). */
	log(text: string): void;
	/** Show a transient spinner line; `undefined` clears it. Non-TTY prints the text once. */
	phase(text: string | undefined): void;
	checkerStarted(checker: CleanseCheckerDescriptor): void;
	checkerFinished(check: CleanseCheckResult, durationMs: number): void;
	/** End the repair phase and drop its live rows before verification. */
	repairFinished(): void;
	agentStarted(name: string, assignment: CleanseAssignment): void;
	agentProgress(name: string, progress: AgentProgress): void;
	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void;
	/** Clear the live area and restore the cursor. Idempotent. */
	close(): void;
}
