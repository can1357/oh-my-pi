/**
 * Terminal look of the status line (`src/ui/status/status-line.tsx`): the
 * standalone bottom bar — no background, segments joined by the theme's
 * status separator, the groups at the row's edges — and the extension
 * statuses under it, each cut to the width with its own colors kept.
 *
 * - `omp.status.panel` (`col`): a blank row above the bar when the placement
 *   asks for it, the bar unless the composer keeps it (`none`) or the
 *   completion menu has its row, then the hook rows.
 * - `omp.status` (`status`): the bar, its left group only for `left`.
 * - `omp.status.*` (`seg`): a segment drawn from its look pieces.
 * - `omp.status.hook` (`text`): one extension status.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { stack } from "@oh-my-pi/pi-tui/term/painters/layout";
import { SPINNER_INTERVAL_MS } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { statusRow } from "@oh-my-pi/pi-tui/term/painters/status";
import { truncate, truncateStart, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { FG_DEFAULT, fgSgr } from "@oh-my-pi/pi-tui/theme/color";

/** `from` → `to` at `t` (0…1), as `rrggbb`. */
function blendHex(from: string, to: string, t: number): string {
	const channel = (hex: string, at: number) => Number.parseInt(hex.replace("#", "").slice(at, at + 2), 16);
	let out = "";
	for (const at of [0, 2, 4]) {
		const value = Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * t);
		out += value.toString(16).padStart(2, "0");
	}
	return out;
}
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { sanitizeInlineStatusText } from "../../../modes/view-model/chrome/shared";
import { sessionAccentHex } from "../../status/accent";
import { BRAND_FADE_MS } from "../../status/facts";
import type { IconPiece, LookPiece, SegLook } from "../../status/look";
import type { StatusBarLook, StatusHookLook, StatusPanelLook } from "../../status/status-line";

/** Paints look pieces under one theme and session accent. */
class LookPainter {
	readonly #theme: Theme;
	readonly #accent: string | undefined;
	readonly #accentHex: string | undefined;
	readonly #cx: PaintContext;

	constructor(cx: PaintContext, title: string | undefined) {
		this.#cx = cx;
		this.#theme = cx.theme;
		this.#accentHex = sessionAccentHex(cx.theme, title);
		this.#accent = this.#accentHex === undefined ? undefined : fgSgr(this.#accentHex, cx.theme.depth);
	}

