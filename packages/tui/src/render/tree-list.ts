/**
 * Hierarchical tree list rendering helper.
 */

import type { TspTreeNode } from "@oh-my-pi/pi-wire";
import { styledSpans } from "../native/spans";
import { node, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import type { Theme } from "../theme/theme";
import { visibleWidth } from "../utils";
import { TreeView } from "../components/tree-view";
import { formatMoreItems } from "./render-utils";
import type { TreeContext } from "./types";
import { getTreeBranch, getTreeContinuePrefix } from "./utils";

/** Tree items and callbacks controlling their presentation. */
export interface TreeListOptions<T> {
	items: T[];
	expanded?: boolean;
	maxCollapsed?: number;
	/** Strict total-line budget for collapsed mode. When set (and not expanded),
	 *  rendered item lines plus the trailing summary line must fit within this budget.
	 */
	maxCollapsedLines?: number;
	itemType?: string;
	truncateFrom?: "start" | "end";
	/** Caller-supplied trailing summary line. When set (and not expanded),
	 *  `renderTreeList` renders exactly the provided `items` (the caller has
	 *  already applied its own selection/cap) and appends this text as the
	 *  final `└` row, with the last item using `├`. Empty string renders the
	 *  items with no summary. Bypasses the built-in truncation/`maxCollapsed`
	 *  path. */
	trailingSummary?: string;
	/** Called once per item with `isLast: false` during budget calculation;
	 *  line count MUST NOT vary based on `isLast`. */
	renderItem: (item: T, context: TreeContext) => string | string[];
}

type TreeListRow = { kind: "item"; index: number; lines: string[] } | { kind: "summary"; text: string };

/** Render tree items with themed branches and optional expansion. */
export function renderTreeList<T>(options: TreeListOptions<T>, theme: Theme): string[] {
	const {
		items,
		expanded = false,
		maxCollapsed = 8,
		maxCollapsedLines,
		itemType = "item",
		truncateFrom = "end",
		renderItem,
	} = options;
	const maxItems = expanded ? items.length : Math.min(items.length, maxCollapsed);
	const linesBudget = !expanded && maxCollapsedLines !== undefined ? maxCollapsedLines : Infinity;
	const branchPrefix = `${theme.fg("dim", getTreeBranch(false, theme))} `;
	const lastPrefix = `${theme.fg("dim", getTreeBranch(true, theme))} `;
	const branchContinuePrefix = theme.fg("dim", getTreeContinuePrefix(false, theme));
	const lastContinuePrefix = theme.fg("dim", getTreeContinuePrefix(true, theme));
	const prefixWidth = Math.max(
		visibleWidth(branchPrefix),
		visibleWidth(lastPrefix),
		visibleWidth(branchContinuePrefix),
		visibleWidth(lastContinuePrefix),
	);

	const toItemRow = (itemIndex: number): TreeListRow => {
		const rendered = renderItem(items[itemIndex], {
			index: itemIndex,
			isLast: false,
			depth: 0,
			theme,
			prefix: "",
			continuePrefix: "",
			prefixWidth,
		});
		return { kind: "item", index: itemIndex, lines: Array.isArray(rendered) ? rendered : rendered ? [rendered] : [] };
	};

	// Caller-driven collapse: render exactly the provided items (the caller
	// already picked/capped them) plus an optional trailing summary row. The
	// walking-viewport todo policy uses this so item selection lives in the
	// todo domain, not here.
	if (!expanded && options.trailingSummary !== undefined) {
		const summary = options.trailingSummary;
		const roots: TreeListRow[] = [];
		for (let i = 0; i < items.length; i++) {
			roots.push(toItemRow(i));
		}
		if (summary !== "") {
			roots.push({ kind: "summary", text: theme.fg("muted", summary) });
		}
		return renderTreeListRows(roots, theme);
	}

	const candidateIndices: number[] = [];
	if (truncateFrom === "start") {
		const startCandidateIdx = Math.max(0, items.length - maxItems);
		for (let i = startCandidateIdx; i < items.length; i++) {
			candidateIndices.push(i);
		}
	} else {
		for (let i = 0; i < maxItems; i++) {
			candidateIndices.push(i);
		}
	}

	// Pre-render each candidate item once.
	// isLast cannot be known at this point (fittingCount is not yet determined);
	// renderItem implementations MUST NOT vary line count based on isLast.
	const preRendered: string[][] = [];
	for (let i = 0; i < candidateIndices.length; i++) {
		const itemIdx = candidateIndices[i];
		const rendered = renderItem(items[itemIdx], {
			index: itemIdx,
			isLast: false,
			depth: 0,
			theme,
			prefix: "",
			continuePrefix: "",
			prefixWidth,
		});
		preRendered.push(Array.isArray(rendered) ? rendered : rendered ? [rendered] : []);
	}

	let displayedSlice: { start: number; end: number };
	let remaining: number;
	let fittedLineCount = 0;

	if (truncateFrom === "start") {
		let fittingCount = candidateIndices.length;
		if (linesBudget !== Infinity) {
			fittingCount = 0;
			for (let i = candidateIndices.length - 1; i >= 0; i--) {
				const count = preRendered[i].length;
				const remainingBefore = candidateIndices[i];
				const reservedSummaryLines = remainingBefore > 0 ? 1 : 0;
				if (fittedLineCount + count + reservedSummaryLines > linesBudget) break;
				fittedLineCount += count;
				fittingCount++;
			}
		}
		const start = candidateIndices.length - fittingCount;
		displayedSlice = { start, end: candidateIndices.length };
		remaining = candidateIndices.length > 0 ? candidateIndices[start] : 0;
	} else {
		let fittingCount = candidateIndices.length;
		if (linesBudget !== Infinity) {
			fittingCount = 0;
			for (let i = 0; i < candidateIndices.length; i++) {
				const count = preRendered[i].length;
				const remainingAfter = items.length - (i + 1);
				const reservedSummaryLines = remainingAfter > 0 ? 1 : 0;
				if (fittedLineCount + count + reservedSummaryLines > linesBudget) break;
				fittedLineCount += count;
				fittingCount = i + 1;
			}
		}
		displayedSlice = { start: 0, end: fittingCount };
		remaining = items.length - fittingCount;
	}

	const hasSummary = !expanded && remaining > 0 && (linesBudget === Infinity || fittedLineCount < linesBudget);

	const roots: TreeListRow[] = [];
	if (truncateFrom === "start" && hasSummary) {
		roots.push({ kind: "summary", text: theme.fg("muted", formatMoreItems(remaining, itemType)) });
	}
	for (let i = displayedSlice.start; i < displayedSlice.end; i++) {
		roots.push({ kind: "item", index: candidateIndices[i], lines: preRendered[i]! });
	}
	if (truncateFrom === "end" && hasSummary) {
		roots.push({ kind: "summary", text: theme.fg("muted", formatMoreItems(remaining, itemType)) });
	}
	return renderTreeListRows(roots, theme);
}

/**
 * The native form of {@link renderTreeList}: a flat `tree` whose branch
 * gutters are the terminal's. The collapsed item cap (and the caller's
 * trailing summary) are kept as a muted "… N more" node; the visual line
 * budget (`maxCollapsedLines`) is layout and is left to the terminal.
 */
export function describeTreeList<T>(options: TreeListOptions<T>, theme: Theme): NativeNode {
	const { items, expanded = false, maxCollapsed = 8, itemType = "item", truncateFrom = "end", renderItem } = options;
	const itemNode = (index: number): TspTreeNode => {
		const rendered = renderItem(items[index], {
			index,
			isLast: index === items.length - 1,
			depth: 0,
			theme,
			prefix: "",
			continuePrefix: "",
		});
		return { id: `i${index}`, label: styledSpans(Array.isArray(rendered) ? rendered.join("\n") : rendered) };
	};
	const summaryNode = (text: string): TspTreeNode => ({ id: "more", label: [span(text, "muted")] });
	const nodes: TspTreeNode[] = [];
	if (!expanded && options.trailingSummary !== undefined) {
		for (let index = 0; index < items.length; index++) nodes.push(itemNode(index));
		if (options.trailingSummary !== "") nodes.push(summaryNode(options.trailingSummary));
		return node("tree", { nodes });
	}
	const shown = expanded ? items.length : Math.min(items.length, maxCollapsed);
	const hidden = items.length - shown;
	const start = truncateFrom === "start" ? items.length - shown : 0;
	if (hidden > 0 && truncateFrom === "start") nodes.push(summaryNode(formatMoreItems(hidden, itemType)));
	for (let index = start; index < start + shown; index++) nodes.push(itemNode(index));
	if (hidden > 0 && truncateFrom === "end") nodes.push(summaryNode(formatMoreItems(hidden, itemType)));
	return node("tree", { nodes });
}

/**
 * Emit pre-rendered item/summary roots through the shared keyed hierarchy.
 * Roots are siblings in display order, so the first N-1 rows draw `├` and the
 * final row draws `└` — matching the historical branch/continuation geometry.
 * Formatting adapters render unbounded, so truncation stays disabled here.
 */
function renderTreeListRows(roots: TreeListRow[], theme: Theme): string[] {
	const tree = new TreeView<TreeListRow, number>({
		roots,
		getKey: item => (item.kind === "summary" ? -1 : item.index),
		getChildren: () => [],
		theme,
		truncateRows: false,
		renderRow: item => (item.kind === "summary" ? [item.text] : item.lines),
	});
	return [...tree.render(Number.POSITIVE_INFINITY)];
}
