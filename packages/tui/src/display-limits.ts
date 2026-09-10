/**
 * Shared display truncation budgets for TUI and provider status surfaces.
 * Keep these in pi-tui so packages like pi-ai can reuse them without depending on coding-agent.
 */

/** Truncation lengths for different content types (visual cells). */
export const TRUNCATE_LENGTHS = {
	/** Short titles, labels */
	TITLE: 60,
	/** Medium-length content (messages, previews) */
	CONTENT: 80,
	/** Longer content (code, explanations) */
	LONG: 100,
	/** Full line content */
	LINE: 110,
	/** Very short (task previews, badges) */
	SHORT: 40,
	/** Idle recap status line (~40-word LLM reply) */
	RECAP: 280,
} as const;

/** Preview limits for collapsed/expanded views */
export const PREVIEW_LIMITS = {
	/** Lines shown in collapsed view */
	COLLAPSED_LINES: 3,
	/** Lines shown in expanded view */
	EXPANDED_LINES: 12,
	/** Items (files, results) shown in collapsed view */
	COLLAPSED_ITEMS: 8,
	/** Output preview lines in collapsed view */
	OUTPUT_COLLAPSED: 3,
	/** Output preview lines in expanded view */
	OUTPUT_EXPANDED: 10,
	/** Computer script lines shown in collapsed view */
	COMPUTER_CODE_COLLAPSED: 10,
	/** Max hunks shown when collapsed (edit tool) */
	DIFF_COLLAPSED_HUNKS: 8,
	/** Max diff lines shown when collapsed (edit tool) */
	DIFF_COLLAPSED_LINES: 40,
} as const;
