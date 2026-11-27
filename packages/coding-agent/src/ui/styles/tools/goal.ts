/**
 * The `goal` look: a pending call is one line (`⏳ Goal: set "objective" ·
 * budget 50K`); a result is a card (`╭─── ◎ Goal: check ⟦paused⟧ ───╮`) with
 * the objective in quotes, the usage and the completion report, on the
 * status background; no goal is one warning line.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { GoalTerm } from "../../tools/goal";
import { type FrameSection, frameRows } from "./frame";
import { defineToolLook, toolProps } from "./look";

/** Objective characters a pending call / a card shows. */
const CALL_OBJECTIVE = 60;
const CARD_OBJECTIVE = 100;

function paintGoal(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as GoalTerm | undefined;
	if (!term) return { rows: [] };
	const theme = cx.theme;
	const title = `${theme.fg("accent", "Goal")}: ${theme.fg("muted", term.op)}`;
	const quote = (text: string, max: number) => theme.style("em", theme.fg("muted", `"${truncate(text, max)}"`));
	if (!term.result) {
		const facts: string[] = [];
		if (term.objective) facts.push(quote(term.objective, CALL_OBJECTIVE));
		if (term.budget) facts.push(term.budget);
		const glyph = theme.fg("muted", theme.symbols.symbol("status.pending"));
		return {
			rows: wrap(`${glyph} ${title}${facts.length > 0 ? ` ${theme.fg("dim", facts.join(" · "))}` : ""}`, cx.width),
		};
	}
	if (term.empty !== undefined) {
		const glyph = theme.fg("warning", theme.symbols.symbol("status.warning"));
		return {
			rows: wrap(`${glyph} ${title} ${theme.fg("dim", term.empty)}`, cx.width),
		};
	}
	const failed = term.error !== undefined;
	const glyph = failed
		? theme.fg("error", theme.symbols.symbol("status.error"))
		: theme.fg("accent", theme.symbols.symbol("tool.goal"));
	let head = `${glyph} ${title}`;
	if (term.status) {
		const color = (term.statusStyle ?? "muted").split(" ")[0]!;
		const left = theme.symbols.symbol("format.bracketLeft");
		const right = theme.symbols.symbol("format.bracketRight");
		head += ` ${theme.style(color, `${left}${term.status}${right}`)}`;
	}
	const sections: FrameSection[] = [];
	if (failed) sections.push({ lines: [`  ${theme.fg("error", term.error!)}`] });
	else {
		const lines: string[] = [];
		if (term.objective) lines.push(quote(term.objective, CARD_OBJECTIVE));
		if (term.usage) lines.push(theme.fg("dim", term.usage));
		sections.push({ lines });
		if (term.report)
			sections.push({
				label: "Report",
				lines: term.report.split("\n").map(line => theme.fg("muted", line)),
			});
	}
	return {
		rows: frameRows(theme, cx.width, {
			head,
			sections,
			border: failed ? "error" : "borderMuted",
			bg: failed ? "toolErrorBg" : "toolSuccessBg",
		}),
	};
}

defineToolLook("goal", { paint: paintGoal, margin: true });
