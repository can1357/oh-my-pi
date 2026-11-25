/**
 * `task`: the subagent card, drawn from the call's facts (`term.task`, see
 * `src/ui/tools/task.tsx`).
 *
 * A rounded frame tinted by outcome (pending while the call streams or
 * agents run, success, error), its border muted unless an agent failed or
 * aborted. The head: the dispatch glyph `⇶` while working, else the outcome;
 * `Task`, the flat call's agent type (`: reviewer`, ` · isolated`) or the
 * agent count. Sections: the shared context and the flat brief as muted
 * markdown, then (after a divider) the spawn list while the call streams, or
 * the agent rows, the run footer and trailing notices; a result without
 * details shows its text.
 *
 * Also `omp.task.nested` (a `text` node's terminal role): settled child task
 * snapshots as tree rows.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/index";
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { isTaskToolDetails, type TaskToolDetails } from "../../../task/task-details";
import { expandKeyLabel } from "../../keys/hints";
import { agentColored } from "../../tools/agent-identity";
import { cleanText } from "../../tools/agent-common";
import type { TaskTerm } from "../../tools/task";
import { assignmentSource, contextSource, flatAgentLabel, noticeLines, runTally } from "../../tools/task/model";
import { agentLines, callLines, type Line, nestedResultLines, type RowContext } from "../../tools/task/rows";
import { type FrameSection, frameInner, frameRows, outcomeBg, statusLine } from "./frame";
import { defineToolLook, isExpanded, toolProps } from "./look";

/** Markdown sections render this many cells narrower than the card. */
const MARKDOWN_INSET = 3;
/** The act of a running agent's rows: focus that agent (`subagents.focus=<id>`, as the dock's HUD rows). */
const SUBAGENT_FOCUS_ACT = "subagents.focus=";

/** A row drawn: theme tokens, agent names in their identity colour. */
function ink(theme: Theme, line: Line): string {
	let out = "";
	for (const part of line) {
		const styled = part.s ? theme.style(part.s, part.t) : part.t;
		out += part.agent ? agentColored(theme, part.agent, styled) : styled;
	}
	return out;
}

function rowContext(cx: PaintContext, expanded: boolean, facts: Pick<TaskTerm, "nowMs" | "frozen">): RowContext {
	return {
		glyph: key => cx.theme.symbols.symbol(key),
		expandKey: () => expandKeyLabel(cx.theme),
		expanded,
		nowMs: facts.nowMs,
		frozen: facts.frozen,
	};
}

/** A markdown section (context or brief), muted prose. */
function markdownSection(theme: Theme, source: string, width: number): FrameSection | undefined {
	if (!source) return undefined;
	return { lines: renderMarkdown(source, Math.max(1, width - MARKDOWN_INSET), { theme, textStyle: "muted" }) };
}

type Outcome = "pending" | "success" | "warning" | "error";

