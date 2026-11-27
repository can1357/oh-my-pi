/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/session` info: the session report as structured groups (identity fields
 * with copy buttons, the context-window meter, message/token/cost columns,
 * provider and MCP lists) and a Close button. The terminal shows the report
 * text as written, in a scrolling box.
 *
 * The report arrives as styled text (`Key: value` lines with a dim key, bold
 * section heads); {@link parseSessionReport} reads it back into groups.
 */
import { type Accessor, type JSXNode, signal, untrack } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspKvProps, TspSpan } from "@oh-my-pi/pi-wire";
import "../../styles/panels/session-info";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { actionKeyId, cancelKbd } from "../../keys/hints";
import { keyTitle } from "../../styles/panels/common";
import { ActionButton } from "./common";
import { rowsRole, type SheetAttributes } from "../sheet";

type TspKvItem = TspKvProps["items"][number];

/** The context-window usage shown under the identity fields. */
export interface SessionContextUsage {
	readonly tokens: number;
	readonly contextWindow: number;
	readonly percent: number;
}

/** One line of a report block: a `Key: value` pair, or a free line. */
type ReportEntry =
	| { readonly key: string; readonly value: TspSpan[]; readonly text: string }
	| { readonly line: TspSpan[] };

/** One headed block of the report. */
export interface ReportSection {
	/** Plain heading; undefined for the leading block. */
	readonly head?: string;
	readonly entries: ReportEntry[];
}

const COLOR_TOKENS = ["success", "error", "warning", "accent", "muted", "dim"] as const;

/** Styled text as spans: theme colors in `tokens` are read back as their names. */
function spansOf(styled: string, theme: Theme): TspSpan[] {
	const opens = new Map<string, string>();
	for (const token of COLOR_TOKENS) {
		const open = theme.fg(token, "\u0000").split("\u0000")[0];
		if (open) opens.set(open, token);
	}
	const spans: TspSpan[] = [];
	let style: string | undefined;
	let at = 0;
	const push = (text: string) => {
		if (text === "") return;
		const last = spans.at(-1);
		if (last && last.s === style) spans[spans.length - 1] = { ...last, t: last.t + text };
		else spans.push(style ? { s: style, t: text } : { t: text });
	};
	for (const match of styled.matchAll(/\x1b\[[0-9;]*m/g)) {
		push(styled.slice(at, match.index));
		at = match.index + match[0].length;
		const token = opens.get(match[0]);
		if (token) style = token;
		else if (match[0] === "\x1b[39m" || match[0] === "\x1b[0m") style = undefined;
	}
	push(styled.slice(at));
	return spans;
}

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

/** `<fg>Key:<reset> value`: a theme-colored key ending in a colon. */
const KV_LINE = /^\x1b\[[\d;]*m([^\x1b]+?):\x1b\[39m ?(.*)$/;
/**
 * A heading: the whole line bold, or wholly unstyled (bold is a no-op without
 * color support, while every body line starts with a theme-colored key).
 */
const HEAD_LINE = /^(?:\x1b\[1m)?([^\x1b:]+)(?:\x1b\[22m)?$/;
/** A figure the stats grid can right-align: `182,440`, `0.4127`, `$1.20`, `21%`. */
const NUMERIC = /^[$€£]?\d[\d,]*(?:\.\d+)?%?$/;

/** Read a styled report back into its blocks (see the module docs); blank lines only separate. */
export function parseSessionReport(report: string, theme: Theme): ReportSection[] {
	const sections: ReportSection[] = [{ entries: [] }];
	for (const raw of report.split("\n")) {
		if (!stripEscapes(raw).trim()) continue;
		const head = HEAD_LINE.exec(raw);
		if (head) {
			sections.push({ head: head[1]!.trim(), entries: [] });
			continue;
		}
		const pair = KV_LINE.exec(raw);
		sections
			.at(-1)!
			.entries.push(
				pair
					? { key: pair[1]!, value: spansOf(pair[2]!, theme), text: stripEscapes(pair[2]!) }
					: { line: spansOf(raw, theme) },
			);
	}
	return sections.filter(section => section.head !== undefined || section.entries.length > 0);
}

/** The identity fields' node keys, by report key. */
const IDENTITY_KEYS: Readonly<Record<string, string>> = { ID: "id", File: "file", Local: "local" };

/**
 * One line of the identity block: a label, then the value. With `copy` (its
 * tooltip) the value and a copy glyph after it are one click target.
 */
function IdentityField(props: {
	readonly label: string;
	readonly text: string;
	readonly style: string;
	readonly copy?: string;
}): JSXNode {
	const shown = <text grow={1} shrink={1} truncate="middle" spans={[{ s: props.style, t: props.text }]} />;
	return (
		<row key={IDENTITY_KEYS[props.label]} role="omp.info.field" align="center" gap="md">
			<text role="omp.info.label" shrink={0} wrap="none" spans={[{ t: props.label }]} />
			{props.copy ? (
				<row
					key="value"
					role="omp.info.copy"
					align="center"
					gap="sm"
					grow={1}
					shrink={1}
					title={props.copy}
					actions={{ click: "copy" }}
				>
					{shown}
					<icon role="omp.info.copy.ic" name="copy" aria={props.copy} />
				</row>
			) : (
				shown
			)}
		</row>
	);
}

function ContextMeter(props: { readonly usage: SessionContextUsage }): JSXNode {
	const { tokens, contextWindow, percent } = props.usage;
	const title = `${tokens.toLocaleString("en-US")} of ${contextWindow.toLocaleString("en-US")} tokens`;
	return (
		<col key="context" role="omp.info.context" title={title}>
			<row key="head" role="omp.info.contextHead" align="baseline">
				<text grow={1} shrink={1} truncate="end" spans={[{ t: "Context window" }]} />
				<text
					shrink={0}
					wrap="none"
					spans={[
						{ s: "mono muted", t: `${formatNumber(tokens)} / ${formatNumber(contextWindow)}` },
						{ t: "  " },
						{ s: "mono strong", t: `${Math.round(percent)}%` },
					]}
				/>
			</row>
			<meter
				key="meter"
				style="bar"
				size="md"
				value={Math.min(1, Math.max(0, percent / 100))}
				thresholds={{ warn: 0.7, bad: 0.9 }}
				title={title}
			/>
		</col>
	);
}

/**
 * Key/value rows, free lines as notes between them. The provider's values are
 * machine strings (`mono`); elsewhere (LSP, MCP servers) the keys are names
 * (role `omp.info.names`).
 */
function entryRows(entries: readonly ReportEntry[], mono: boolean): JSXNode[] {
	const out: JSXNode[] = [];
	let items: TspKvItem[] = [];
	const flush = (): void => {
		if (items.length === 0) return;
		out.push(<kv role={mono ? "omp.info.kv" : "omp.info.names"} layout="grid" items={items} />);
		items = [];
	};
	for (const entry of entries) {
		if (!("key" in entry)) {
			flush();
			out.push(<text role="omp.info.note" wrap="word" spans={entry.line} />);
			continue;
		}
		const v = mono ? entry.value.map(part => ({ ...part, s: part.s ? `${part.s} mono` : "mono" })) : entry.value;
		items.push({ k: mono ? sentenceCase(entry.key) : entry.key, v });
	}
	flush();
	return out;
}

/** A group of plain counts (Messages, Tokens, Cost). */
interface StatGroup {
	readonly head: string;
	readonly key: string;
	readonly items: TspKvItem[];
}

/**
 * Count groups as a two-column grid that stacks when narrow: each group goes
 * to the shorter column (report order holds when stacked), its Total last.
 */
function StatColumns(props: { readonly groups: readonly StatGroup[] }): JSXNode {
	const columns: { lines: number; children: JSXNode[] }[] = [
		{ lines: 0, children: [] },
		{ lines: 0, children: [] },
	];
	for (const group of props.groups) {
		const total = group.items.length > 1 ? group.items.find(entry => entry.k === "Total") : undefined;
		const items = total ? group.items.filter(entry => entry !== total) : group.items;
		// Ties go right, so the stacked order (left, then right) stays the report's.
		const column = columns[0]!.lines === 0 || columns[0]!.lines < columns[1]!.lines ? columns[0]! : columns[1]!;
		column.lines += group.items.length + 2;
		column.children.push(
			<section key={group.key} role="omp.info.group" head={sentenceCase(group.head)}>
				<kv role="omp.info.nums" layout="grid" items={items} />
				{total && <kv role="omp.info.total" layout="grid" items={[total]} />}
			</section>,
		);
	}
	return (
		<row key="stats" role="omp.info.stats" align="start" wrap>
			{columns
				.filter(column => column.children.length > 0)
				.map((column, index) => (
					<col key={`c${index}`} role="omp.info.column">
						{column.children}
					</col>
				))}
		</row>
	);
}

/**
 * The native groups of a parsed report, in three tiers: who the session is
 * (the id, then its file and local:// directory, copyable), how full its
 * context window is, then the report's sections as headed groups. Groups of
 * plain counts share the stats grid; the rest are key/value rows.
 */
function reportGroups(parsed: readonly ReportSection[], context: SessionContextUsage | undefined): JSXNode[] {
	// The report prints the append-only context mode after the message counts;
	// it is a provider setting, so it joins the Provider group when there is one.
	const hasProvider = parsed.some(section => section.head === "Provider");
	const moved: ReportEntry[] = [];
	const sections = parsed.map(section => ({
		head: section.head,
		entries: section.entries.filter(entry => {
			if (!hasProvider || section.head === "Provider" || !("key" in entry) || entry.key !== "Append-Only")
				return true;
			moved.push(entry);
			return false;
		}),
	}));
	sections.find(section => section.head === "Provider")?.entries.push(...moved);
	const out: JSXNode[] = [];
	let stats: StatGroup[] = [];
	const flushStats = (): void => {
		if (stats.length === 0) return;
		out.push(<StatColumns groups={stats} />);
		stats = [];
	};
	sections.forEach(({ head, entries }, index) => {
		if (head === undefined) {
			const identity: JSXNode[] = [];
			const rest: JSXNode[] = [];
			for (const entry of entries) {
				if (!("key" in entry)) rest.push(<text role="omp.info.note" wrap="word" spans={entry.line} />);
				else if (entry.key === "ID")
					identity.unshift(<IdentityField label="ID" text={entry.text} style="mono" copy="Copy session ID" />);
				else if (entry.key === "File")
					identity.push(
						entry.text.includes("/") ? (
							<IdentityField label="File" text={entry.text} style="path" copy={`Copy ${entry.text}`} />
						) : (
							<IdentityField label="File" text={entry.text} style="muted" />
						),
					);
				else if (entry.key === "Local")
					identity.push(
						<IdentityField label="Local" text={entry.text} style="path" copy={`Copy ${entry.text}`} />,
					);
				else rest.push(<kv role="omp.info.kv" items={[{ k: entry.key, v: entry.value }]} />);
			}
			if (identity.length > 0) {
				out.push(
					<col key="identity" role="omp.info.identity">
						{identity}
					</col>,
				);
			}
			out.push(...rest);
			if (context && context.contextWindow > 0) out.push(<ContextMeter usage={context} />);
			return;
		}
		const numeric = entries.length > 0 && entries.every(entry => "key" in entry && NUMERIC.test(entry.text.trim()));
		if (numeric) {
			const cost = head === "Cost";
			stats.push({
				head,
				key: `s${index}`,
				items: entries.flatMap(entry =>
					"key" in entry
						? [
								{
									k: sentenceCase(entry.key),
									v: [{ s: "mono", t: `${cost && entry.key === "Total" ? "$" : ""}${entry.text.trim()}` }],
								},
							]
						: [],
				),
			});
			return;
		}
		flushStats();
		out.push(
			<section key={`s${index}`} role="omp.info.group" head={sentenceCase(head)}>
				{entryRows(entries, head === "Provider")}
			</section>,
		);
	});
	flushStats();
	return out;
}

/** Tern's sheet: a centered medium one titled Session info. */
export const SESSION_INFO_SHEET: SheetAttributes = {
	role: "omp.overlay.sessionInfo",
	size: "md",
	anchor: "center",
	head: "Session info",
};

export interface SessionInfoProps {
	/** The styled report. */
	readonly report: string;
	/** The theme the report was styled with (to read its styles back). */
	readonly theme: Theme;
	readonly context?: SessionContextUsage;
	/** Terminal rows the box may take. */
	readonly rows: Accessor<number>;
	onClose(): void;
	/** Copy a field's value (session ID, file, local URL). */
	onCopy?(text: string): void;
}

export function SessionInfo(props: SessionInfoProps): JSXNode {
	const report = parseSessionReport(props.report, props.theme);
	const offset = signal(0);
	const viewport = () => Math.max(1, untrack(props.rows) - 4);
	const page = () => Math.max(1, viewport() - 1);
	// Clamped to the report's lines as written (rows wrapped narrower scroll a little short).
	const lineCount = props.report.split("\n").length;
	const move = (delta: number) => offset.set(Math.max(0, Math.min(untrack(offset) + delta, lineCount - viewport())));
	return (
		<col
			role={rowsRole("omp.info")}
			gap="md"
			// The terminal's box sits on the bottom rows, under what the transcript shows.
			term={() => ({ report: props.report, rows: props.rows(), offset: offset(), anchor: "bottom" })}
			onKey={key => {
				// Escape always closes the info box, whatever the cancel binding is.
				if (matchesSelectCancel(key) || key.id === "escape") {
					props.onClose();
					return true;
				}
				switch (selectKeyId(key)) {
					case "down":
						move(1);
						return true;
					case "up":
						move(-1);
						return true;
					case "pageDown":
						move(page());
						return true;
					case "pageUp":
						move(-page());
						return true;
				}
				return false;
			}}
			onAction={(act, event) => {
				if (act === "close") props.onClose();
				else if (act === "copy") {
					const field = event.key.split("/").at(-2);
					const entry = report
						.find(section => section.head === undefined)
						?.entries.find(candidate => "key" in candidate && IDENTITY_KEYS[candidate.key] === field);
					if (entry && "key" in entry) props.onCopy?.(entry.text);
				}
			}}
		>
			{reportGroups(report, props.context)}
			<row key="actions" role="omp.actions" align="center" gap="sm">
				<spacer grow={1} />
				<ActionButton
					id="close"
					label="Close"
					title={`Close  ${keyTitle(actionKeyId("tui.select.cancel", "escape"))}`}
					keys={cancelKbd()}
				/>
			</row>
		</col>
	);
}
