/** Summary of a `cfg://` read, attached to read tool details. */
export interface CfgReadDetails {
	/** Dotted setting path or namespace that was read; empty for the whole tree. */
	path: string;
	/** Settings in the listing. */
	count: number;
	/** Listed settings whose effective value differs from the schema default. */
	modified: number;
}

/** How a `cfg://` write ended. */
export type CfgWriteOutcome = "applied" | "declined" | "unchanged";

/** A `cfg://` write, attached to write tool details. Values are display-formatted (credentials redacted). */
export interface CfgWriteDetails {
	path: string;
	/** Persisted to config.yml rather than scoped to the session. */
	save: boolean;
	previous: string;
	value: string;
	outcome: CfgWriteOutcome;
	/** Effective value after saving when a higher-precedence layer still shadows the saved one. */
	effective?: string;
}
