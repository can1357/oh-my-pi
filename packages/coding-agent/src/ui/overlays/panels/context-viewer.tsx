/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/context`: a read-only snapshot of what fills the context window, in three
 * states — the Overview (usage summary and stacked meter, the category legend
 * with each one's share), a category's entry previews, and one entry's full
 * content. Enter opens, escape goes back (closing from the Overview).
 *
 * {@link ContextViewerModel} holds the navigation; the native tree and the
 * terminal look (a box with an occupancy map beside the legend) both read it.
 */
import { type Accessor, type JSXNode, type ScrollRequest, signal, untrack } from "@oh-my-pi/pi-tui";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type {
	ContextCategoryId,
	ContextThinkingGroup,
	ContextViewCategory,
	ContextViewData,
	ContextViewEntry,
} from "../../../session/context-view-model";
import { PREVIEW_LIMITS, shortenEmbeddedPaths, shortenPath } from "../../../utils/render-utils";
import { replaceTabs } from "../../../utils/text-width";
import "../../styles/panels/context-viewer";
import { listKeyId } from "../../../config/keybindings/matchers";
import { actionKey } from "../../keys/hints";
import { ActionButton } from "./common";

// ─── Presentation ───────────────────────────────────────────────────────────

/** Category colors and map glyph (symbol keys). */
export const CONTEXT_PRESENTATION = {
	"system-prompt": { color: "accent", symbol: "context.content" },
	"instruction-files": { color: "muted", symbol: "context.content" },
	skills: { color: "success", symbol: "context.content" },
	"built-in-tools": { color: "warning", symbol: "context.content" },
	"custom-tools": { color: "customMessageLabel", symbol: "context.content" },
	"user-messages": { color: "accent", symbol: "context.messages" },
	"assistant-messages": { color: "userMessageText", symbol: "context.messages" },
	"assistant-thinking": { color: "customMessageLabel", symbol: "context.content" },
	"tool-calls": { color: "warning", symbol: "context.content" },
	"tool-output": { color: "muted", symbol: "context.messages" },
	buffer: { color: "warning", symbol: "context.buffer" },
	free: { color: "dim", symbol: "context.free" },
} as const;

export type ContextPresentationId = ContextCategoryId | "buffer" | "free";

/** Overview labels where the Overview weight differs from the category's content. */
const OVERVIEW_LABELS: Partial<Record<ContextCategoryId, string>> = {};

// ─── Text ───────────────────────────────────────────────────────────────────

/** Newlines normalized, controls removed, tabs expanded. */
export function safeContent(value: string): string {
	return replaceTabs(sanitizeText(value.replace(/\r\n?/g, "\n")));
}

/** {@link safeContent} with home paths shortened. */
export function safeText(value: string): string {
	return shortenEmbeddedPaths(safeContent(value));
}

/** {@link safeText} on one row. */
export function safeLine(value: string): string {
	return safeText(value).replace(/\n/g, " ");
}

/** A styled run: text and its span tokens. */
export interface Run {
	readonly t: string;
	readonly s?: string;
}

/** An entry body up to `limit` characters (end-trimmed): source markers take their category's color. */
export function entryBodyRuns(entry: ContextViewEntry, limit = Number.POSITIVE_INFINITY): Run[] {
	const body = entry.text.trimEnd();
	const end = Math.min(body.length, limit);
	if (!entry.sourceMarkers?.length) return [{ t: safeContent(body.slice(0, end)) }];
	const runs: Run[] = [];
	let cursor = 0;
	for (const marker of entry.sourceMarkers) {
		if (marker.start >= end) break;
		runs.push({ t: safeContent(body.slice(cursor, marker.start)) });
		cursor = Math.min(marker.end, end);
		runs.push({ t: safeText(body.slice(marker.start, cursor)), s: CONTEXT_PRESENTATION[marker.category].color });
	}
	runs.push({ t: safeContent(body.slice(cursor, end)) });
	return runs;
}

/** Runs as spans, neighbours of one style merged, empty runs dropped. */
export function runSpans(runs: readonly Run[]): TspSpan[] {
	const spans: TspSpan[] = [];
	for (const run of runs) {
		if (run.t === "") continue;
		const last = spans.at(-1);
		if (last && last.s === run.s) spans[spans.length - 1] = { ...last, t: last.t + run.t };
		else spans.push(run.s ? { s: run.s, t: run.t } : { t: run.t });
	}
	return spans;
}

/** `—` for a grouped entry, `N/A · Interrupted`, else `N tokens`. */
export function tokenEstimate(item: ContextViewEntry | ContextThinkingGroup): string {
	if ("thinkingGroup" in item && item.thinkingGroup) return "—";
	if (item.interrupted) return "N/A · Interrupted";
	return `${item.tokens.toLocaleString("en-US")} ${item.tokens === 1 ? "token" : "tokens"}`;
}

/** `[label] N tokens` spans. */
export function entryHeaderSpans(entry: ContextViewEntry, category: ContextCategoryId): TspSpan[] {
	const color = CONTEXT_PRESENTATION[category].color;
	return [
		{ s: "dim", t: "[" },
		{ s: `${color} strong`, t: safeLine(entry.label) },
		{ s: "dim", t: `] ${tokenEstimate(entry)}` },
	];
}

/** A thinking group's heading spans. */
export function groupHeaderSpans(group: ContextThinkingGroup, category: ContextCategoryId): TspSpan[] {
	const color = CONTEXT_PRESENTATION[category].color;
	return [
		{ s: `${color} strong`, t: safeLine(group.label) },
		{ s: "dim", t: ` · ${tokenEstimate(group)}` },
	];
}

/** The truncation marker under a preview; the selected one advertises the key that opens it (`confirm`). */
export function previewHintSpans(confirm?: string): TspSpan[] {
	return confirm
		? [
				{ s: "dim", t: "  … more · " },
				{ s: "accent", t: `${confirm} View Content` },
			]
		: [{ s: "dim", t: "  … more" }];
}

const TIMESTAMP_FORMAT = {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
} as const;

/**
 * Metadata rows: info and path, call id, timestamp (and the thinking group in
 * the full view). `hour12` is the terminal's clock, where it told one.
 */
export function entryMetadata(entry: ContextViewEntry, withGroup: boolean, hour12?: boolean): string[] {
	const lines: string[] = [];
	const group = entry.thinkingGroup;
	if (group && withGroup) lines.push(`${safeLine(group.label)} · ${tokenEstimate(group)}`);
	const info = safeText([entry.info, entry.path ? shortenPath(entry.path) : undefined].filter(Boolean).join(" · "));
	if (info) lines.push(info);
	const callId = entry.callId !== undefined ? safeText(entry.callId) : "";
	if (callId) lines.push(callId);
	if (entry.timestamp !== undefined)
		lines.push(new Date(entry.timestamp).toLocaleString([], { ...TIMESTAMP_FORMAT, hour12 }));
	return lines;
}

/** Preview rows for a list `height` rows tall. */
export function previewRows(entry: ContextViewEntry, height: number): number {
	return Math.max(1, Math.min(PREVIEW_LIMITS.OUTPUT_EXPANDED, height - (entry.thinkingGroup ? 3 : 2)));
}

/** One preview row: runs, already wrapped. */
export type PreviewLine = readonly Run[];

/**
 * Dim metadata rows, then the body indented two cells, wrapped by `wrap` at
 * `width` and cut to `rows`; `complete` is false when anything was left out.
 */
export function entryPreview(
	entry: ContextViewEntry,
	options: { width: number; rows: number; sourceWidth: number; hour12?: boolean },
): { lines: PreviewLine[]; complete: boolean } {
	const { width, rows } = options;
	const maxChars = Math.max(1, options.sourceWidth) * rows * 2;
	const metadata = entryMetadata(entry, false, options.hour12).join("\n");
	const metadataLength = Math.min(metadata.length, maxChars);
	const body = entry.text.trimEnd();
	const bodyLength = Math.min(body.length, Math.max(0, maxChars - metadataLength - (metadataLength ? 1 : 0)));
	const parts = [
		{ runs: [{ t: safeContent(metadata.slice(0, metadataLength)), s: "dim" }] as Run[], prefix: "" },
		{ runs: entryBodyRuns(entry, bodyLength), prefix: "  " },
	];
	const lines: PreviewLine[] = [];
	for (const { runs, prefix } of parts) {
		if (runs.every(run => run.t === "")) continue;
		// Paragraph by paragraph; a marker run keeps its style on each of its rows.
		const paragraphs: Run[][] = [[]];
		for (const run of runs) {
			run.t.split("\n").forEach((piece, i) => {
				if (i > 0) paragraphs.push([]);
				if (piece) paragraphs.at(-1)!.push({ t: piece, ...(run.s ? { s: run.s } : {}) });
			});
		}
		for (const paragraph of paragraphs) {
			const remaining = rows - lines.length;
			if (remaining === 0) return { lines, complete: false };
			const text = paragraph.map(run => run.t).join("");
			const style = paragraph.length === 1 ? paragraph[0]!.s : undefined;
			const wrapped = text ? wrap(text, Math.max(1, width - prefix.length)) : [""];
			for (const row of wrapped.slice(0, remaining))
				lines.push([{ t: `${prefix}${row}`, ...(style ? { s: style } : {}) }]);
			if (wrapped.length > remaining) return { lines, complete: false };
		}
	}
	return { lines, complete: metadataLength === metadata.length && bodyLength === body.length };
}

// ─── Overview model ─────────────────────────────────────────────────────────

/** One legend row. */
export interface OverviewRow {
	readonly key: string;
	readonly id: ContextPresentationId;
	readonly label: string;
	readonly tokens: number | undefined;
	/** Category opened on Enter; undefined rows are listed but not selectable. */
	readonly category?: ContextViewCategory;
	readonly child?: boolean;
	readonly tokenColumn: string;
	readonly shareColumn: string;
}

/** Largest-remainder split of `total` by `weights`. */
function allocateTokens(weights: readonly number[], total: number): number[] | undefined {
	const sum = weights.reduce((value, weight) => value + weight, 0);
	if (!(sum > 0) || !Number.isFinite(sum)) return undefined;
	const shares = weights.map((weight, index) => {
		const exact = (total * weight) / sum;
		return { index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	const remaining = total - shares.reduce((value, share) => value + share.tokens, 0);
	const ranked = shares.toSorted((a, b) => b.remainder - a.remainder || a.index - b.index);
	for (let index = 0; index < remaining; index++) ranked[index]!.tokens++;
	return shares.map(share => share.tokens);
}

/** Current usage attributed to categories by weight, then each share to its children. */
export function allocateUsage(
	categories: readonly ContextViewCategory[],
	usage: number,
): Map<ContextViewCategory, number> | undefined {
	const allocation = new Map<ContextViewCategory, number>();
	const allocate = (siblings: readonly ContextViewCategory[], total: number): boolean => {
		const shares = allocateTokens(
			siblings.map(category => category.tokens),
			total,
		);
		if (!shares) return false;
		siblings.forEach((category, index) => {
			allocation.set(category, shares[index]!);
			if (category.children) allocate(category.children, shares[index]!);
		});
		return true;
	};
	return allocate(categories, usage) ? allocation : undefined;
}

function formatShare(tokens: number, window: number): string {
	if (window <= 0) return "—";
	const percent = (tokens / window) * 100;
	return percent > 0 && percent < 0.05 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

export function percentString(part: number, whole: number, digits = 1): string {
	if (whole <= 0) return "0%";
	const pct = (part / whole) * 100;
	return pct > 0 && pct < 0.05 ? "<0.1%" : `${pct.toFixed(digits)}%`;
}

function buildOverviewRows(
	data: ContextViewData,
	allocation: ReadonlyMap<ContextViewCategory, number> | undefined,
): OverviewRow[] {
	const rows: Omit<OverviewRow, "tokenColumn" | "shareColumn">[] = [];
	for (const category of data.categories) {
		rows.push({
			key: category.id,
			id: category.id,
			label: OVERVIEW_LABELS[category.id] ?? category.label,
			tokens: allocation?.get(category),
			category: category.entries.length > 0 ? category : undefined,
		});
		for (const child of category.children ?? []) {
			rows.push({
				key: child.key!,
				id: category.id,
				label: child.label,
				tokens: allocation?.get(child),
				category: child,
				child: true,
			});
		}
	}
	rows.push(
		{ key: "buffer", id: "buffer", label: "Auto-Compact Buffer", tokens: data.breakdown.autoCompactBufferTokens },
		{ key: "free", id: "free", label: "Free Space", tokens: data.breakdown.freeTokens },
	);
	const window = data.breakdown.contextWindow;
	const tokenWidth = Math.max(...rows.map(row => (row.tokens === undefined ? 1 : formatNumber(row.tokens).length)));
	const shareWidth = Math.max(
		...rows.map(row => (row.tokens === undefined ? 1 : formatShare(row.tokens, window).length)),
	);
	return rows.map(row => ({
		...row,
		tokenColumn: row.tokens === undefined ? "—" : formatNumber(row.tokens).padStart(tokenWidth),
		shareColumn: row.tokens === undefined ? "" : `  ${formatShare(row.tokens, window).padStart(shareWidth)}`,
	}));
}

/** Snapcompact savings notes (empty without the setting). */
function snapcompactLines(data: ContextViewData): string[] {
	const breakdown = data.breakdown;
	const snap = breakdown.snapcompact;
	if (!snap) return [];
	if (!snap.visionCapable) return ["Snapcompact: inactive (model has no image input)"];
	const lines = ["Snapcompact (estimated wire savings)"];
	const sp = snap.systemPrompt;
	if (sp) {
		const scope = sp.scope === "agents-md" ? "AGENTS.md" : "all";
		if (sp.applied) {
			const frames = `${sp.frames} frame${sp.frames === 1 ? "" : "s"}`;
			lines.push(
				`  System prompt (${scope}): saves ~${formatNumber(sp.savedTokens)} (${formatNumber(sp.textTokens)} text → ${frames} ≈ ${formatNumber(sp.imageTokens)})`,
			);
		} else {
			const reason =
				sp.reason === "budget"
					? "image budget exhausted"
					: sp.reason === "empty"
						? "nothing to image"
						: "frames would not save tokens";
			lines.push(`  System prompt (${scope}): stays text (${reason})`);
		}
	}
	const tr = snap.toolResults;
	if (tr) {
		lines.push(
			tr.swapped > 0
				? `  Tool results: saves ~${formatNumber(tr.savedTokens)} (${tr.swapped}/${tr.total} imaged, ${formatNumber(tr.textTokens)} text → ${tr.frames} frames ≈ ${formatNumber(tr.imageTokens)})`
				: `  Tool results: none imaged (${tr.total} in history)`,
		);
	}
	if (snap.savedTokens > 0) {
		lines.push(
			`  Next request: ~${formatNumber(Math.max(0, breakdown.usedTokens - snap.savedTokens))} tokens on the wire`,
		);
	}
	return lines;
}

/** Usage and compaction labels. */
export function contextUsageSummary(data: ContextViewData): { used: string; detail: string; room: string } {
	const { contextWindow: window, usedTokens, freeTokens, thresholdTokens } = data.breakdown;
	const room =
		thresholdTokens === undefined
			? `${formatNumber(freeTokens)} free`
			: usedTokens >= thresholdTokens
				? `Past auto-compaction at ${percentString(thresholdTokens, window, 0)}`
				: `${formatNumber(thresholdTokens - usedTokens)} left before auto-compaction at ${percentString(thresholdTokens, window, 0)}`;
	return {
		used: formatNumber(usedTokens),
		detail: ` of ${formatNumber(window)} tokens · ${percentString(usedTokens, window, 0)}`,
		room,
	};
}

// ─── Navigation model ───────────────────────────────────────────────────────

export type ContextViewState = "overview" | "category" | "entry";

/** What the viewer knows of the terminal drawing it natively. */
export interface ContextViewerTerminal {
	/** Width in cells: entry previews wrap to it. Default 80. */
	readonly columns?: Accessor<number>;
	/** Its clock, for timestamps. Default: the locale's. */
	readonly hour12?: Accessor<boolean | undefined>;
}

/** The viewer's navigation over one snapshot. */
export class ContextViewerModel {
	readonly rev = signal(0);
	readonly allocation: ReadonlyMap<ContextViewCategory, number> | undefined;
	/** Allocation when drawable against the window (meter and map). */
	readonly drawable: ReadonlyMap<ContextViewCategory, number> | undefined;
	readonly rows: OverviewRow[];
	readonly notes: string[];
	readonly modelLabel: string;
	state: ContextViewState = "overview";
	overviewKey: string | undefined;
	category: ContextViewCategory | undefined;
	entryId: string | undefined;
	entry: ContextViewEntry | undefined;
	entryParent: "overview" | "category" = "overview";
	/** Where the selected preview's head reveals natively. */
	previewRevealAt: "nearest" | "start" = "nearest";
	nativeScroll: ScrollRequest = { by: "start", n: 0 };
	edgeReveal: { key: string; at: "start" | "end"; n: number } | undefined;
	/** Terminal scroll of the full-content view, the legend and the previews (each moves as little as it can). */
	entryOffset = 0;
	overviewOffset = 0;
	previewOffset = 0;

	constructor(
		readonly data: ContextViewData,
		readonly terminalRows: Accessor<number>,
		readonly onClose: () => void,
		readonly terminal: ContextViewerTerminal = {},
	) {
		const { breakdown } = data;
		this.modelLabel = safeText(breakdown.model?.name ?? breakdown.model?.id ?? "no model");
		const window = breakdown.contextWindow;
		this.allocation = allocateUsage(data.categories, breakdown.usedTokens);
		this.drawable = window > 0 && Number.isFinite(window) ? this.allocation : undefined;
		this.notes = [
			...(data.notices ?? []),
			...(this.allocation
				? ["Category totals split Used by estimated share; the entries inside may not add up to them."]
				: []),
			...snapcompactLines(data),
		];
		this.rows = buildOverviewRows(data, this.allocation);
		this.overviewKey = this.rows.find(row => row.category)?.key;
	}

	touch(): void {
		this.rev.set(untrack(this.rev) + 1);
	}

	/** Header summary rows shown (Overview only), cut to the terminal. */
	summary(): string[] {
		if (this.state !== "overview") return [];
		const labels = contextUsageSummary(this.data);
		return [`Used ${labels.used}${labels.detail}`, labels.room].slice(0, Math.max(0, this.terminalRows() - 5));
	}

	/** Body rows for the current terminal height. */
	bodyRows(): number {
		return Math.max(0, Math.max(1, this.terminalRows()) - this.summary().length - 4);
	}

	selectedEntry(): ContextViewEntry | undefined {
		return this.category?.entries.find(entry => entry.id === this.entryId);
	}

	activate(): void {
		if (this.state === "overview") {
			const row = this.rows.find(r => r.key === this.overviewKey);
			if (!row?.category) return;
			this.category = row.category;
			this.entryId = row.category.entries[0]?.id;
			this.previewOffset = 0;
			this.previewRevealAt = "nearest";
			if (row.category.entries.length === 1) this.#open(row.category.entries[0]!, "overview");
			else this.state = "category";
		} else if (this.state === "category") {
			const entry = this.selectedEntry();
			if (entry) this.#open(entry, "category");
		}
	}

	#open(entry: ContextViewEntry, parent: "overview" | "category"): void {
		this.entry = entry;
		this.entryParent = parent;
		this.entryOffset = 0;
		this.state = "entry";
	}

	back(): void {
		if (this.state === "entry") {
			this.state = this.entryParent;
			if (this.entryParent === "category") this.previewRevealAt = "start";
			this.entry = undefined;
		} else if (this.state === "category") this.state = "overview";
		else this.onClose();
	}

	navigate(delta: -1 | 1): void {
		if (this.state === "overview") {
			const selectable = this.rows.filter(row => row.category);
			const at = selectable.findIndex(row => row.key === this.overviewKey);
			const next = selectable[at + delta];
			if (next) {
				this.overviewKey = next.key;
				return;
			}
			// Past the last selectable row only unselectable ones remain: reveal the legend's edge.
			const target = delta > 0 ? this.rows.at(-1) : this.rows[0];
			if (target)
				this.edgeReveal = { key: target.key, at: delta > 0 ? "end" : "start", n: (this.edgeReveal?.n ?? 0) + 1 };
			return;
		}
		if (this.state === "category") {
			const entries = this.category!.entries;
			const at = entries.findIndex(entry => entry.id === this.entryId);
			const next = entries[at + delta];
			if (next) this.entryId = next.id;
			return;
		}
		this.entryOffset = Math.max(0, this.entryOffset + delta);
		this.nativeScroll = { by: delta > 0 ? "line-down" : "line-up", n: this.nativeScroll.n + 1 };
	}

	page(direction: -1 | 1): void {
		if (this.state !== "entry") return;
		this.entryOffset = Math.max(0, this.entryOffset + direction * Math.max(1, this.bodyRows() - 1));
		this.nativeScroll = { by: direction > 0 ? "page-down" : "page-up", n: this.nativeScroll.n + 1 };
	}

	key(id: string): boolean {
		switch (listKeyId(id)) {
			case "escape":
				this.back();
				break;
			case "enter":
				this.activate();
				break;
			case "up":
				this.navigate(-1);
				break;
			case "down":
				this.navigate(1);
				break;
			case "pageUp":
				this.page(-1);
				break;
			case "pageDown":
				this.page(1);
				break;
			default:
				return false;
		}
		this.touch();
		return true;
	}

	/** Keys the viewer takes from the modal focus path. */
	capturesInput(key: string): boolean {
		const id = listKeyId(key);
		return (
			id === "escape" ||
			id === "up" ||
			id === "down" ||
			id === "enter" ||
			(this.state === "entry" && (id === "pageUp" || id === "pageDown"))
		);
	}
}

// ─── Native tree ────────────────────────────────────────────────────────────

/** Columns the native previews are wrapped for when the terminal's width is unknown (Tern wraps the rest). */
const NATIVE_COLS = 80;
const ENTRY_GUTTER = 2;

function Overview(props: { readonly model: ContextViewerModel }): JSXNode {
	const { model } = props;
	const chooseCategory = (item: string, activate: boolean): void => {
		if (!model.rows.find(row => row.key === item)?.category) return;
		model.overviewKey = item;
		if (activate) model.activate();
		model.touch();
	};
	const { breakdown } = model.data;
	const window = breakdown.contextWindow;
	const labels = contextUsageSummary(model.data);
	const drawable = model.drawable;
	const head: JSXNode[] = [];
	if (drawable) {
		const parts: { value: number; token?: string; label?: string; hatch?: boolean }[] = [];
		for (const category of model.data.categories) {
			const tokens = drawable.get(category)!;
			if (tokens <= 0) continue;
			const label = safeText(OVERVIEW_LABELS[category.id] ?? category.label);
			parts.push({
				value: tokens / window,
				token: CONTEXT_PRESENTATION[category.id].color,
				label: `${label} · ${formatNumber(tokens)} tokens (${percentString(tokens, window)})`,
			});
		}
		parts.push({
			value: breakdown.freeTokens / window,
			token: "track",
			label: `Free space · ${formatNumber(breakdown.freeTokens)} tokens (${percentString(breakdown.freeTokens, window)})`,
		});
		if (breakdown.autoCompactBufferTokens > 0) {
			parts.push({
				value: breakdown.autoCompactBufferTokens / window,
				token: "warning",
				hatch: true,
				label: `Autocompact buffer · ${formatNumber(breakdown.autoCompactBufferTokens)} tokens (${percentString(breakdown.autoCompactBufferTokens, window)})`,
			});
		}
		const threshold = breakdown.thresholdTokens;
		head.push(
			<row key="summary" role="omp.context.summary" align="baseline" wrap>
				<text
					role="omp.context.used"
					grow={1}
					wrap="none"
					spans={[
						{ s: "strong", t: labels.used },
						{ s: "dim", t: labels.detail },
					]}
				/>
				<text role="omp.context.room" wrap="none" text={labels.room} />
			</row>,
			<meter
				key="bar"
				value={Math.min(1, breakdown.usedTokens / window)}
				style="bar"
				size="lg"
				parts={parts}
				marks={
					threshold !== undefined
						? [
								{
									at: threshold / window,
									tone: "warning",
									title: `Auto-compaction at ${percentString(threshold, window, 0)} · ${formatNumber(threshold)} tokens`,
								},
							]
						: undefined
				}
				aria="Context usage by category"
			/>,
		);
	} else {
		for (const line of model.summary()) head.push(<text wrap="word" spans={[{ s: "dim", t: line }]} />);
	}
	return [
		...head,
		<col key="overview" grow={1} min={{ h: 0 }}>
			<list
				key="categories"
				actions={{ click: "select", dblclick: "activate" }}
				onSelect={item => chooseCategory(item, false)}
				onActivate={item => chooseCategory(item, true)}
				selected={model.overviewKey ?? null}
				grow={1}
				min={{ h: 0 }}
				max={{ lines: Math.max(1, model.bodyRows()) }}
			>
				{model.rows.map(row => {
					const presentation = CONTEXT_PRESENTATION[row.id];
					const selected = model.overviewKey === row.key;
					// With the meter the legend uses its bar glyphs; without it, the map's.
					const glyph = drawable
						? row.id === "buffer"
							? "▨"
							: row.id === "free"
								? "□"
								: "■"
						: symbol(presentation.symbol);
					const usage =
						row.tokens === undefined ? "—" : `${formatNumber(row.tokens)} · ${formatShare(row.tokens, window)}`;
					const edge = model.edgeReveal?.key === row.key ? model.edgeReveal : undefined;
					return (
						<item
							key={row.key}
							label={[
								{ s: presentation.color, t: `${row.child ? "  " : ""}${glyph} ` },
								selected
									? { s: `${presentation.color} strong`, t: safeText(row.label) }
									: { t: safeText(row.label) },
							]}
							value={selected ? [{ s: presentation.color, t: usage }] : usage}
							reveal={edge ? { at: edge.at, n: edge.n } : undefined}
						/>
					);
				})}
			</list>
			{model.notes.map(line => (
				<text wrap="word" spans={[{ s: "dim", t: line }]} />
			))}
		</col>,
	];
}

function Category(props: { readonly model: ContextViewerModel }): JSXNode {
	const { model } = props;
	const category = model.category!;
	const bodyRows = model.bodyRows();
	const bodyWidth = Math.max(1, (model.terminal.columns?.() ?? NATIVE_COLS) - 4);
	const hour12 = model.terminal.hour12?.();
	const groups = new Set<string>();
	const items: JSXNode[] = [];
	category.entries.forEach((entry, index) => {
		const selected = entry.id === model.entryId;
		const group = entry.thinkingGroup;
		const parts: JSXNode[] = [];
		if (group && !groups.has(group.id)) {
			groups.add(group.id);
			parts.push(<text key="group" wrap="word" lines={1} spans={groupHeaderSpans(group, category.id)} />);
		}
		const header = entryHeaderSpans(entry, category.id);
		parts.push(
			<text
				key="head"
				wrap="word"
				lines={1}
				spans={group ? [{ t: "  " }, ...header] : header}
				reveal={selected ? model.previewRevealAt : undefined}
			/>,
		);
		const preview = entryPreview(entry, {
			width: Math.max(1, bodyWidth - 1 - ENTRY_GUTTER - (group ? 2 : 0)),
			rows: previewRows(entry, bodyRows),
			sourceWidth: bodyWidth,
			hour12,
		});
		if (preview.lines.length > 0) {
			const runs: Run[] = [];
			preview.lines.forEach((line, i) => {
				if (i > 0) runs.push({ t: "\n" });
				runs.push(...line);
			});
			parts.push(<text key="preview" wrap="word" spans={runSpans(runs)} />);
		}
		// The key as the symbol preset draws it: an icon glyph there becomes the terminal's own icon span.
		if (!preview.complete)
			parts.push(
				<text
					key="hint"
					wrap="word"
					lines={1}
					spans={previewHintSpans(selected ? actionKey("tui.select.confirm") : undefined)}
				/>,
			);
		items.push(
			<col
				key={entry.id}
				gap="none"
				mark={selected ? "pick" : undefined}
				actions={{ click: "select-entry", dblclick: "open-entry" }}
				onAction={act => {
					if (act !== "select-entry" && act !== "open-entry") return;
					model.entryId = entry.id;
					if (act === "open-entry") model.activate();
					model.touch();
				}}
				reveal={selected ? { at: "nearest", n: 0 } : undefined}
			>
				{parts}
			</col>,
			<text key={`separator-${index}`} text=" " wrap="none" />,
		);
	});
	return (
		<list
			key="entries"
			grow={1}
			min={{ h: 0 }}
			max={{ lines: Math.max(1, bodyRows) }}
			hidden={bodyRows === 0 ? true : undefined}
		>
			<row key="content" gap="none" align="start">
				<spacer key="gutter" grow={0} shrink={0} min={{ w: "2ch" }} max={{ w: "2ch" }} />
				<col key="list" grow={1} min={{ w: 0 }} gap="none">
					{items}
				</col>
			</row>
		</list>
	);
}

function Entry(props: { readonly model: ContextViewerModel }): JSXNode {
	const { model } = props;
	const entry = model.entry!;
	return [
		<text spans={entryHeaderSpans(entry, model.category!.id)} />,
		<col key={`entry-${entry.id}`} scroll={model.nativeScroll}>
			{entryMetadata(entry, true, model.terminal.hour12?.()).map(line => (
				<text spans={[{ s: "dim", t: line }]} />
			))}
			<text wrap="word" spans={runSpans(entryBodyRuns(entry))} />
		</col>,
	];
}

/** The native sheet's title: `Context`, then the open category (the model on the Overview). */
export function contextHead(model: ContextViewerModel): TspSpan[] {
	const category = model.state === "overview" ? undefined : model.category;
	return [
		{ t: "Context", s: "strong" },
		{ t: ` · ${category ? safeText(category.label) : model.modelLabel}`, s: "muted" },
	];
}

export interface ContextViewerProps {
	readonly model: ContextViewerModel;
}

/** Map glyphs (`context.*` symbol keys) as the default symbol set draws them. */
const MAP_GLYPHS: Readonly<Record<string, string>> = {
	"context.content": "⛁",
	"context.messages": "⛃",
	"context.buffer": "⛝",
	"context.free": "⛶",
};

function symbol(key: string): string {
	return MAP_GLYPHS[key] ?? "■";
}

export function ContextViewer(props: ContextViewerProps): JSXNode {
	const { model } = props;
	return () => {
		model.rev();
		model.terminalRows();
		model.terminal.columns?.();
		model.terminal.hour12?.();
		return untrack(() => {
			const state = model.state;
			const children =
				state === "overview" ? (
					<Overview model={model} />
				) : state === "category" ? (
					<Category model={model} />
				) : (
					<Entry model={model} />
				);
			return (
				<col
					role="omp.context"
					grow={state === "entry" ? undefined : 1}
					min={state === "entry" ? undefined : { h: 0 }}
					term={{ model, rev: untrack(model.rev) }}
					onKey={key => model.key(key.id)}
					onAction={act => {
						if (act === "close") model.onClose();
						else if (act === "back") model.back();
						model.touch();
					}}
				>
					{children}
					<row key="actions" role="omp.actions" align="center" gap="sm">
						<spacer grow={1} />
						{state !== "overview" && <ActionButton id="back" label="Back" title="Back" />}
						<ActionButton id="close" label="Close" title="Close" />
					</row>
				</col>
			);
		});
	};
}
