/**
 * Types for the omp commit pipeline.
 */
/** Conventional commit classifications accepted by commit generation. */
export type CommitType =
	| "feat"
	| "fix"
	| "refactor"
	| "perf"
	| "docs"
	| "test"
	| "build"
	| "ci"
	| "chore"
	| "style"
	| "revert"
	| "deps"
	| "security"
	| "config"
	| "ux"
	| "release"
	| "hotfix"
	| "infra"
	| "init"
	| "merge"
	| "hack"
	| "wip";

/** Keep a Changelog category attached to a generated detail. */
export type ChangelogCategory =
	| "Breaking Changes"
	| "Added"
	| "Changed"
	| "Deprecated"
	| "Removed"
	| "Fixed"
	| "Security";

/** Changelog categories in canonical render order. */
export const CHANGELOG_CATEGORIES: ChangelogCategory[] = [
	"Breaking Changes",
	"Added",
	"Changed",
	"Deprecated",
	"Removed",
	"Fixed",
	"Security",
];

/** Arguments accepted by the `omp commit` command. */
export interface CommitCommandArgs {
	/** Push after commit */
	push: boolean;
	/** Preview without committing */
	dryRun: boolean;
	/** Skip changelog updates */
	noChangelog: boolean;
	/** Use legacy deterministic pipeline */
	legacy?: boolean;
	/** Additional user context for the model */
	context?: string;
	/** Override the model selection */
	model?: string;
}

/** One parsed `git diff --numstat` row. */
export interface NumstatEntry {
	path: string;
	additions: number;
	deletions: number;
}

/** One material change identified during commit analysis. */
export interface ConventionalDetail {
	text: string;
	changelogCategory?: ChangelogCategory;
	userVisible: boolean;
}

/** Structured classification produced before commit-message formatting. */
export interface ConventionalAnalysis {
	type: CommitType;
	scope: string | null;
	summary?: string;
	details: ConventionalDetail[];
	issueRefs: string[];
}

/** Fully normalized conventional commit ready for display or execution. */
export interface ConventionalCommit {
	type: CommitType;
	scope: string | null;
	summary: string;
	body: string[];
	footers: string[];
}

/** Parsed file section used by hunk selection. */
export interface FileDiff {
	filename: string;
	content: string;
	additions: number;
	deletions: number;
	isBinary: boolean;
}

/** One parsed unified-diff hunk. */
export interface DiffHunk {
	index: number;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	content: string;
}

/** Parsed hunks for one changed file. */
export interface FileHunks {
	filename: string;
	isBinary: boolean;
	hunks: DiffHunk[];
}

/** Changelog file and the changed files governed by it. */
export interface ChangelogBoundary {
	changelogPath: string;
	files: string[];
}

/** Parsed line range and entries for an Unreleased changelog section. */
export interface UnreleasedSection {
	startLine: number;
	endLine: number;
	entries: Record<string, string[]>;
}

/** Generated changelog entries grouped by category. */
export interface ChangelogGenerationResult {
	entries: Record<string, string[]>;
}
