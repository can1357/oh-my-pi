import { type Component, Markdown, visibleWidth, wrapTextWithAnsi } from "../index";
import { getMarkdownTheme, theme } from "../theme/theme";
import { card, col, md, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { type BtwInjectParts, formatBtwInjectText } from "./btw-history";
import { sanitizeDisplayText } from "./extensions/display-text";

/** Labels a steering prompt that has not been sent yet. */
export const BTW_INJECT_LABEL = "Inject into main session";
/** Labels a sent steering prompt. */
export const BTW_INJECTED_LABEL = "Injected into main session";

/** A displayed `<inject>` block: still sendable, or sent. Blocks in neither state render as plain text. */
export type BtwInjectState = "pending" | "sent";

/**
 * Terminal lines for an `<inject>` block: every wrapped line behind a gutter of the `btw.rail`
 * (pink while pending, green once sent) and the send arrow (`nav.selected`) or blanks as wide,
 * then the label on the row below. Both states take the same rows and text column, so sending
 * recolours the block in place.
 */
function renderBlockLines(inject: string, width: number, sent: boolean): string[] {
	const arrow = theme.nav.selected;
	const color = sent ? "success" : "customMessageLabel";
	const marker = sent ? arrow : " ".repeat(visibleWidth(arrow));
	const prefix = `${theme.fg(color, theme.symbol("btw.rail"))} ${theme.bold(marker)} `;
	const inner = Math.max(1, width - visibleWidth(prefix));
	const body = formatBtwInjectText(inject)
		.split("\n")
		.flatMap(line => (line.trim() ? wrapTextWithAnsi(line, inner) : [""]))
		.map(line => `${prefix}${line}`);
	return [...body, `${prefix}${theme.fg(color, sent ? BTW_INJECTED_LABEL : BTW_INJECT_LABEL)}`];
}

/** Text-mode answer split around its `<inject>` block: prose, the railed block, prose, a blank row apart. */
export class BtwInjectAnswer implements Component {
	readonly #inject: string;
	readonly #sent: boolean;
	readonly #before: Markdown | undefined;
	readonly #after: Markdown | undefined;

	constructor(parts: BtwInjectParts, sent: boolean) {
		this.#inject = parts.inject;
		this.#sent = sent;
		this.#before = prose(parts.before);
		this.#after = prose(parts.after);
	}

	render(width: number): string[] {
		return [
			...(this.#before ? [...this.#before.render(width), ""] : []),
			...renderBlockLines(this.#inject, width, this.#sent),
			...(this.#after ? ["", ...this.#after.render(width)] : []),
		];
	}

	invalidate(): void {
		this.#before?.invalidate();
		this.#after?.invalidate();
	}
}

function prose(text: string): Markdown | undefined {
	const trimmed = text.trim();
	return trimmed ? new Markdown(sanitizeDisplayText(trimmed), 0, 0, getMarkdownTheme()) : undefined;
}

/**
 * The same answer for native surfaces. They wrap text themselves, so a per-row gutter cannot
 * follow wrapped lines: a card toned like the rail (`user` pending, `success` sent) marks the
 * whole block instead, with the label as its last row.
 */
export function describeBtwInjectAnswer(parts: BtwInjectParts, sent: boolean, stream: boolean): NativeNode {
	const before = parts.before.trim();
	const after = parts.after.trim();
	const label = sent ? `${theme.nav.selected} ${BTW_INJECTED_LABEL}` : BTW_INJECT_LABEL;
	const block = card({ role: "omp.btw.inject", tone: sent ? "success" : "user" }, [
		...formatBtwInjectText(parts.inject)
			.split("\n")
			.map(line => text(line, { wrap: "word" })),
		text([span(label, sent ? "success" : "customMessageLabel")]),
	]);
	return col(
		[
			...(before ? [md(sanitizeDisplayText(before), { stream })] : []),
			block,
			...(after ? [md(sanitizeDisplayText(after), { stream })] : []),
		],
		{ gap: "sm" },
	);
}
