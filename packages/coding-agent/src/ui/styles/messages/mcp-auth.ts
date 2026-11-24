/**
 * The MCP OAuth fallback link (`col` role `omp.mcp.auth-link`): the prompt,
 * a clickable `Click here to authorize` (OSC 8 when the terminal draws
 * hyperlinks), then the full URL as the `Copy URL:` target, and the local
 * `/launch` shortcut when there is one.
 *
 * A labelled URL stays on its label's row when it fits; otherwise the label
 * takes its own row and the URL is hard-wrapped into width-sized chunks that
 * start at column 0. Continuation chunks carry no leading bytes on purpose: a
 * multi-row terminal selection keeps any indent, and while address bars strip
 * newlines they keep or percent-encode embedded spaces — an indent would
 * corrupt the URL at every chunk boundary (silently, inside a query value).
 * So no trailing OAuth parameter is ever cut off (#4418). Where the terminal
 * draws hyperlinks, every chunk links to the full URL (#20192).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { hyperlink } from "@oh-my-pi/pi-tui/text/osc";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { termOf } from "./fill";

/** The narrowest URL chunk: below it the terminal is unusable, but every character still shows. */
const MIN_WRAP_WIDTH = 16;

/** Terminal facts of the link block. */
export interface McpAuthLinkTerm {
	url: string;
	/** The flow's local shortcut, when it differs from `url`. */
	launchUrl?: string;
}

/**
 * Label and URL rows. With `hyperlinks`, every chunk links to the full `url`
 * under one OSC 8 id: unlinked chunks let terminal URL auto-detection open
 * only the clicked row, a truncated authorize request (#20192).
 */
function urlRows(theme: Theme, label: string, url: string, width: number, hyperlinks: boolean): string[] {
	const sanitized = replaceTabs(url);
	const effective = Math.max(MIN_WRAP_WIDTH, Math.trunc(width));
	const id = Bun.hash(url).toString(36);
	const link = (text: string) => (hyperlinks ? hyperlink(text, url, id) : text);
	if (1 + label.length + 1 + sanitized.length <= effective)
		return [` ${theme.fg("muted", `${label} ${link(sanitized)}`)}`];
	const rows = [` ${theme.fg("muted", label)}`];
	for (let i = 0; i < sanitized.length; i += effective)
		rows.push(theme.fg("muted", link(sanitized.slice(i, i + effective))));
	return rows;
}

/** The block's rows at `width` (see the module docs). */
export function mcpAuthLinkRows(theme: Theme, term: McpAuthLinkTerm, width: number, hyperlinks: boolean): string[] {
	const label = "Click here to authorize";
	return [
		` ${theme.fg("success", "Open authorization URL:")}`,
		` ${theme.fg("accent", hyperlinks ? hyperlink(label, term.url) : label)}`,
		...urlRows(theme, "Copy URL:", term.url, width, hyperlinks),
		...(term.launchUrl
			? urlRows(theme, "Local shortcut (this machine only):", term.launchUrl, width, hyperlinks)
			: []),
	];
}

function paintAuthLink(node: UiNode, cx: PaintContext): Block {
	const term = termOf<McpAuthLinkTerm>(node);
	if (!term.url) return { rows: [] };
	return { rows: mcpAuthLinkRows(cx.theme, { url: term.url, launchUrl: term.launchUrl }, cx.width, cx.hyperlinks) };
}

defineRolePainter("col", "omp.mcp.auth-link", paintAuthLink);
