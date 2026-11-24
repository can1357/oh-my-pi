/**
 * The looks Markdown roles take under a theme. Plain mode draws headings in
 * `mdHeading` and emphasis as bare attributes; colorful mode (the default)
 * takes distinct hues for headings by depth, emphasis, inline code and table
 * headers from the theme's terminal palette.
 */
import type { Theme } from "../../theme/contract";

/** Palette slots of the colorful look. */
const MAGENTA = 5;
const YELLOW = 3;
const BLUE = 4;
const GREEN = 2;
/** Colorful heading hue per depth (H1, H2, H3 and deeper). */
const HEADING_SLOTS = [MAGENTA, YELLOW, BLUE] as const;

/** Styling functions per Markdown role. */
export interface MarkdownStyles {
	readonly theme: Theme;
	heading(depth: number, text: string): string;
	code(text: string): string;
	strong(text: string): string;
	em(text: string): string;
	strike(text: string): string;
	underline(text: string): string;
	bold(text: string): string;
	tableHeader(text: string): string;
	link(text: string): string;
	linkUrl(text: string): string;
	/** An extension link's label (a scheme the host registered). */
	extensionLink(text: string): string;
	codeBlock(text: string): string;
	codeBorder(text: string): string;
	quote(text: string): string;
	quoteBorder(text: string): string;
	rule(text: string): string;
	bullet(text: string): string;
}

/** Role styles of `theme`, colorful or plain. */
export function markdownStyles(theme: Theme, colorful: boolean): MarkdownStyles {
	const bold = (text: string): string => theme.style("strong", text);
	const italic = (text: string): string => theme.style("em", text);
	const fg =
		(color: string) =>
		(text: string): string =>
			theme.fg(color, text);
	const base = {
		theme,
		strike: (text: string) => theme.style("strike", text),
		underline: (text: string) => theme.style("underline", text),
		bold,
		link: fg("mdLink"),
		linkUrl: fg("mdLinkUrl"),
		extensionLink: fg("mdExtensionLink"),
		codeBlock: fg("mdCodeBlock"),
		codeBorder: fg("mdCodeBlockBorder"),
		quote: (text: string) => theme.fg("mdQuote", italic(text)),
		quoteBorder: fg("mdQuoteBorder"),
		rule: fg("mdHr"),
		bullet: fg("mdListBullet"),
	};
	if (!colorful) {
		return {
			...base,
			heading: (_depth, text) => theme.fg("mdHeading", text),
			code: fg("mdCode"),
			strong: bold,
			em: italic,
			tableHeader: bold,
		};
	}
	return {
		...base,
		heading: (depth, text) => theme.palette(HEADING_SLOTS[Math.min(depth, HEADING_SLOTS.length) - 1]!, text),
		code: text => theme.palette(GREEN, text),
		strong: text => theme.palette(MAGENTA, bold(text)),
		em: text => theme.palette(MAGENTA, italic(text)),
		tableHeader: text => theme.palette(YELLOW, bold(text)),
	};
}

/** The escape sequences `style` opens with: what restores it after a nested run closed. */
export function stylePrefix(style: (text: string) => string): string {
	const probe = style("\u0000");
	const at = probe.indexOf("\u0000");
	return at === -1 ? "" : probe.slice(0, at);
}
