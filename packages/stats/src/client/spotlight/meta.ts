/**
 * Spotlight vocabulary shared by the page's sections: recovery-kind and
 * tool labels, their colors (CSS variables from `spotlight.css`, so both
 * themes resolve them) and signed number formatting.
 */

import {
	Archive,
	Bot,
	Braces,
	CloudDownload,
	Ellipsis,
	FilePenLine,
	FilePlus,
	FileSearch,
	FileText,
	FolderSearch,
	Globe,
	Hourglass,
	ListTodo,
	type LucideIcon,
	Network,
	Repeat2,
	ScanSearch,
	SquareTerminal,
	TextSearch,
	Wrench,
} from "lucide-react";
import { formatCompact, formatCost } from "../data/formatters";
import type {
	SpotlightCutGroup,
	SpotlightDashboardStats,
	SpotlightEstimate,
	SpotlightGapBin,
	SpotlightRecoveryKind,
	SpotlightSizeBin,
	SpotlightTool,
} from "../types";

export const RECOVERY_KINDS: readonly SpotlightRecoveryKind[] = ["artifact", "reread", "rerun"];

export interface RecoveryKindMeta {
	label: string;
	/** Plural, for waterfall steps and totals. */
	plural: string;
	icon: LucideIcon;
	color: string;
	/** One-line rule, for tooltips. */
	rule: string;
}

export const RECOVERY_KIND: Record<SpotlightRecoveryKind, RecoveryKindMeta> = {
	artifact: {
		label: "Artifact dive",
		plural: "Artifact dives",
		icon: Archive,
		color: "var(--spot-artifact)",
		rule: "A later call read or searched an artifact the shortened result named",
	},
	reread: {
		label: "Re-read",
		plural: "Re-reads",
		icon: FileSearch,
		color: "var(--spot-reread)",
		rule: "A later read of the same file overlapping the hidden lines, or the whole file again",
	},
	rerun: {
		label: "Rerun",
		plural: "Reruns",
		icon: Repeat2,
		color: "var(--spot-rerun)",
		rule: "A call of the same tool within 12 calls repeating the shortened one: a bash command the same, with a pipe or redirect added, or ≥ 60% shared tokens; any other tool with ≥ 60% shared argument tokens",
	},
};

/** The range's evaluated tools, the largest saving first (the order of `gross.byTool`). */
export function toolsBySaving(stats: SpotlightDashboardStats): SpotlightTool[] {
	return stats.gross.byTool.map(row => row.tool);
}

/** Tools a card lists by name before the rest fold into `other` (or behind a "more tools" toggle). */
export const TOP_TOOLS = 6;

/** The folded rest's label where tools are rows or columns. */
export const OTHER_TOOLS = "other";

/**
 * Split tools (ordered) into the first `limit` a card lists and the rest it folds; a lone leftover is listed
 * instead.
 */
export function foldTools<T>(items: readonly T[], limit = TOP_TOOLS): { listed: readonly T[]; rest: readonly T[] } {
	if (items.length <= limit + 1) return { listed: items, rest: [] };
	return { listed: items.slice(0, limit), rest: items.slice(limit) };
}

export interface CutGroupMeta {
	label: string;
	color: string;
	/** Its mark in dot-whisker charts. */
	shape: "dot" | "ring" | "diamond" | "square";
	/** One-line definition, for tooltips and legends. */
	rule: string;
}

/**
 * The fetch-back comparison's groups. The cut is vivid; the score-free cut
 * (the same shaping without Spotlight's scores) takes its own hue; the two
 * baselines are neutral inks, the held-out one (the true counterfactual) the
 * stronger.
 */
export const CUT_GROUP: Record<SpotlightCutGroup, CutGroupMeta> = {
	applied: {
		label: "Shortened",
		color: "var(--spot-applied)",
		shape: "dot",
		rule: "Spotlight scored the result, shaping shortened it and the model saw the cut",
	},
	scoreFree: {
		label: "Score-free",
		color: "var(--spot-score-free)",
		shape: "square",
		rule: "A random coin skipped Spotlight: the no-score fallback rules shortened it and the model saw the cut",
	},
	holdout: {
		label: "Held out",
		color: "var(--spot-holdout)",
		shape: "ring",
		rule: "Spotlight would have shortened it, but it was held out at random and the model saw it whole",
	},
	reference: {
		label: "Unchanged",
		color: "var(--spot-reference)",
		shape: "diamond",
		rule: "Results shaping left unchanged, re-weighted to the cuts' original-size mix",
	},
	gated: {
		label: "Gated",
		color: "var(--spot-gated)",
		shape: "ring",
		rule: "A read the agent was likely to edit: the edit gate kept it whole and the model saw it uncut",
	},
};

export const CUT_GROUPS: readonly SpotlightCutGroup[] = ["applied", "scoreFree", "holdout", "gated", "reference"];

export const SIZE_BINS: readonly SpotlightSizeBin[] = ["<250", "250–1k", "1k–4k", "≥4k"];

export const GAP_BINS: readonly SpotlightGapBin[] = ["1", "2", "3", "4–6", "7–12"];

const TOOL_ICON: Readonly<Record<string, LucideIcon>> = {
	read: FileText,
	bash: SquareTerminal,
	eval: Braces,
	grep: TextSearch,
	find: ScanSearch,
	glob: FolderSearch,
	edit: FilePenLine,
	write: FilePlus,
	web_search: Globe,
	task: Bot,
	todo: ListTodo,
	wait: Hourglass,
	fetch: CloudDownload,
	lsp: Network,
	[OTHER_TOOLS]: Ellipsis,
};

/** A tool's icon; tools without one of their own (MCP and extension tools) get a generic wrench. */
export function toolIcon(tool: SpotlightTool): LucideIcon {
	return Object.hasOwn(TOOL_ICON, tool) ? TOOL_ICON[tool] : Wrench;
}

/** What one time bucket of the range is called in prose ("hour", "day"). */
export function bucketNoun(bucketMs: number): string {
	if (bucketMs >= 86_400_000) return "day";
	if (bucketMs >= 3_600_000) return "hour";
	return `${Math.round(bucketMs / 60_000)} minutes`;
}

/** Compact token count with a real minus sign. */
export function formatSignedCompact(value: number): string {
	return value < 0 ? `−${formatCompact(-value)}` : formatCompact(value);
}

/** Dollar amount with a real minus sign (`formatCost` alone prints `$-0.12`). */
export function formatSignedCost(value: number): string {
	return value < 0 ? `−${formatCost(-value)}` : formatCost(value);
}

/** A relative change as a signed percentage (`+12%`, `−3.5%`), `–` when undefined. */
export function formatSignedShare(value: number | null): string {
	return value !== null && value > 0 ? `+${formatShare(value)}` : formatShare(value);
}

/** An estimate's 90% interval as `lo–hi`, empty when it has none. */
export function formatInterval(estimate: SpotlightEstimate, format: (value: number) => string): string {
	return estimate.lo === null || estimate.hi === null ? "" : `${format(estimate.lo)}–${format(estimate.hi)}`;
}

/** Share as a whole or one-decimal percentage, `–` when undefined. */
export function formatShare(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "–";
	if (value === 0) return "0%";
	const pct = Math.abs(value * 100);
	return `${value < 0 ? "−" : ""}${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}
