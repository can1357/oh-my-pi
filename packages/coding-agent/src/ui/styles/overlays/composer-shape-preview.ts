/**
 * Terminal look of the composer-shape preview (`omp.preview.composer-shape`):
 * a blank row, a muted `Preview:`, then the shape's chrome around the prompt
 * (caret at its end) at the width given (at least 24 cells) — the status in
 * its top chrome as the shape attaches it — and the shape's bottom status
 * bar, after a blank row when the shape asks for one.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { spaces, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { composerTextColor } from "@oh-my-pi/pi-tui/theme/theme";
import { PREVIEW_PROMPT, type ComposerShapePreviewLook } from "../../overlays/composer-shape-preview";
import {
	type ComposerChromeContext,
	type ComposerStatusContent,
	composerShape,
	type StatusAttachment,
} from "../composer/shapes";

/** The status a preview shows, already bound to a paint (see `StatusChrome`). */
export interface PreviewStatus {
	/** Status for the shape's top chrome at `width` cells. */
	top(attachment: StatusAttachment, width: number): ComposerStatusContent | undefined;
	/** The bottom bar with `groups` at `width` cells ("" when nothing shows). */
	bottom(groups: "full" | "left", width: number): string;
}

/** Narrowest preview. */
const MIN_WIDTH = 24;

/** The SGR pair `styled` wraps around a marker. */
function sgrPair(styled: string): [string, string] {
	const at = styled.indexOf("\u0000");
	return [styled.slice(0, at), styled.slice(at + 1)];
}

/** The composer surface (its background and text color) over `text`, kept across the text's resets. */
function surface(theme: Theme, text: string): string {
	const [bg] = sgrPair(theme.bg("userMessageBg", "\u0000"));
	const [fg] = sgrPair(theme.fgResolved("userMessageText", "\u0000"));
	const body = text.replace(/\x1b\[(0|39|49)?m/g, reset =>
		reset === "\x1b[39m" ? `${reset}${fg}` : reset === "\x1b[49m" ? `${reset}${bg}` : `${reset}${bg}${fg}`,
	);
	return `${bg}${fg}${body}\x1b[39m\x1b[49m`;
}

/**
 * The preview's chrome rows for shape `id` at `width` cells (at least 24),
 * without the `Preview:` heading; usable outside a paint (setup's preview).
 */
export function composerShapePreviewRows(theme: Theme, id: string, width: number, status?: PreviewStatus): string[] {
	width = Math.max(MIN_WIDTH, width);
	const shape = composerShape(id);
	const paddingX = shape.paddingX;
	const side = shape.sideWidth(paddingX);
	const content =
		status && shape.statusAttachment ? status.top(shape.statusAttachment, Math.max(1, width - side * 2)) : undefined;
	const chrome: ComposerChromeContext = {
		width,
		paddingX,
		theme,
		border: text => theme.fg("borderAccent", text),
		accent: text => theme.fg("accent", text),
		surface: text => surface(theme, text),
		box: theme.symbols.box,
		...(content ? { status: content } : {}),
	};
	const gutter = shape.gutter ?? "";
	const contentWidth = Math.max(1, width - side * 2 - visibleWidth(gutter));
	const prompt = truncate(PREVIEW_PROMPT, Math.max(1, contentWidth - 1), theme.symbols.ellipsis);
	const caret = `${prompt}${theme.style("inverse", " ")}`;
	const rows: string[] = [];
	const top = shape.top?.(chrome);
	if (top !== undefined) rows.push(top);
	rows.push(
		...shape.row({
			...chrome,
			text: shape.filled ? caret : composerTextColor(theme, caret),
			pad: spaces(contentWidth - visibleWidth(prompt) - 1),
			gutter: gutter ? theme.fg("accent", gutter) : "",
			first: true,
			last: true,
			overflow: 0,
		}),
	);
	const bottom = shape.bottom?.(chrome);
	if (bottom !== undefined) rows.push(bottom);
	const bar = shape.bottomBar ?? "none";
	if (bar !== "none" && status) {
		const row = status.bottom(bar, width);
		if (row) {
			if (shape.bottomBarGap) rows.push("");
			rows.push(row);
		}
	}
	return rows;
}

function paintPreview(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { term?: ComposerShapePreviewLook };
	const look = props.term;
	const chrome = look?.status;
	const status: PreviewStatus | undefined = chrome && {
		top: (attachment, width) => chrome.composerStatus(cx, attachment, width),
		bottom: (groups, width) => chrome.bottomBar(cx, groups, width),
	};
	const rows = look ? composerShapePreviewRows(cx.theme, look.shape, cx.width, status) : [];
	return { rows: ["", cx.theme.style("muted", "Preview:"), ...rows] };
}

defineRolePainter("col", "omp.preview.composer-shape", paintPreview);
