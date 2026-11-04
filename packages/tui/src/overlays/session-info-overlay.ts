import { type Component, Ellipsis, matchesKey, ScrollView, Text, truncateToWidth } from "../index";
import { theme } from "../theme/theme";
import { matchesSelectCancel } from "../keybinding-matchers";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { formatKeyHints } from "../app-keybindings";
import { editorKey } from "../chrome/keybinding-hints";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { col, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { plainText, styledSpans } from "../native/spans";
import type { ContextUsage } from "../status-line/types";
const PANEL_CHROME_ROWS = 4;

/** One headed block of a key/value report. */
interface KvReportSection {
	/** Plain heading; undefined for the leading block. */
	readonly head?: string;
	/** Entries in order: key/value pairs, or free lines that aren't pairs. */
	readonly entries: readonly KvReportEntry[];
}

type KvReportEntry = { readonly k: string; readonly v: TspSpan[] } | { readonly line: TspSpan[] };

/** `<fg>Key:<reset> value`: a theme-coloured key ending in a colon. */
const KV_LINE = /^\x1b\[[\d;]*m([^\x1b]+?):\x1b\[39m ?(.*)$/;
/**
 * A heading: the whole line bold, or wholly unstyled (bold is a no-op without
 * colour support, while every body line starts with a theme-coloured key).
 */
const HEAD_LINE = /^(?:\x1b\[1m)?([^\x1b:]+)(?:\x1b\[22m)?$/;

/**
 * Parse a report of `theme.bold` headings and `theme.fg("dim", "Key:") value`
 * lines (the `/session` info format) into sections. Blank lines only separate.
 */
function parseKvReport(report: string): KvReportSection[] {
	const sections: { head?: string; entries: KvReportEntry[] }[] = [{ entries: [] }];
	for (const raw of report.split("\n")) {
		if (!plainText(raw).trim()) continue;
		const head = HEAD_LINE.exec(raw);
		if (head) {
			sections.push({ head: plainText(head[1]).trim(), entries: [] });
			continue;
		}
		const current = sections[sections.length - 1];
		const pair = KV_LINE.exec(raw);
		if (pair) current.entries.push({ k: plainText(pair[1]), v: styledSpans(pair[2]) });
		else current.entries.push({ line: styledSpans(raw) });
	}
	return sections.filter(section => section.head !== undefined || section.entries.length > 0);
}

/** The plain text of `spans`. */
function joined(spans: readonly TspSpan[]): string {
	return spans.map(part => part.t).join("");
}

/** A figure the stats grid can right-align: `182,440`, `0.4127`, `$1.20`, `21%`. */
const NUMERIC = /^[$€£]?\d[\d,]*(?:\.\d+)?%?$/;

/** A report key or heading in sentence case: `Tool Calls` → `Tool calls`; acronyms (`MCP`, `ACU`) stay. */
function sentenceCase(label: string): string {
	let first = true;
	return label.replace(/[A-Za-z]+/g, word => {
		if (first) {
			first = false;
			return word;
		}
		return /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word;
	});
}

/**
 * One line of the identity block: a sans label, then the value. With `copy`
 * (its tooltip) the value and a copy glyph after it are one target: a click
 * copies the value (the terminal-local `copy` action takes the leaf text; the
 * icon has none).
 */
function identityField(label: string, value: TspSpan[], key: string, copy?: string): NativeNode {
	const shown = text(value, { truncate: "middle", grow: 1, shrink: 1 });
	return node(
		"row",
		{ gap: "md", align: "center", role: "omp.info.field" },
		[
			text([span(label)], { role: "omp.info.label", wrap: "none", shrink: 0 }),
			copy
				? node(
						"row",
						{
							gap: "sm",
							align: "center",
							grow: 1,
							shrink: 1,
							role: "omp.info.copy",
							actions: { click: "copy" },
							title: copy,
						},
						[shown, node("icon", { name: "copy", role: "omp.info.copy.ic", aria: copy })],
						"value",
					)
				: shown,
		],
		key,
	);
}

/** Terminal surface needed to size the session info viewport. */
export interface SessionInfoOverlayHost {
	readonly terminal: {
		readonly rows: number;
	};
}

/** Focused, dismissible `/session` information panel. */
export class SessionInfoOverlay implements Component {
	/** The terminal draws the sheet: a centred `md` glass sheet titled Session info. */
	readonly nativeOverlay = {
		role: "omp.overlay.sessionInfo",
		size: "md",
		anchor: "center",
		head: "Session info",
	} as const;
	readonly #host: SessionInfoOverlayHost;
	readonly #onClose: () => void;
	readonly #context: ContextUsage | undefined;
	readonly #panel: OverlayPanel;
	readonly #info: Text;
	readonly #scrollView: ScrollView;
	readonly #footer: PanelRows;
	readonly #infoSource: string;
	#nativeNode: { meter: boolean; node: NativeNode } | undefined;
	#lastInfoWidth: number | undefined;
	#lastInfoLines: readonly string[] | undefined;
	#lastHeight: number | undefined;

	/** `context` adds a context-window meter to the native sheet. */
	constructor(host: SessionInfoOverlayHost, info: string, onClose: () => void, context?: ContextUsage) {
		this.#host = host;
		this.#onClose = onClose;
		this.#context = context;
		this.#infoSource = info;
		this.#info = new Text(info, 0, 0);
		this.#scrollView = new ScrollView([], {
			height: 0,
			scrollbar: "auto",
			ellipsis: Ellipsis.Omit,
			theme: {
				track: text => theme.fg("dim", text),
				thumb: text => theme.fg("accent", text),
			},
		});
		this.#footer = new PanelRows();
		this.#footer.setHeight(1);
		this.#panel = new OverlayPanel("Session Info");
		this.#panel.addChild(this.#scrollView);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data) || matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.#onClose();
			return;
		}
		this.#scrollView.handleScrollKey(data);
	}

	invalidate(): void {
		this.#info.invalidate();
		this.#lastInfoWidth = undefined;
		this.#lastInfoLines = undefined;
		this.#lastHeight = undefined;
		this.#panel.invalidate();
	}

	setIgnoreTight(ignore: boolean): this {
		this.#info.setIgnoreTight(ignore);
		this.#panel.setIgnoreTight(ignore);
		return this;
	}

	dispose(): void {
		this.#panel.dispose();
	}

	/**
	 * The sheet body (the overlay is the frame), in three tiers: who the session
	 * is (the id and file as copyable mono fields), how full its context window
	 * is (a meter under a right-aligned figure), then the report's sections as
	 * headed groups. Groups of plain counts (Messages, Tokens, Cost) share a
	 * two-column stats grid with right-aligned figures and their Total set off
	 * last; the rest (Provider, servers) are key/value rows. A Close button (Esc)
	 * ends it.
	 */
	describe(cx: DescribeContext): NativeNode {
		const meter = cx.supports("meter");
		if (this.#nativeNode?.meter === meter) return this.#nativeNode.node;
		// The report prints the append-only context mode after the message counts;
		// it is a provider setting, so it joins the Provider group when there is one.
		const parsed = parseKvReport(this.#infoSource);
		const hasProvider = parsed.some(section => section.head === "Provider");
		const moved: KvReportEntry[] = [];
		const sections = parsed.map(section => ({
			head: section.head,
			entries: section.entries.filter(entry => {
				if (!hasProvider || section.head === "Provider" || !("k" in entry) || entry.k !== "Append-Only")
					return true;
				moved.push(entry);
				return false;
			}),
		}));
		sections.find(section => section.head === "Provider")?.entries.push(...moved);
		const body: NativeChild[] = [];
		const stats: { head: string; key: string; items: { k: string; v: TspSpan[] }[] }[] = [];
		const flushStats = (): void => {
			if (stats.length > 0) body.push(this.#describeStats(stats.splice(0)));
		};
		for (const [index, { head, entries }] of sections.entries()) {
			if (head === undefined) {
				// The session's identity: its id, then its file (copyable when it is one).
				const identity: NativeChild[] = [];
				const rest: NativeChild[] = [];
				for (const entry of entries) {
					if (!("k" in entry)) rest.push(text(entry.line, { wrap: "word", role: "omp.info.note" }));
					else if (entry.k === "ID")
						identity.unshift(identityField("ID", [span(joined(entry.v), "mono")], "id", "Copy session ID"));
					else if (entry.k === "File") {
						const path = joined(entry.v);
						identity.push(
							path.includes("/")
								? identityField("File", [span(path, "path")], "file", `Copy ${path}`)
								: identityField("File", [span(path, "muted")], "file"),
						);
					} else rest.push(node("kv", { items: [{ k: entry.k, v: entry.v }], role: "omp.info.kv" }));
				}
				if (identity.length > 0) body.push(node("col", { role: "omp.info.identity" }, identity, "identity"));
				body.push(...rest);
				const context = this.#context;
				if (context && context.contextWindow > 0) body.push(this.#describeContext(context, meter));
				continue;
			}
			const pairs = entries.filter((entry): entry is { k: string; v: TspSpan[] } => "k" in entry);
			if (
				pairs.length > 0 &&
				pairs.length === entries.length &&
				pairs.every(p => NUMERIC.test(joined(p.v).trim()))
			) {
				const cost = head === "Cost";
				stats.push({
					head,
					key: `s${index}`,
					items: pairs.map(p => ({
						k: sentenceCase(p.k),
						v: [span(cost && p.k === "Total" ? `$${joined(p.v).trim()}` : joined(p.v).trim(), "mono")],
					})),
				});
				continue;
			}
			flushStats();
			body.push(
				node(
					"section",
					{ head: sentenceCase(head), role: "omp.info.group" },
					this.#describeEntries(entries, head === "Provider"),
					`s${index}`,
				),
			);
		}
		flushStats();
		body.push(actionBar([null, actionButton("Close", "close", { keys: "escape" })]));
		const described = col(body, { gap: "md" });
		this.#nativeNode = { meter, node: described };
		return described;
	}

	/**
	 * Key/value rows, free lines as notes between them. The provider's values are
	 * machine strings (`mono`); elsewhere (LSP, MCP servers) the keys are names
	 * (role `omp.info.names`, keys in mono).
	 */
	#describeEntries(entries: readonly KvReportEntry[], mono: boolean): NativeChild[] {
		const children: NativeChild[] = [];
		let items: { k: string; v: TspSpan[] }[] = [];
		const flush = (): void => {
			if (items.length === 0) return;
			children.push(node("kv", { items, layout: "grid", role: mono ? "omp.info.kv" : "omp.info.names" }));
			items = [];
		};
		for (const entry of entries) {
			if (!("k" in entry)) {
				flush();
				children.push(text(entry.line, { wrap: "word", role: "omp.info.note" }));
				continue;
			}
			const v = mono ? entry.v.map(part => ({ ...part, s: part.s ? `${part.s} mono` : "mono" })) : entry.v;
			items.push({ k: mono ? sentenceCase(entry.k) : entry.k, v });
		}
		flush();
		return children;
	}

	/**
	 * Count groups as a two-column grid that stacks when narrow: each group goes
	 * to the shorter column (report order holds when stacked), its Total last
	 * over a hairline.
	 */
	#describeStats(groups: readonly { head: string; key: string; items: { k: string; v: TspSpan[] }[] }[]): NativeNode {
		const columns: { lines: number; children: NativeChild[] }[] = [
			{ lines: 0, children: [] },
			{ lines: 0, children: [] },
		];
		for (const g of groups) {
			const total = g.items.length > 1 ? g.items.find(item => item.k === "Total") : undefined;
			const items = total ? g.items.filter(item => item !== total) : g.items;
			const children: NativeChild[] = [node("kv", { items, layout: "grid", role: "omp.info.nums" })];
			if (total) children.push(node("kv", { items: [total], layout: "grid", role: "omp.info.total" }));
			// Ties go right, so the stacked order (left, then right) stays the report's.
			const column = columns[0].lines === 0 || columns[0].lines < columns[1].lines ? columns[0] : columns[1];
			column.lines += g.items.length + 2;
			column.children.push(node("section", { head: sentenceCase(g.head), role: "omp.info.group" }, children, g.key));
		}
		return node(
			"row",
			{ align: "start", wrap: true, role: "omp.info.stats" },
			columns
				.filter(column => column.children.length > 0)
				.map((column, i) => node("col", { role: "omp.info.column" }, column.children, `c${i}`)),
			"stats",
		);
	}

	/** The context window: a head row (label, `41K / 200K`, the share) over a full-width meter. */
	#describeContext(context: ContextUsage, meter: boolean): NativeNode {
		const value = Math.min(1, Math.max(0, context.percent / 100));
		const title = `${context.tokens.toLocaleString("en-US")} of ${context.contextWindow.toLocaleString("en-US")} tokens`;
		return node(
			"col",
			{ role: "omp.info.context", title },
			[
				node(
					"row",
					{ align: "baseline", role: "omp.info.contextHead" },
					[
						text([span("Context window")], { grow: 1, shrink: 1, truncate: "end" }),
						text(
							[
								span(`${formatNumber(context.tokens)} / ${formatNumber(context.contextWindow)}`, "mono muted"),
								span("  "),
								span(`${Math.round(context.percent)}%`, "mono strong"),
							],
							{ wrap: "none", shrink: 0 },
						),
					],
					"head",
				),
				meter
					? node(
							"meter",
							{ value, style: "bar", size: "md", thresholds: { warn: 0.7, bad: 0.9 }, title },
							undefined,
							"meter",
						)
					: node("progress", { value }, undefined, "meter"),
			],
			"context",
		);
	}

	/** The Close button runs Esc's path. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "close") this.#onClose();
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		const footerHint = `${formatKeyHints(["up", "down"])} scroll · ${editorKey("tui.select.cancel")} close`;
		this.#footer.setLines([theme.fg("dim", truncateToWidth(footerHint, innerWidth))]);

		const maxBodyHeight = Math.max(1, this.#host.terminal.rows - PANEL_CHROME_ROWS);
		const fullWidthInfoLines = this.#info.render(innerWidth);
		const infoWidth = fullWidthInfoLines.length > maxBodyHeight ? Math.max(1, innerWidth - 1) : innerWidth;
		const infoLines = infoWidth === innerWidth ? fullWidthInfoLines : this.#info.render(infoWidth);
		if (this.#lastInfoWidth !== infoWidth || this.#lastInfoLines !== infoLines) {
			this.#scrollView.setLines(infoLines);
			this.#lastInfoWidth = infoWidth;
			this.#lastInfoLines = infoLines;
		}

		const height = Math.max(1, Math.min(infoLines.length, maxBodyHeight));
		if (this.#lastHeight !== height) {
			this.#scrollView.setHeight(height);
			this.#lastHeight = height;
		}
		return this.#panel.render(width);
	}
}
