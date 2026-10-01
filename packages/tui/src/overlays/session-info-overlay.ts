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
	 * The sheet body (the overlay is the frame): the session id in mono
	 * (click copies), each report heading as a section of key/value rows, a
	 * context meter after the leading block, and a Close button (Esc).
	 */
	describe(cx: DescribeContext): NativeNode {
		const meter = cx.supports("meter");
		if (this.#nativeNode?.meter === meter) return this.#nativeNode.node;
		const body: NativeChild[] = [];
		for (const [index, section] of parseKvReport(this.#infoSource).entries()) {
			const children: NativeChild[] = [];
			let items: { k: string; v: TspSpan[] }[] = [];
			const flush = (): void => {
				if (items.length === 0) return;
				children.push(node("kv", { items, layout: "grid", role: "omp.info.kv" }));
				items = [];
			};
			for (const entry of section.entries) {
				if (!("k" in entry)) {
					flush();
					children.push(text(entry.line, { wrap: "word" }));
				} else if (section.head === undefined && entry.k === "ID") {
					// The id leads the sheet, once, as a copyable mono line.
					body.push(
						node(
							"text",
							{
								spans: [span(entry.v.map(part => part.t).join(""), "mono muted")],
								actions: { click: "copy" },
								title: "Copy session ID",
								truncate: "middle",
							},
							undefined,
							"id",
						),
					);
				} else {
					items.push({ k: entry.k, v: entry.v });
				}
			}
			flush();
			if (section.head === undefined) {
				body.push(node("col", { gap: "sm" }, children, `s${index}`));
				const context = this.#context;
				if (context && context.contextWindow > 0) body.push(this.#describeContext(context, meter));
			} else {
				body.push(node("section", { head: section.head }, children, `s${index}`));
			}
		}
		body.push(actionBar([null, actionButton("Close", "close", { keys: "escape" })]));
		const described = col(body, { gap: "md" });
		this.#nativeNode = { meter, node: described };
		return described;
	}

	#describeContext(context: ContextUsage, meter: boolean): NativeNode {
		const value = Math.min(1, Math.max(0, context.percent / 100));
		const figure = `${formatNumber(context.tokens)} / ${formatNumber(context.contextWindow).toLowerCase()} · ${Math.round(context.percent)}%`;
		return node(
			"row",
			{ gap: "sm", align: "center" },
			[
				text([span("Context", "muted")]),
				meter
					? node("meter", { value, style: "bar", size: "md", thresholds: { warn: 0.7, bad: 0.9 }, grow: 1 })
					: node("progress", { value, grow: 1 }),
				text([span(figure, "mono")]),
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