	/**
	 * The brand's style: `tokens`, or within {@link BRAND_FADE_MS} of a working-state edge the
	 * color eased (cubic in-out) from `fadeFrom`'s toward it.
	 */
	#brandStyle(tokens: string, fadeFrom: string | undefined, fadeAt: number | undefined): string {
		if (fadeFrom === undefined || fadeAt === undefined || this.#cx.reduceMotion) return tokens;
		const t = (this.#cx.now() - fadeAt) / BRAND_FADE_MS;
		if (t >= 1) return tokens;
		const from = this.#hex(fadeFrom);
		const to = this.#hex(tokens);
		if (!from || !to) return tokens;
		const eased = t <= 0 ? 0 : t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
		return `#${blendHex(from, to, eased)}`;
	}

	#hex(tokens: string): string | undefined {
		if (tokens.includes("sessionAccent") && this.#accentHex) return this.#accentHex;
		const key = tokens.replace("sessionAccent", "accent").split(" ")[0]!;
		return this.#theme.has(key) ? this.#theme.hex(key) : undefined;
	}

	/** Foreground SGR of `tokens`' color (for re-opening it inside extension text); "" when unknown. */
	colorSgr(tokens: string): string {
		if (tokens.includes("sessionAccent") && this.#accent) return this.#accent;
		const key = tokens.replace("sessionAccent", "accent").split(" ")[0]!;
		const theme = this.#theme;
		return theme.has(key) ? theme.fgSgr(key) : "";
	}

	style(tokens: string | undefined, text: string): string {
		if (!tokens || !text) return text;
		if (tokens.startsWith("#")) return `${fgSgr(tokens, this.#theme.depth)}${text}${FG_DEFAULT}`;
		if (!tokens.includes("sessionAccent")) return this.#theme.style(tokens, text);
		if (this.#accent) return `${this.#accent}${text}${FG_DEFAULT}`;
		return this.#theme.style(tokens.replace("sessionAccent", "accent"), text);
	}

	link(text: string, href: string | undefined): string {
		return href && this.#cx.hyperlinks ? `\x1b]8;;${href}\x07${text}\x1b]8;;\x07` : text;
	}

	glyph(piece: IconPiece): string {
		const names = typeof piece.icon === "string" ? [piece.icon] : piece.icon;
		for (const name of names) {
			const glyph = this.#theme.symbols.icon(name);
			if (glyph) return piece.lead ? glyph.split(" ")[0]! : glyph;
		}
		return "";
	}

	piece(piece: LookPiece): string {
		if ("t" in piece) return this.link(this.style(piece.s, piece.t), piece.href);
		if ("icon" in piece) {
			const glyph = this.glyph(piece);
			if (!glyph) return piece.else === undefined ? "" : this.style(piece.s, piece.else);
			const space = piece.space ?? "after";
			if (space === "none") return this.link(this.style(piece.s, glyph), piece.href);
			const icon = this.link(
				this.style(piece.s, piece.bare ? glyph : space === "after" ? `${glyph} ` : ` ${glyph}`),
				piece.href,
			);
			if (!piece.bare) return icon;
			return space === "after" ? `${icon} ` : ` ${icon}`;
		}
		if ("statuses" in piece) return this.statuses(piece.statuses, piece.s);
		return this.brand(
			piece.brand,
			this.#brandStyle(piece.s, piece.fadeFrom, piece.fadeAt),
			piece.awaiting,
			piece.profile,
		);
	}

	statuses(statuses: readonly string[], tokens: string): string {
		const fg = this.colorSgr(tokens);
		const separator = `${this.colorSgr("dim")}${this.#theme.symbols.symbol("sep.dot")}${fg}`;
		let out = "";
		for (const status of statuses) {
			const text = sanitizeInlineStatusText(status, { fg });
			if (text) out += out ? `${separator}${text}` : text;
		}
		return out ? `${fg}${out}${FG_DEFAULT}` : "";
	}

	brand(since: number | null, tokens: string, awaiting: boolean | undefined, profile: string | undefined): string {
		const tag = (glyph: string) => (profile ? (glyph ? `${glyph}-${profile}` : profile) : glyph);
		if (since === null) return this.style(tokens, tag(this.#theme.symbols.icon("omp")));
		const cx = this.#cx;
		const now = cx.now();
		let glyph = this.#theme.symbols.symbol("cmd.question") || "?";
		if (!awaiting) {
			const frames = this.#theme.symbols.activityFrames;
			glyph = cx.reduceMotion
				? (frames[0] ?? "")
				: (frames[Math.floor(now / SPINNER_INTERVAL_MS) % frames.length] ?? "");
		}
		const seconds = Math.max(0, Math.floor((now - since) / 1000));
		const timer =
			seconds < 60
				? `${seconds}s`
				: seconds < 3600
					? `${Math.floor(seconds / 60)}m`
					: `${Math.min(99, Math.floor(seconds / 3600))}h`;
		return this.style(tokens, `${tag(glyph)} ${timer}`);
	}

	/** The look at `width` cells, cut from the end it names. */
	row(look: SegLook, width: number): string {
		const ellipsis = this.#theme.symbols.ellipsis;
		const full = look.pieces.map(piece => this.piece(piece)).join("");
		if (visibleWidth(full) <= width) return full;
		if (look.truncate !== "start") return truncate(full, width, ellipsis);
		// Start-cut: the leading icons stay, the text keeps its tail (in its own style).
		let lead = 0;
		while (lead < look.pieces.length && "icon" in look.pieces[lead]!) lead++;
		const prefix = look.pieces
			.slice(0, lead)
			.map(piece => this.piece(piece))
			.join("");
		const rest = look.pieces.slice(lead);
		const first = rest[0];
		if (!first || !("t" in first)) return truncate(full, width, ellipsis);
		const plain = rest.map(piece => ("t" in piece ? piece.t : "")).join("");
		const room = Math.max(0, width - visibleWidth(prefix));
		return prefix + this.link(this.style(first.s, truncateStart(plain, room, ellipsis)), first.href);
	}
}

/** The theme's status separator between segments. */
function separator(theme: Theme): string {
	return theme.style("statusLineSep", theme.symbols.symbol("sep.dot").trim() || "·");
}

function paintSegLook(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { term?: SegLook };
	const look = props.term;
	if (!look) return EMPTY_BLOCK;
	const row = new LookPainter(cx, look.title).row(look, cx.width);
	return row ? { rows: [row] } : EMPTY_BLOCK;
}

function paintBar(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { term?: StatusBarLook };
	const groups = props.term?.groups ?? "both";
	const segs = (props.term?.segs ?? node.children()).filter(child => child.kind === "seg");
	const { row, hits } = statusRow(cx, segs, { separator: separator(cx.theme), groups });
	if (!row) return EMPTY_BLOCK;
	return hits.length > 0 ? { rows: [row], hits } : { rows: [row] };
}

function paintPanel(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { term?: StatusPanelLook };
	const placement = props.term?.placement;
	const blocks: Block[] = [];
	for (const child of node.children()) {
		if (child.kind === "status") {
			if (!placement || placement.bar === "none" || placement.autocomplete) continue;
			const bar = cx.paint(child, cx.width);
			if (bar.rows.length === 0) continue;
			if (placement.gap) blocks.push({ rows: [""] });
			blocks.push(bar);
		} else blocks.push(cx.paint(child, cx.width));
	}
	return stack(blocks, 0);
}

function paintHook(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { text?: string; term?: StatusHookLook };
	const text = props.term?.ansi ?? props.text ?? "";
	return text ? { rows: [truncate(text, cx.width, cx.theme.symbols.ellipsis)] } : EMPTY_BLOCK;
}

defineRolePainter("seg", "omp.status", paintSegLook, { prefix: true });
defineRolePainter("status", "omp.status", paintBar);
defineRolePainter("col", "omp.status.panel", paintPanel);
defineRolePainter("text", "omp.status.hook", paintHook);
