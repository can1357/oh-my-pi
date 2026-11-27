/**
 * `agent`: one subagent as a row — status glyph (the spinner while it runs),
 * name, `⟦type⟧` and badges, its task, then the running tool or its stats
 * (`3 req · 9.0s`) — with its children (the expanded content) indented under
 * it unless it is folded. A retry adds a warning row.
 */
import type { TspAgentProps } from "@oh-my-pi/pi-wire";
import { truncate, wrap } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type PaintContext } from "../paint";
import { blockText, lazyText, mapWrappedText, offsetRenderedText, type RenderedTextRow } from "../text-layout";
import { headText } from "./card";
import { formatDuration } from "./elapsed";
import { styledText } from "./layout";
import { spinnerFrame } from "./spinner";

const STATUS: Record<TspAgentProps["status"], { readonly symbol: string; readonly color: string }> = {
	pending: { symbol: "status.pending", color: "muted" },
	running: { symbol: "status.running", color: "accent" },
	done: { symbol: "status.success", color: "success" },
	failed: { symbol: "status.error", color: "error" },
	aborted: { symbol: "status.aborted", color: "warning" },
	idle: { symbol: "status.success", color: "muted" },
	parked: { symbol: "status.pending", color: "dim" },
};

function glyph(props: TspAgentProps, cx: PaintContext): string {
	if (props.status === "running" && !cx.reduceMotion) return cx.theme.fg("accent", spinnerFrame(cx));
	const look = STATUS[props.status] ?? STATUS.pending;
	return cx.theme.fg(look.color, cx.theme.symbols.symbol(look.symbol));
}

/** The facts after an agent's task: the running tool, else requests, tokens and time. */
function facts(props: TspAgentProps): string[] {
	if (props.tool) {
		const intent =
			props.tool.intent === undefined
				? ""
				: `: ${typeof props.tool.intent === "string" ? props.tool.intent : props.tool.intent.map(span => span.t).join("")}`;
		return [`${props.tool.name}${intent}`];
	}
	const stats = props.stats ?? {};
	const out: string[] = [];
	if (stats.requests) out.push(`${stats.requests} req`);
	if (stats.tokens) out.push(`${stats.tokens >= 1000 ? `${(stats.tokens / 1000).toFixed(1)}k` : stats.tokens} tok`);
	const ms = stats.took ?? stats.age;
	if (ms !== undefined) out.push(formatDuration(ms));
	return out;
}

definePainter("agent", (node, cx): Block => {
	if (cx.width <= 0) return EMPTY_BLOCK;
	const props = node.props() as TspAgentProps;
	const theme = cx.theme;
	// The glyph (the spinner while it runs) is chrome: the head's text stays put as it turns.
	const chrome = `${glyph(props, cx)} `;
	let label = theme.style("strong", props.name);
	if (props.agent) label += ` ${theme.fg("dim", `⟦${props.agent}⟧`)}`;
	for (const badge of props.badges ?? []) label += ` ${theme.fg(badge.tone ?? "muted", `[${badge.text}]`)}`;
	if (props.task !== undefined) label += ` ${theme.fg("muted", styledText(theme, props.task))}`;
	const meta = facts(props);
	if (meta.length > 0) label += ` ${theme.fg("dim", meta.join(" · "))}`;
	const rows = [truncate(`${chrome}${label}`, cx.width)];
	const retry = props.retry
		? theme.fg(
				"warning",
				`  retry ${props.retry.attempt}/${props.retry.max}${props.retry.error ? ` · ${props.retry.error}` : ""}`,
			)
		: "";
	const retryRows = retry ? wrap(retry, cx.width) : [];
	rows.push(...retryRows);
	const blocks: Block[] = [];
	if (!props.collapsed) {
		for (const child of node.children()) {
			const block = cx.paint(child, Math.max(1, cx.width - 2));
			blocks.push(block);
			for (const row of block.rows) rows.push(`  ${row}`);
		}
	}
	const text = lazyText(() => {
		const out: (RenderedTextRow | undefined)[] = [headText(chrome, label, rows[0]!, 0)];
		out.push(...mapWrappedText(retry, retryRows));
		for (const block of blocks) for (const row of blockText(block)) out.push(offsetRenderedText(row, 2));
		return out;
	});
	return { rows, text };
});
