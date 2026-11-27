/**
 * Side-answer looks: the `<inject>` card (a tone bar, a bold `➤` once sent,
 * the block's lines and its state label) and the `/btw` sheet (a rounded
 * box titled with the topic, the answer, and a footer of status and hints).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TspTextProps } from "@oh-my-pi/pi-wire";
import { boxRows, hintText, plainText, propsOf, roleOf, termOf } from "./common";

defineRolePainter("card", "omp.btw.inject", (node, cx): Block => {
	const theme = cx.theme;
	const sent = (node.props() as { tone?: string }).tone === "success";
	const color = sent ? "success" : "customMessageLabel";
	const prefix = `${theme.fg(color, "▎")} ${theme.style("strong", sent ? "➤" : " ")} `;
	const children = node.children();
	const rows: string[] = [];
	const width = Math.max(1, cx.width - 4);
	children.forEach((child, index) => {
		const props = propsOf<TspTextProps>(child);
		if (index === children.length - 1) {
			const label = plainText(props.spans ?? props.text).replace(/^➤ /, "");
			rows.push(`${prefix}${theme.fg(color, label)}`);
			return;
		}
		const lines = wrap(props.text ?? "", width);
		if (lines.length === 0) rows.push(prefix);
		for (const line of lines) rows.push(`${prefix}${line}`);
	});
	return { rows };
});

/** Terminal facts of the `/btw` sheet. */
interface BtwSheetTerm {
	readonly title: string;
	readonly copied?: boolean;
}

const TONE_COLORS: Readonly<Record<string, string>> = { success: "success", warning: "warning", error: "error" };

/**
 * A titled sheet (`/btw`, `/omfg`): the `term.title` (plus a copy badge) on a
 * rounded box, the body children between the head and the footer, then the
 * footer: status and hints joined by ` · ` (all in the sheet's tone when it
 * has one).
 */
export function paintSheet(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const width = cx.width;
	if (width < 4) return EMPTY_BLOCK;
	const inner = width - 4;
	const term = termOf<BtwSheetTerm>(node);
	const content: string[] = [""];
	const children = node.children();
	for (const [index, child] of children.slice(1, -1).entries()) {
		const rows = cx.paint(child, inner).rows;
		if (index > 0) content.push("");
		// An empty text still takes its row.
		content.push(...(rows.length === 0 && child.kind === "text" ? [""] : rows));
	}
	const footer = children.at(-1);
	if (footer && children.length > 1) {
		if (content.length > 1) content.push("");
		content.push(...wrap(footerText(node, footer, theme), inner));
	}
	const title = `${(term.title ?? "").replace(/[\r\n]+/g, " ")}${term.copied ? " ✓ Copied" : ""}`;
	return { rows: boxRows(theme, title, content, width) };
}

defineRolePainter("col", "omp.overlay.btw", paintSheet);

function footerText(sheet: UiNode, footer: UiNode, theme: Theme): string {
	if (footer.kind === "text") return styledText(theme, propsOf<TspTextProps>(footer).spans);
	if (roleOf(footer) === "omp.overlay.hints") return theme.fg("muted", hintText(footer, " · "));
	const [status, hints] = footer.children();
	const statusProps = status ? propsOf<TspTextProps>(status) : {};
	const hintLine = hints ? ` · ${hintText(hints, " · ")}` : "";
	const tone = TONE_COLORS[(sheet.props() as { tone?: string }).tone ?? ""];
	if (tone) return theme.fg(tone, `${plainText(statusProps.spans)}${hintLine}`);
	return `${styledText(theme, statusProps.spans)}${theme.fg("muted", hintLine)}`;
}
