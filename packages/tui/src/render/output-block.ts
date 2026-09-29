/**
 * Bordered output container with optional header and sections.
 */
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import { Ellipsis, padding, sliceWithWidth, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import { getSixelLineMask } from "./sixel";
import type { State } from "./types";
import type { RenderCache } from "./utils";
import { getStateBgColor, Hasher, padToWidth } from "./utils";

/** Sections and presentation options for a bordered output block. */
export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{
		label?: string;
		lines: readonly string[];
		separator?: boolean;
		verbatim?: boolean;
		/** Verbatim overflow policy: expanded wraps across marked rows, collapsed clips with `…`. */
		expanded?: boolean;
	}>;
	width: number;
	applyBg?: boolean;
	contentPaddingLeft?: number;
	contentPaddingRight?: number;
	/** Override the state-derived border color. Used for muted "legacy" tool
	 * frames that should not visually compete with framed-output tools. */
	borderColor?: ThemeColor;
}

const FRAMED_BLOCK_COMPONENT = Symbol("framedBlockComponent");

/** A component marked as rendering its own output frame. */
export type FramedBlockComponent = Component & { [FRAMED_BLOCK_COMPONENT]?: true };

/** Mark a component as owning its output frame. */
export function markFramedBlockComponent<T extends Component>(component: T): T & FramedBlockComponent {
	(component as T & FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] = true;
	return component as T & FramedBlockComponent;
}

/** Return whether a component owns its output frame. */
export function isFramedBlockComponent(component: Component): boolean {
	return (component as FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] === true;
}

type BlockRow =
	| { kind: "bar"; leftChar: string; rightChar: string; label?: string; meta?: string }
	| { kind: "bottom"; leftChar: string; rightChar: string }
	| { kind: "content"; inner: string }
	| { kind: "sixel"; raw: string };

/** Gutter glyph prefix marking a soft-wrapped continuation row of a verbatim echo. */
export const VERBATIM_WRAP_MARKER = "↪ ";

/**
 * Display rows for one verbatim payload-echo source line at `width` columns.
 *
 * Every byte of the source line stays recoverable. `expanded` chunks the line
 * across rows whose continuation rows carry {@link VERBATIM_WRAP_MARKER} (a soft
 * wrap can then never read as a payload newline), and collapsed clips to a
 * byte-prefix of the line with a visible `…` marker — the expanded view reveals
 * the rest. Chunks are column slices (`sliceWithWidth`, strict at the boundary)
 * so cuts land on grapheme/ANSI boundaries and concatenating the rows minus
 * their markers re-joins the source line byte-for-byte.
 */
export function renderVerbatimRows(line: string, width: number, theme: Theme, expanded: boolean): string[] {
	// Collapsed: marked-ellipsis truncation — shown bytes stay a byte-prefix of
	// the source and the `…` says the row continues beyond the frame.
	if (!expanded) return [truncateToWidth(line, width)];
	const total = visibleWidth(line);
	// Zero-width source line (blank or escape-only): still one payload row.
	if (total === 0) return [line];
	const marker = theme.fg("dim", VERBATIM_WRAP_MARKER);
	const markerWidth = visibleWidth(VERBATIM_WRAP_MARKER);
	const rows: string[] = [];
	for (let col = 0; col < total;) {
		const first = rows.length === 0;
		const budget = Math.max(1, first ? width : width - markerWidth);
		// Strict: a wide grapheme straddling the boundary drops to the next row
		// instead of being cut. Degenerate frame (budget below one grapheme's
		// width): take it non-strict — a 1-column overflow beats stalling.
		let slice = sliceWithWidth(line, col, budget, true);
		if (slice.width === 0) slice = sliceWithWidth(line, col, budget);
		rows.push(first ? slice.text : `${marker}${slice.text}`);
		col += Math.max(1, slice.width);
	}
	return rows;
}

