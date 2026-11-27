/**
 * Skill invocations (`card` role `omp.skill`).
 *
 * - Callout (the skill led the draft): a `userMessageBg` box one row and one
 *   cell in, behind a `customMessageLabel` rail (`▎`) down its left edge; the
 *   skill chip as a soft pill and the muted prompt size head it, the rest of
 *   the draft follows as bubble Markdown.
 * - Inline (the skill sat mid-prompt): the draft as a user bubble with the
 *   chip inline; expanded, a callout with the chip and the prompt follows.
 * - Expanded, the callout ends with a muted `prompt` subhead and the loaded
 *   skill prompt.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TermChip } from "../../transcript/messages/chips";
import { fillRow, termOf } from "./fill";
import { fileLink } from "../tools/file-common";
import { bubbleMarkdown } from "./user";
import { RowText } from "../rendered-text";

interface SkillTerm {
	label: string;
	/** The skill's SKILL.md: the pill links to it. */
	path?: string;
	lines?: string;
	leading: boolean;
	draft: string;
	chips: readonly TermChip[];
	prompt: string;
	expanded: boolean;
}

const BG = "userMessageBg";

function paintSkill(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const term = termOf<SkillTerm>(node);
	const width = cx.width;
	const boxWidth = Math.max(1, width - 1);
	const inner = Math.max(1, boxWidth - 2);
	const pill = fileLink(
		cx,
		theme.bg("customMessageBg", theme.fg("customMessageLabel", `\x1b[1m${term.label ?? ""}\x1b[22m`)),
		term.path,
		1,
	);
	const header = term.lines ? `${pill}  ${theme.fg("muted", term.lines)}` : pill;
	const content = new RowText().literal(...wrap(header, inner));
	if (term.leading && term.draft)
		content
			.literal("")
			.block(bubbleMarkdown(theme, term.draft, inner, { chips: term.chips, hyperlinks: cx.hyperlinks }));
	if (term.expanded && term.prompt)
		content
			.literal("")
			.literal(theme.fg("muted", "prompt"))
			.literal("")
			.block(bubbleMarkdown(theme, term.prompt, inner, {}));
	const rail = theme.bg(BG, theme.fg("customMessageLabel", theme.symbols.symbol("skill.rail")));
	const railRow = (row: string): string => rail + fillRow(theme, BG, row === "" ? "" : ` ${row}`, boxWidth);
	const callout = new RowText()
		.deco(railRow(""))
		.block(content.done(), 2, content.rows.map(railRow))
		.deco(railRow(""))
		.done();
	if (term.leading) return callout;
	const out = new RowText();
	if (term.draft) {
		const bubble = bubbleMarkdown(theme, term.draft, width, {
			chips: term.chips,
			padding: 1,
			hyperlinks: cx.hyperlinks,
		});
		// The fill adds escapes and padding only.
		out.block(
			bubble,
			0,
			bubble.rows.map(row => fillRow(theme, BG, row, width)),
		);
	}
	if (term.expanded) out.block(callout);
	return out.done();
}

defineRolePainter("card", "omp.skill", paintSkill);
