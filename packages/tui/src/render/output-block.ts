/**
 * Bordered output container with optional header and sections.
 */
import type { TspCardStatus, TspPreview, TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { node, span } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import { Ellipsis, padding, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import { getSixelLineMask } from "./sixel";
import type { State } from "./types";
import type { RenderCache } from "./utils";
import { getStateBgColor, Hasher, padToWidth } from "./utils";

/** Sections and presentation options for a bordered output block. */
export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean }>;
	width: number;
	applyBg?: boolean;
	contentPaddingLeft?: number;
	contentPaddingRight?: number;
	/** Render flat (opencode layout): no frame, no borders, no state background.
	 * Tool renderers resolve this from their render context's `flat` flag. */
	flat?: boolean;
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

function normalizeContentPaddingLeft(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	return Math.max(0, Math.floor(value));
}

/**
 * Inner content width that {@link renderOutputBlock} wraps its body to, for a
 * given outer `width`. Framed (default): both vertical borders plus symmetric
 * content padding. Flat (opencode layout): the two-column indent only. An
 * explicit left padding of zero keeps legacy flush blocks flush on both sides
 * unless a right padding is provided separately.
 *
 * `flat` is deliberately the LAST parameter: the padding parameters keep their
 * pre-opencode positions so precompiled extension callers stay compatible.
 */
export function outputBlockContentWidth(
	width: number,
	contentPaddingLeft?: number,
	contentPaddingRight?: number,
	flat?: boolean,
): number {
	if (flat) return Math.max(1, width - 2);
	const left = normalizeContentPaddingLeft(contentPaddingLeft);
	const right = normalizeContentPaddingLeft(contentPaddingRight ?? left);
	return Math.max(1, width - 2 - left - right);
}

/** Render a bordered output block with optional header and sections. */
export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	// Flat (opencode layout): no frame at all. The header renders as a plain
	// status row (ToolExecutionComponent's collapsed view slices exactly this
	// row) and section content renders flat, indented two columns, with no
	// background tint. Every framed tool (bash, eval, read, fetch, task, …)
	// routes through here, so this single branch is what makes the whole
	// transcript flat.
	if (options.flat) {
		const flatWidth = Math.max(0, options.width);
		const lines: string[] = [];
		const labelText = [options.header, options.headerMeta]
			.filter((value): value is string => Boolean(value))
			.map(replaceTabs)
			.join(theme.sep.dot);
		if (labelText) lines.push(truncateToWidth(labelText, flatWidth));
		const indent = padding(2);
		const flatContentWidth = Math.max(1, flatWidth - 2);
		const flatSections = options.sections ?? [];
		for (const section of flatSections) {
			if (section.label)
				lines.push(`${indent}${theme.fg("dim", truncateToWidth(replaceTabs(section.label), flatContentWidth))}`);
			const sectionLines = section.lines.flatMap(l => l.split("\n"));
			const sixelMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(sectionLines) : undefined;
			for (let i = 0; i < sectionLines.length; i++) {
				const line = sectionLines[i]!;
				if (sixelMask?.[i]) {
					lines.push(line);
					continue;
				}
				for (const wrapped of wrapTextWithAnsi(line.trimEnd(), flatContentWidth)) {
					lines.push(`${indent}${wrapped}`);
				}
			}
		}
		return lines;
	}
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
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
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

/** Card tone for an output state. */
export function outputStateTone(state: State | undefined): TspTone {
	switch (state) {
		case "pending":
		case "running":
			return "pending";
		case "success":
			return "success";
		case "error":
			return "error";
		case "warning":
			return "warning";
		default:
			return "neutral";
	}
}

/** Card status chip for an output state. */
export function outputStateStatus(state: State | undefined): TspCardStatus | undefined {
	switch (state) {
		case "pending":
			return "pending";
		case "running":
			return "running";
		case "success":
		case "warning":
			return "done";
		case "error":
			return "error";
		default:
			return undefined;
	}
}

/** One body section of a native output block. */
export interface NativeOutputBlockSection {
	/** Titled sub-section (the ANSI path's labelled separator bar). */
	label?: TspText;
	body: readonly NativeChild[];
	/** Divide from the previous section with a rule. */
	separator?: boolean;
	/** Stable identity when sections come and go. */
	key?: string;
}

/** Semantic inputs for {@link describeOutputBlock}. */
export interface NativeOutputBlockOptions {
	head?: TspText;
	meta?: TspText;
	state?: State;
	/** Card role (`omp.tool.bash`, `omp.eval.cell`, …). Defaults to `omp.output`. */
	role?: string;
	/** Override the state-derived tone (the ANSI path's `borderColor`). */
	tone?: TspTone;
	sections?: readonly NativeOutputBlockSection[];
	collapsible?: boolean;
	collapsed?: boolean;
	preview?: TspPreview;
	/** Flat card without a ring (inline/plain variants). */
	inset?: boolean;
	key?: string;
}

function asSpans(content: TspText): readonly TspSpan[] {
	return typeof content === "string" ? [span(content)] : content;
}

/**
 * The native form of {@link renderOutputBlock}: a `card` whose tone and
 * status chip come from the state, head from the header plus meta, and body
 * from the sections (labelled ones as `section`s, separators as `rule`s).
 * Borders, background fills and wrapping are the terminal's.
 */
export function describeOutputBlock(options: NativeOutputBlockOptions): NativeNode {
	let head: TspText | undefined = options.head;
	if (options.meta !== undefined && options.meta !== "") {
		head = head === undefined ? options.meta : [...asSpans(head), span(" · ", "dim"), ...asSpans(options.meta)];
	}
	const children: NativeChild[] = [];
	const sections = options.sections ?? [];
	for (let index = 0; index < sections.length; index++) {
		const section = sections[index]!;
		const key = section.key ?? String(index);
		if (section.label !== undefined) {
			children.push(node("section", { head: section.label }, section.body, key));
			continue;
		}
		if (section.separator && index > 0) children.push(node("rule", undefined, undefined, `${key}:rule`));
		for (const child of section.body) children.push(child);
	}
	return node(
		"card",
		{
			role: options.role ?? "omp.output",
			tone: options.tone ?? outputStateTone(options.state),
			status: outputStateStatus(options.state),
			head,
			collapsible: options.collapsible,
			collapsed: options.collapsed,
			preview: options.preview,
			inset: options.inset,
		},
		children,
		options.key,
	);
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
		// A live layout toggle changes the rendered shape for identical options.
		h.bool(options.flat ?? false);
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
				for (const line of s.lines) {
					h.str(line);
				}
			}
		}
		return h.digest();
	}
}
