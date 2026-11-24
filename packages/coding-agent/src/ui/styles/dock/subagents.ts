/**
 * Terminal look of the subagents HUD (`col` `omp.hud.subagents`), one cell
 * in: a blank row; `Subagents` (bold accent) ` · 2 running` (dim) with the
 * hub key dim at the right edge; then the agents as a dim tree, one cell
 * further in: `⟳ Id: description` in accent (the `⟳` muted while the agent
 * only waits on its own agents or jobs; the id bold, a dim `⟦type⟧`
 * badge, a model badge ahead of the id), or the id and a muted assignment
 * preview; a preview row under it (`└ grep: pattern`, the tool muted while
 * live, dim with its ✔/✘ once done, `· 6.2s` in warning past five seconds);
 * then the dim expander. Every row is cut to the width. Clicks on an agent's
 * rows send `subagents.focus=<id>`, on the expander `subagents.toggle`.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { FEED_MODEL_BADGE_WIDTH, previewLine } from "../../../utils/render-utils";
import { keyLabel } from "../../keys/hints";
import { type SubagentCall, type SubagentEntry, type SubagentHudModel, subagentLayout } from "../../dock/subagents";
import { termOf } from "../messages/fill";
import { styledModelBadge } from "../tools/agent-common";

/** A running call earns an elapsed marker past this, ms. */
const ELAPSED_MIN_MS = 5000;
/** Narrowest detail worth showing after a tool name. */
const MIN_DETAIL = 8;
/** Widest detail. */
const MAX_DETAIL = 40;

function headLine(theme: Theme, entry: SubagentEntry, width: number): string {
	const accent = (text: string): string => theme.fg("accent", text);
	const dot = theme.fg(entry.waiting ? "muted" : "accent", theme.symbols.symbol("status.running"));
	const id = truncate(entry.displayId, Math.max(0, width - 2));
	const type = entry.agent?.trim();
	const badge =
		type && type !== "task"
			? truncate(
					` ${theme.fg("dim", `${theme.symbols.symbol("format.bracketLeft")}${type}${theme.symbols.symbol("format.bracketRight")}`)}`,
					Math.max(0, width - 2 - visibleWidth(id)),
				)
			: "";
	const titleRoom = Math.max(0, width - 2 - visibleWidth(id) - visibleWidth(badge));
	const model = entry.model
		? styledModelBadge(theme, entry.model, Math.min(FEED_MODEL_BADGE_WIDTH, titleRoom - 1))
		: "";
	let line = `${dot} ${model ? `${model} ` : ""}${theme.style("strong", accent(id))}${badge}`;
	if (entry.description) {
		const room = width - visibleWidth(line) - 2;
		if (room > 0) line += `${accent(":")} ${accent(truncate(entry.description, room))}`;
	} else if (entry.preview) {
		const room = width - visibleWidth(line) - 1;
		if (room > 0) line += ` ${theme.fg("muted", truncate(entry.preview, room))}`;
	}
	return truncate(line, width, "");
}

function callLine(theme: Theme, call: SubagentCall, width: number, now: number): string {
	const elapsed = call.live && call.startedAt ? now - call.startedAt : 0;
	const marker =
		elapsed > ELAPSED_MIN_MS
			? `${theme.symbols.symbol("sep.dot")}${theme.fg("warning", formatDuration(elapsed))}`
			: "";
	const hook = `${theme.fg("dim", theme.symbols.symbol("tree.hook"))} `;
	const status = call.live
		? ""
		: `${call.error ? theme.fg("error", theme.symbols.symbol("status.error")) : theme.fg("success", theme.symbols.symbol("status.success"))} `;
	const lead = visibleWidth(hook) + visibleWidth(status);
	const tool = truncate(call.tool, Math.max(0, width - lead - visibleWidth(marker)), "");
	let line = `${hook}${status}${theme.fg(call.live ? "muted" : "dim", tool)}`;
	const room = width - lead - visibleWidth(tool) - visibleWidth(marker) - 2;
	if (call.detail && room >= MIN_DETAIL)
		line += `: ${theme.fg("dim", previewLine(call.detail, Math.min(MAX_DETAIL, room)))}`;
	return truncate(`${line}${marker}`, width, "");
}

function paintSubagents(node: UiNode, cx: PaintContext): Block {
	const model = termOf<{ subagents: SubagentHudModel }>(node).subagents;
	const entries = model?.entries() ?? [];
	if (!model || entries.length === 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	const dim = (text: string): string => theme.fg("dim", text);
	const symbols = theme.symbols;
	const content = Math.max(0, cx.width - 2);
	const layout = subagentLayout(entries.length, model.expanded());
	const preview = model.livePreview();
	// Rows are the tree's content width: the outer indent and the branch take four cells.
	const rowWidth = Math.max(0, content - 4);
	const title = truncate(
		`${theme.style("strong", theme.fg("accent", "Subagents"))}${dim(`${symbols.symbol("sep.dot")}${entries.length} running`)}`,
		content,
	);
	const hubKey = model.hubKey();
	const hint = hubKey ? dim(keyLabel(theme, hubKey)) : "";
	const gap = content - visibleWidth(title) - visibleWidth(hint);
	const rows = ["", ` ${hint && gap >= 2 ? `${title}${" ".repeat(gap)}${hint}` : title}`];
	const hits: Hit[] = [];
	const shown = entries.slice(0, layout.items);
	const live = preview && shown.some(entry => entry.call?.live && entry.call.startedAt !== undefined);
	const now = live ? cx.now() : 0;
	shown.forEach((entry, index) => {
		const last = index === shown.length - 1;
		const top = rows.length;
		const branch = `${dim(symbols.symbol(last ? "tree.last" : "tree.branch"))} `;
		rows.push(` ${truncate(` ${branch}${headLine(theme, entry, rowWidth)}`, content, "")}`);
		if (preview && entry.call) {
			const hang = last ? "   " : `${dim(symbols.symbol("tree.vertical"))}  `;
			rows.push(` ${truncate(` ${hang}${callLine(theme, entry.call, rowWidth, now)}`, content, "")}`);
		}
		hits.push({
			row: top,
			col: 0,
			width: cx.width,
			height: rows.length - top,
			node,
			act: `subagents.focus=${entry.id}`,
		});
	});
	if (layout.toggle) {
		const label = layout.toggle === "expand" ? `… ${entries.length - layout.items} more — expand` : "… show less";
		hits.push({
			row: rows.length,
			col: 0,
			width: cx.width,
			height: 1,
			node,
			act: "subagents.toggle",
		});
		rows.push(` ${truncate(` ${dim(label)}`, content, "")}`);
	}
	return { rows, hits };
}

defineRolePainter("col", "omp.hud.subagents", paintSubagents);
