/**
 * The status line in a composer's top chrome (`omp.status.top`, see
 * `createStatusLine`), one row at the cells the chrome offers:
 *
 * - `top-border` (box): the left and right groups on the status background,
 *   their segments joined by the configured separator and closed by powerline
 *   caps (none on a transparent bar), the context gauge between them.
 * - `top-band` (band): the same, opened flush left by the soft band cap and
 *   without the session title (the working row carries it).
 * - `top-rule-chip` (claude, rule): the right group alone as a chip on the
 *   status background, joined by the status separator, no caps.
 *
 * The gauge is a rule in the session accent up to the context share and in
 * the border color after it. With `contextLine: "embedded"` (default) the
 * context segments leave the groups and the gauge carries their percent and
 * window labels; `annotated`/`embedded` also mark where background
 * compaction starts and where auto-compaction fires.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { fitStatus } from "@oh-my-pi/pi-tui/term/painters/status";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { fgSgr } from "@oh-my-pi/pi-tui/theme/color";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { adjustHsv, formatNumber } from "@oh-my-pi/pi-utils";
import type { StatusLineSeparatorStyle } from "../../../config/status-line-schema";
import { sessionAccentHex } from "../../status/accent";
import type { StatusTopLook } from "../../status/status-line";

const RESET = "\x1b[0m";
const BG_DEFAULT = "\x1b[49m";

interface Separator {
	readonly left: string;
	readonly right: string;
	/** Powerline caps closing the groups (drawn with the bar's fill as their color). */
	readonly caps?: { readonly left: string; readonly right: string };
}

function separatorOf(style: StatusLineSeparatorStyle, theme: Theme): Separator {
	const sym = (key: string) => theme.symbols.symbol(key);
	const caps = { left: sym("sep.powerlineRight"), right: sym("sep.powerlineLeft") };
	switch (style) {
		case "powerline":
			return { left: sym("sep.powerlineLeft"), right: sym("sep.powerlineRight"), caps };
		case "slash":
			return { left: sym("sep.slash").trim(), right: sym("sep.slash").trim() };
		case "pipe":
			return { left: sym("sep.pipe").trim(), right: sym("sep.pipe").trim() };
		case "block":
			return { left: sym("sep.block"), right: sym("sep.block") };
		case "none":
			return { left: sym("sep.space"), right: sym("sep.space") };
		case "ascii":
			return { left: sym("sep.asciiLeft"), right: sym("sep.asciiRight") };
		default:
			return { left: sym("sep.powerlineThinLeft"), right: sym("sep.powerlineThinRight"), caps };
	}
}

/** The SGR `styled` opens before its text. */
function bgSgr(theme: Theme, key: string): string {
	const styled = theme.bg(key, "\u0000");
	return styled.slice(0, styled.indexOf("\u0000"));
}

/** Live-work badges the bar adds in front of the configured right segments. */
const BADGES = new Set(["subagent-badge", "jobs"]);

const isContext = (node: UiNode) => node.key() === "context_pct" || node.key() === "context_total";

