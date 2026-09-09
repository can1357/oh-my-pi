/**
 * Shared display-tree machinery for profile summaries (macOS `sample` reports,
 * V8 `.cpuprofile` files). Callers build {@link ProfileNode} trees with a
 * domain-specific metric (on-CPU samples, self microseconds, …); this module
 * merges same-key siblings, flattens direct recursion, collapses pass-through
 * chains, and renders the pruned hot-path tree.
 */

/** Display node: merged, recursion-flattened mirror of a profile subtree. */
export interface ProfileNode {
	/** Merge/recursion identity (demangled symbol, function@call-site, …). */
	key: string;
	/** Human-readable label; recursion and truncation decorations are applied at render time. */
	label: string;
	/** Inclusive metric for this subtree (on-CPU samples, self µs, …); drives pruning and display. */
	value: number;
	/** Levels of direct recursion flattened into this node. */
	recursion: number;
	children: ProfileNode[];
}

/** Labels longer than this are head-truncated (huge C++ templates, data URLs). */
const MAX_LABEL_CHARS = 160;

/** Merge `b` into `a` (same key), combining values and child lists. */
export function mergeInto(a: ProfileNode, b: ProfileNode): void {
	a.value += b.value;
	a.recursion = Math.max(a.recursion, b.recursion);
	for (const child of b.children) {
		const existing = a.children.find(c => c.key === child.key);
		if (existing) mergeInto(existing, child);
		else a.children.push(child);
	}
}

/**
 * Flatten direct recursion: children carrying the node's own key are dissolved
 * into it (their children promoted and merged), so a 15-deep recursive spine
 * renders as one annotated node.
 */
export function flattenRecursion(node: ProfileNode): void {
	while (node.children.some(child => child.key === node.key)) {
		node.recursion++;
		const next: ProfileNode[] = [];
		for (const child of node.children) {
			const promoted = child.key === node.key ? child.children : [child];
			for (const item of promoted) {
				const existing = next.find(c => c.key === item.key);
				if (existing) mergeInto(existing, item);
				else next.push(item);
			}
		}
		node.children = next;
	}
}

/** `n` as a percentage of `total`, one decimal (`"12.3%"`); `"0%"` when total is empty. */
export function formatPct(n: number, total: number): string {
	if (total <= 0) return "0%";
	return `${((100 * n) / total).toFixed(1)}%`;
}

/** Options for {@link renderProfileNode}. */
export interface RenderTreeContext {
	out: string[];
	/** Denominator for percentage annotations. */
	total: number;
	/** Minimum subtree value a child needs to stay visible. */
	minValue: number;
	/** Format a metric value for the left column. */
	formatValue: (value: number) => string;
	/** Left-column width (characters) for formatted values. */
	valueWidth: number;
}

function decoratedLabel(node: ProfileNode): string {
	let label = node.label.length > MAX_LABEL_CHARS ? `${node.label.slice(0, MAX_LABEL_CHARS - 1)}…` : node.label;
	if (node.recursion > 0) label += ` [recursive ×${node.recursion + 1}]`;
	return label;
}

/**
 * Render one hot-path subtree: pass-through chains (single kept child, no own
 * contribution above `minValue`) collapse into a single `a › b › c` line, and
 * children below `minValue` are pruned.
 */
export function renderProfileNode(node: ProfileNode, indent: number, ctx: RenderTreeContext): void {
	const chain: ProfileNode[] = [node];
	let cur = node;
	for (;;) {
		flattenRecursion(cur);
		if (cur.recursion > 0) break;
		const kept = cur.children.filter(child => child.value >= ctx.minValue);
		if (kept.length !== 1 || cur.value - kept[0].value >= ctx.minValue) break;
		cur = kept[0];
		chain.push(cur);
	}
	flattenRecursion(cur);

	const labels = chain.map(decoratedLabel);
	const path =
		labels.length <= 4
			? labels.join(" › ")
			: `${labels[0]} › ⋯${labels.length - 2} frames⋯ › ${labels[labels.length - 1]}`;
	const value = ctx.formatValue(chain[0].value).padStart(ctx.valueWidth);
	const pct = formatPct(chain[0].value, ctx.total).padStart(6);
	ctx.out.push(`${value} ${pct}  ${"  ".repeat(indent)}${path}`);

	const kept = cur.children.filter(child => child.value >= ctx.minValue).sort((a, b) => b.value - a.value);
	for (const child of kept) renderProfileNode(child, indent + 1, ctx);
}