function normalizeContentPaddingLeft(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	return Math.max(0, Math.floor(value));
}

/**
 * Inner content width that {@link renderOutputBlock} wraps its body to, for a
 * given outer `width`: both vertical borders plus symmetric content padding.
 * An explicit left padding of zero keeps legacy flush blocks flush on both
 * sides unless a right padding is provided separately.
 */
export function outputBlockContentWidth(
	width: number,
	contentPaddingLeft?: number,
	contentPaddingRight?: number,
): number {
	const left = normalizeContentPaddingLeft(contentPaddingLeft);
	const right = normalizeContentPaddingLeft(contentPaddingRight ?? left);
	return Math.max(1, width - 2 - left - right);
}

/** Render a bordered output block with optional header and sections. */
export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	const { header, headerMeta, state, sections = [], width, applyBg = true } = options;
	const h = theme.boxRound.horizontal;
	const v = theme.boxRound.vertical;
	const cap = h.repeat(3);
	const lineWidth = Math.max(0, width);
	// Border colors: running/pending use accent, success uses dim (gray), error/warning keep their colors
	const borderColor: ThemeColor =
		options.borderColor ??
		(state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "dim");
	const border = (text: string) => theme.fg(borderColor, text);
	const bgFn = (() => {
		if (!state || !applyBg) return undefined;
		const bgAnsi = theme.getBgAnsi(getStateBgColor(state));
		// Keep block background stable even if inner content contains SGR resets (e.g. "\x1b[0m"),
		// which would otherwise clear the outer background mid-line.
		return (text: string) => {
			const stabilized = text
				.replace(/\x1b\[(?:0)?m/g, m => `${m}${bgAnsi}`)
				.replace(/\x1b\[49m/g, m => `${m}${bgAnsi}`);
			return `${bgAnsi}${stabilized}\x1b[49m`;
		};
	})();

	const contentPaddingLeft = normalizeContentPaddingLeft(options.contentPaddingLeft);
	const contentPaddingRight = normalizeContentPaddingLeft(options.contentPaddingRight ?? contentPaddingLeft);
	const contentWidth = Math.max(
		0,
		lineWidth - visibleWidth(v) - contentPaddingLeft - contentPaddingRight - visibleWidth(v),
	);
	const contentLeftPadding = contentPaddingLeft > 0 ? padding(contentPaddingLeft) : "";
	const contentRightPadding = contentPaddingRight > 0 ? padding(contentPaddingRight) : "";

	// ── Layout pass: collect row descriptors before emitting the bordered lines. ──
	const rows: BlockRow[] = [];
	rows.push({
		kind: "bar",
		leftChar: theme.boxRound.topLeft,
		rightChar: theme.boxRound.topRight,
		label: header,
		meta: headerMeta,
	});

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
		const section = normalizedSections[sectionIndex]!;
		// A labeled section always draws its titled separator bar. A label-less
		// section can still request a plain divider via `separator`, but only
		// between sections — leading with one would just double the header bar.
		if (section.label) {
			rows.push({
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
				label: section.label,
			});
		} else if (section.separator && sectionIndex > 0) {
			rows.push({
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
			});
		}
		const allLines = section.lines.flatMap(l => l.split("\n"));
		const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const line = allLines[lineIndex]!;
			if (sixelLineMask?.[lineIndex]) {
				rows.push({ kind: "sixel", raw: line });
				continue;
			}
			// Verbatim sections echo raw tool payloads (commands, file content): one
			// source line is one logical row — never re-wrapped or right-trimmed, so a
			// wrap-induced break can't read as a payload newline. Every byte stays
			// recoverable: `expanded` soft-wraps across rows marked with
			// VERBATIM_WRAP_MARKER, collapsed clips to a byte-prefix with a `…` marker.
			const wrappedLines = section.verbatim
				? renderVerbatimRows(line, contentWidth, theme, section.expanded === true)
				: wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				const innerPadding = padding(Math.max(0, contentWidth - visibleWidth(wrappedLine)));
				rows.push({ kind: "content", inner: `${wrappedLine}${innerPadding}` });
			}
		}
	}

	rows.push({ kind: "bottom", leftChar: theme.boxRound.bottomLeft, rightChar: theme.boxRound.bottomRight });

	const H = rows.length;

	const renderBar = (row: { leftChar: string; rightChar: string; label?: string; meta?: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		if (lineWidth <= 0) return border(leftGlyphs) + border(rightGlyph);
		const labelText = [row.label, row.meta].filter(Boolean).join(theme.sep.dot);
		if (!labelText) {
			// No header: draw a clean, continuous top/separator bar (no 1-col gap).
			const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
			return `${border(leftGlyphs)}${border(h.repeat(fillCount))}${border(rightGlyph)}`;
		}
		const rawLabel = ` ${labelText} `;
		const leftWidth = visibleWidth(leftGlyphs);
		const rightWidth = visibleWidth(rightGlyph);
		const maxLabelWidth = Math.max(0, lineWidth - leftWidth - rightWidth);
		const trimmedLabel = truncateToWidth(rawLabel, maxLabelWidth);
		const labelWidth = visibleWidth(trimmedLabel);
		const fillCount = Math.max(0, lineWidth - leftWidth - labelWidth - rightWidth);
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${trimmedLabel}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const renderBottom = (row: { leftChar: string; rightChar: string }): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const renderContent = (inner: string): string =>
		`${border(v)}${contentLeftPadding}${inner}${contentRightPadding}${border(v)}`;

	const clipFrame = lineWidth < Math.max(visibleWidth(cap) + 2, contentPaddingLeft + contentPaddingRight + 2);
	const lines: string[] = [];
	for (let r = 0; r < H; r++) {
		const row = rows[r]!;
		if (row.kind === "sixel") {
			lines.push(row.raw);
			continue;
		}
		const line =
			row.kind === "bar" ? renderBar(row) : row.kind === "bottom" ? renderBottom(row) : renderContent(row.inner);
		lines.push(padToWidth(clipFrame ? truncateToWidth(line, lineWidth, Ellipsis.Omit) : line, lineWidth, bgFn));
	}

	return lines;
}

/**
 * Cached wrapper around `renderOutputBlock`.
 *
 * Since output blocks are re-rendered on every frame (via `render(width)` closures),
 * but their content rarely changes, this cache avoids redundant `visibleWidth()` and
 * `padding()` computations on ~99% of render calls.
 */
export class CachedOutputBlock {
	#cache?: RenderCache;
	#lastOptions?: OutputBlockOptions;

	/** Render with caching. Returns the cached (shared, caller-immutable) lines if options haven't changed. */
	render(options: OutputBlockOptions, theme: Theme): readonly string[] {
		// Reference fast path: rebuild paths often hand back the same options
		// object when nothing changed; skip the full content hash entirely.
		if (this.#lastOptions === options && this.#cache) return this.#cache.lines;
		const key = this.#buildKey(options);
		if (this.#cache?.key === key) {
			this.#lastOptions = options;
			return this.#cache.lines;
		}
		const lines = renderOutputBlock(options, theme);
		this.#cache = { key, lines };
		this.#lastOptions = options;
		return lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
		this.#lastOptions = undefined;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const h = new Hasher();
		h.u32(options.width);
		h.u32(normalizeContentPaddingLeft(options.contentPaddingLeft));
		h.u32(
			normalizeContentPaddingLeft(
				options.contentPaddingRight ?? normalizeContentPaddingLeft(options.contentPaddingLeft),
			),
		);
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.optional(options.borderColor);
		h.bool(options.applyBg ?? true);
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				h.bool(s.separator ?? false);
				h.bool(s.verbatim ?? false);
				h.bool(s.expanded ?? false);
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}