function embeddedPercent(percent: number): string {
	return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/** Cells the embedded gauge needs for its labels (the window label alone while usage is unknown). */
function embeddedWidth(percent: number | null, window: number): number {
	return (percent === null ? 0 : embeddedPercent(percent).length + 2) + formatNumber(window).length + 2;
}

/** The gauge rule of `width` cells between the groups. */
function gauge(look: StatusTopLook, width: number, embedded: boolean, cx: PaintContext): string {
	const { theme } = cx;
	const accentHex = look.accent ? sessionAccentHex(theme, look.accent) : undefined;
	const lit = accentHex ? fgSgr(accentHex, theme.depth) : theme.fgSgr("borderAccent");
	const rule = theme.symbols.box.horizontal;
	const mode = look.contextLine ?? "embedded";
	const { percent, window } = look.context;
	if (mode === "off" || (percent === null && window <= 0)) return `${BG_DEFAULT}${lit}${rule.repeat(width)}\x1b[39m`;

	const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
	const overflow = percent !== null && percent > 100;
	let percentLabel = "";
	let windowLabel = "";
	let percentStart = -1;
	let windowStart = -1;
	let scale = width;
	if (embedded && width >= embeddedWidth(percent, window)) {
		percentLabel = percent === null ? "" : embeddedPercent(overflow ? percent : clamped);
		windowLabel = formatNumber(window);
		if (overflow) {
			percentStart = width - percentLabel.length;
			windowStart = percentStart - 1 - windowLabel.length;
		} else windowStart = width - windowLabel.length - 1;
		scale = windowStart;
	}
	// At least one lit cell, so a fresh session still shows its accent.
	const used = Math.min(scale, Math.max(1, Math.round((clamped / 100) * scale)));

	let speculationAt = -1;
	let thresholdAt = -1;
	if ((mode === "annotated" || mode === "embedded") && look.autoCompact && look.compaction && width >= 8) {
		const cell = (at: number) => Math.min(scale - 1, Math.max(0, Math.round((at / 100) * scale)));
		thresholdAt = cell(look.compaction.thresholdPercent);
		if (look.compaction.speculationPercent !== null) speculationAt = cell(look.compaction.speculationPercent);
		if (speculationAt === thresholdAt) speculationAt = -1;
	}
	if (percentLabel && percentStart < 0) {
		const last = scale - percentLabel.length - 1;
		const preferred = Math.min(last, Math.max(1, used));
		const hitsMark = (start: number) =>
			(speculationAt >= start && speculationAt < start + percentLabel.length) ||
			(thresholdAt >= start && thresholdAt < start + percentLabel.length);
		for (let distance = 0; distance <= last; distance++) {
			const before = preferred - distance;
			if (before >= 1 && !hitsMark(before)) {
				percentStart = before;
				break;
			}
			if (distance === 0) continue;
			const after = preferred + distance;
			if (after <= last && !hitsMark(after)) {
				percentStart = after;
				break;
			}
		}
	}

	const dimmed = fgSgr(adjustHsv(accentHex ?? theme.hex("borderAccent"), { s: 0.7, v: 0.75 }), theme.depth);
	const unused = theme.fgSgr("border");
	const percentEnd = percentStart >= 0 ? percentStart + percentLabel.length : -1;
	const windowEnd = windowStart >= 0 ? windowStart + windowLabel.length : -1;
	let out = BG_DEFAULT;
	let active = "";
	let i = 0;
	while (i < width) {
		let color: string;
		let text: string;
		if (i >= percentStart && i < percentEnd) {
			const end = Math.min(percentEnd, width);
			color = overflow ? theme.fgSgr("error") : lit;
			text = percentLabel.slice(i - percentStart, end - percentStart);
			i = end;
		} else if (i === thresholdAt) {
			color = dimmed;
			text = theme.symbols.symbol("context.compaction");
			i++;
		} else if (i === speculationAt) {
			color = theme.fgSgr("muted");
			text = theme.symbols.symbol("context.speculation");
			i++;
		} else {
			const inWindow = i >= windowStart && i < windowEnd;
			let end = Math.min(inWindow ? windowEnd : i < used ? used : width, width);
			for (const mark of [percentStart, thresholdAt, speculationAt, inWindow ? -1 : windowStart]) {
				if (mark > i && mark < end) end = mark;
			}
			if (inWindow) {
				color = dimmed;
				text = windowLabel.slice(i - windowStart, end - windowStart);
			} else {
				color = i < used ? lit : unused;
				text = rule.repeat(end - i);
			}
			i = end;
		}
		if (color !== active) {
			out += color;
			active = color;
		}
		out += text;
	}
	return `${out}\x1b[39m`;
}

function paintTop(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { term?: StatusTopLook };
	const look = props.term;
	if (!look) return EMPTY_BLOCK;
	const { theme, width } = cx;
	const chip = look.attachment === "top-rule-chip";
	const band = look.attachment === "top-band";
	const sep: Separator = chip ? { left: "·", right: "·" } : separatorOf(look.separator, theme);
	const bg = look.transparent ? BG_DEFAULT : bgSgr(theme, "statusLineBg");
	const caps = sep.caps && !look.transparent ? sep.caps : undefined;
	const bandCap = band && caps ? theme.symbols.symbol("sep.powerlineCapLeft") : "";

	let segs = look.segs;
	if (band) segs = segs.filter(seg => seg.key() !== "session_name");
	const { percent, window } = look.context;
	const embedded =
		!chip &&
		look.contextLine === "embedded" &&
		window > 0 &&
		segs.some(isContext) &&
		segs.some(seg => !isContext(seg) && !BADGES.has(seg.key() ?? ""));
	if (embedded) segs = segs.filter(seg => !isContext(seg));
	const gaugeWidth = embedded ? embeddedWidth(percent, window) : 0;

	const fit = fitStatus(cx, segs, {
		separatorWidth: visibleWidth(sep.left),
		groups: chip ? "right" : "both",
		groupExtra: {
			left: (caps ? visibleWidth(caps.right) : 0) + visibleWidth(bandCap),
			right: caps ? visibleWidth(caps.left) : 0,
		},
		minGap: ({ segs: count, leftWidth, rightWidth }) => {
			if (!gaugeWidth) return leftWidth > 0 && rightWidth > 0 ? 1 : 0;
			return count === 1 && leftWidth + rightWidth + gaugeWidth > width ? 1 : gaugeWidth;
		},
	});
	if (fit.left.length === 0 && fit.right.length === 0) return EMPTY_BLOCK;

	const fg = theme.fgSgr("text");
	const sepSgr = theme.fgSgr("statusLineSep");
	const capSgr = bg.replace("\x1b[48;", "\x1b[38;");
	const unfaint = look.faint ? "\x1b[22m" : "";
	const group = (texts: readonly string[], separator: string): string =>
		texts.length === 0 ? "" : `${bg}${fg} ${texts.join(` ${sepSgr}${separator}${fg} `)} ${RESET}`;
	const left = group(
		fit.left.map(seg => seg.text),
		sep.left,
	);
	const right = group(
		fit.right.map(seg => seg.text),
		sep.right,
	);
	const leftRow = left
		? (bandCap ? `${capSgr}${unfaint}${bandCap}${RESET}` : "") +
			left +
			(caps ? `${capSgr}${unfaint}${caps.right}${RESET}` : "")
		: "";
	const rightRow = right ? (caps ? `${capSgr}${unfaint}${caps.left}${RESET}` : "") + right : "";
	let row: string;
	if (width === 0 || (chip && (!leftRow || !rightRow))) row = leftRow + (leftRow && rightRow ? " " : "") + rightRow;
	else row = leftRow + gauge(look, Math.max(1, width - fit.leftWidth - fit.rightWidth), embedded, cx) + rightRow;
	if (look.faint) row = `\x1b[2m${row.replaceAll(RESET, `${RESET}\x1b[2m`)}\x1b[22m`;
	return { rows: [row] };
}

defineRolePainter("status", "omp.status.top", paintTop);