function paintTask(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const facts = props.term?.task as TaskTerm | undefined;
	if (!facts) return EMPTY_BLOCK;
	const { theme, width } = cx;
	const expanded = isExpanded(props);
	const rows = rowContext(cx, expanded, facts);
	const args = facts.args;
	const label = flatAgentLabel(args);
	const sections: FrameSection[] = [];
	const context = markdownSection(theme, contextSource(args), width);
	const brief = markdownSection(theme, assignmentSource(args), width);
	const inkLines = (lines: readonly Line[]): string[] => lines.map(line => ink(theme, line));
	const glyph = (key: string, color: string): string => theme.fg(color, theme.symbols.symbol(key));
	let head: string;
	let outcome: Outcome;
	let border = "borderMuted";

	if (facts.phase === "call") {
		outcome = "pending";
		head = statusLine(theme, { glyph: glyph("tool.task", "accent"), title: "Task", description: label });
		if (args?.isolated === true) head += `${theme.symbols.symbol("sep.dot")}isolated`;
		if (!facts.hasResult) {
			if (context) sections.push(context);
			if (brief) sections.push(brief);
			const lines = callLines(rows, args);
			if (lines.length > 0) sections.push({ separator: true, lines: inkLines(lines) });
		}
	} else if (!facts.details || !isTaskToolDetails(facts.details)) {
		const errored = facts.isError === true;
		outcome = errored ? "error" : "success";
		if (errored) border = "error";
		head = statusLine(theme, {
			glyph: errored ? glyph("status.error", "error") : glyph("status.success", "success"),
			title: "Task",
			description: label,
		});
		if (context) sections.push(context);
		if (brief) sections.push(brief);
		const text = cleanText(facts.text ?? "");
		if (text) sections.push({ separator: true, lines: [theme.fg("dim", truncate(text, width))] });
	} else {
		const details: TaskToolDetails = facts.details;
		const tally = runTally(details.results);
		const failed = tally.aborted + tally.failed > 0;
		outcome = facts.isPartial ? "pending" : failed ? "error" : tally.mergeFailed > 0 ? "warning" : "success";
		if (failed) border = "error";
		const count = details.results.length > 0 ? details.results.length : (details.progress?.length ?? 0);
		const meta = count > 0 ? `${count} ${count === 1 ? "agent" : "agents"}` : label;
		const headGlyph = facts.isPartial
			? glyph("tool.task", "accent")
			: failed
				? glyph("status.error", "error")
				: tally.mergeFailed > 0
					? glyph("status.warning", "warning")
					: glyph("status.success", "success");
		head = statusLine(theme, { glyph: headGlyph, title: "Task", meta: meta ? [meta] : undefined });
		// A live card's running agents: their rows focus the agent on click and band under the pointer.
		const owners: (string | undefined)[] = [];
		const lines = inkLines(agentLines(rows, details, tally, frameInner(width), facts.frozen ? undefined : owners));
		if (context) sections.push(context);
		if (brief) sections.push(brief);
		if (lines.length === 0) {
			const text = facts.text?.trim() ? facts.text : "No results";
			sections.push({ separator: true, lines: [theme.fg("dim", truncate(text, width))] });
		} else {
			for (const line of noticeLines(facts.text ?? "")) lines.push(theme.fg("dim", line));
			sections.push({ separator: true, lines, tags: owners });
		}
		if (owners.some(id => id !== undefined)) {
			const rowTags: (string | undefined)[] = [];
			const band = cx.hovered(node)?.item;
			const painted = frameRows(theme, width, { head, sections, border, bg: outcomeBg(outcome), band }, rowTags);
			return { rows: painted, hits: agentHits(node, rowTags, width) };
		}
	}
	return { rows: frameRows(theme, width, { head, sections, border, bg: outcomeBg(outcome) }) };
}

/** One hit per run of rows a running agent draws, naming it (`item`) and focusing it on click. */
function agentHits(node: UiNode, rowTags: readonly (string | undefined)[], width: number): Hit[] {
	const hits: Hit[] = [];
	for (let row = 0; row < rowTags.length;) {
		const id = rowTags[row];
		let end = row + 1;
		while (end < rowTags.length && rowTags[end] === id) end++;
		if (id !== undefined)
			hits.push({ row, col: 0, width, height: end - row, node, item: id, act: `${SUBAGENT_FOCUS_ACT}${id}` });
		row = end;
	}
	return hits;
}

defineToolLook("task", { paint: paintTask, margin: true });

/** Facts of a nested-results text node. */
interface NestedTerm {
	readonly snapshots: readonly TaskToolDetails[];
	readonly expanded: boolean;
}

function paintNested(node: UiNode, cx: PaintContext): Block {
	const facts = (node.props() as { term?: NestedTerm }).term;
	if (!facts) return EMPTY_BLOCK;
	const rows = rowContext(cx, facts.expanded, { nowMs: cx.now(), frozen: false });
	const out: string[] = [];
	for (const line of nestedResultLines(rows, facts.snapshots, Number.POSITIVE_INFINITY))
		out.push(...wrap(ink(cx.theme, line), cx.width));
	return { rows: out };
}

defineRolePainter("text", "omp.task.nested", paintNested);
