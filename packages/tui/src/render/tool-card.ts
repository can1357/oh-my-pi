import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import { Text } from "../components/text";
import { compactText, rowsText, styledSpans } from "../native/spans";
import { sameItems } from "../native/memo";
import { colorTone } from "../native/tone";
import { span } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "../native/node";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import { getPaddingX } from "../utils";
import {
	CachedOutputBlock,
	describeOutputBlock,
	markFramedBlockComponent,
	type NativeOutputBlockSection,
	outputBlockContentWidth,
	type OutputBlockOptions,
} from "./output-block";
import { renderStatusLine, type StatusLineOptions } from "./status-line";
import type { State } from "./types";
import { getStateBgColor } from "./utils";

/** Lifecycle distinctions shared by tool call and result cards. */
export type ToolCardPhase = "pending" | "running" | "partial" | "success" | "warning" | "error" | "info";

/** Fixed card topology. Framed cards own their border; plain cards flow inline. */
export type ToolCardVariant = "framed" | "plain";

/** Lazily rendered slot content. Components retain their own width caches. */
export type ToolCardContent = readonly string[] | Component | ((width: number) => readonly string[] | Component);

/** A labeled body section in a tool card. */
export interface ToolCardSection {
	label?: string;
	content: ToolCardContent;
	separator?: boolean;
}

/** Snapshot returned by a ToolCard builder on each render. */
export interface ToolCardSnapshot {
	/** Pre-rendered header. Prefer `status` for ordinary tool lifecycle rows. */
	header?: string;
	/** Structured status header, rendered by the shared status-line primitive. */
	status?: StatusLineOptions;
	headerMeta?: string;
	phase?: ToolCardPhase;
	body?: ToolCardContent;
	sections?: readonly ToolCardSection[];
	footer?: ToolCardContent;
	applyBg?: boolean;
	contentPaddingLeft?: number;
	contentPaddingRight?: number;
	borderColor?: ThemeColor;
}

/** Width information supplied to a ToolCard's lazy snapshot builder. */
export interface ToolCardBuildContext {
	width: number;
	/** Inner width for the default one-column framed padding. */
	contentWidth: number;
	/** Compute an inner width when this snapshot opts into custom frame padding. */
	contentWidthFor(contentPaddingLeft?: number, contentPaddingRight?: number): number;
}

/** Construction options whose topology remains fixed for a card's lifetime. */
export interface ToolCardOptions {
	variant: ToolCardVariant;
	paddingX?: number;
	paddingY?: number;
	ignoreTight?: boolean;
	/** Framed cards only: render flat (opencode layout) instead of bordered. Tool
	 * renderers resolve this from their render context's `flat` flag. */
	flat?: boolean;
	onInvalidate?: () => void;
	onDispose?: () => void;
}

/** Map transcript lifecycle terminology onto the output frame's visual states. */
export function toolCardState(phase: ToolCardPhase | undefined): State | undefined {
	if (phase === "partial") return "pending";
	if (phase === "info") return undefined;
	return phase;
}

function isRenderedLines(value: readonly string[] | Component): value is readonly string[] {
	return Array.isArray(value);
}

/** Header spans for a structured status line; the status icon is the card's status chip. */
function statusSpans(status: StatusLineOptions, theme: Theme): TspSpan[] {
	const flatten = (text: string): string => text.replace(/\r\n?|\n/g, " ");
	const spans: TspSpan[] = [];
	if (status.iconOverride) spans.push(...styledSpans(status.iconOverride), span(" "));
	spans.push(span(flatten(status.title), status.titleColor ?? "accent"));
	if (status.description) spans.push(span(": "), span(flatten(status.description), "muted"));
	if (status.badge) {
		const label = `${theme.format.bracketLeft}${flatten(status.badge.label)}${theme.format.bracketRight}`;
		spans.push(span(" "), span(label, status.badge.color));
	}
	const meta = status.meta?.map(flatten).filter(value => value.trim().length > 0) ?? [];
	if (meta.length > 0) spans.push(span(" "), span(meta.join(theme.sep.dot), "dim"));
	return spans;
}

/** Last description of a card, reused while the snapshot's inputs are unchanged. */
interface NativeCardMemo {
	head: string;
	meta: string | undefined;
	phase: ToolCardPhase | undefined;
	applyBg: boolean | undefined;
	borderColor: ThemeColor | undefined;
	/** Per slot: label plus resolved content (component or rows array) and its described child. */
	slots: readonly {
		label: string | undefined;
		separator: boolean;
		content: readonly string[] | Component;
		child: NativeChild;
	}[];
	node: NativeNode;
}

function resolveContent(content: ToolCardContent, width: number): { lines: readonly string[]; component?: Component } {
	const resolved = typeof content === "function" ? content(width) : content;
	if (isRenderedLines(resolved)) return { lines: resolved };
	return { lines: resolved.render(width), component: resolved };
}

/**
 * Cached tool-card layout with lazy body/section/footer children. The builder
 * may read mutable streaming state at render time; unchanged snapshots retain
 * their rendered array identity through CachedOutputBlock or Text.
 */
export class ToolCard implements Component {
	readonly #theme: Theme;
	readonly #options: ToolCardOptions;
	readonly #build: (context: ToolCardBuildContext) => ToolCardSnapshot;
	readonly #block = new CachedOutputBlock();
	#lastBlockOptions?: OutputBlockOptions;
	#plainText: Text;
	#plainKey = "";
	#renderedChildren: Component[] = [];
	#disposed = false;
	#native: NativeCardMemo | undefined;

	constructor(theme: Theme, options: ToolCardOptions, build: (context: ToolCardBuildContext) => ToolCardSnapshot) {
		this.#theme = theme;
		this.#options = options;
		this.#build = build;
		this.#plainText = new Text("", options.paddingX ?? 0, options.paddingY ?? 0);
		this.#plainText.setIgnoreTight(options.ignoreTight ?? true);
		if (options.variant === "framed") markFramedBlockComponent(this);
	}

	render(width: number): readonly string[] {
		const configuredPadding = this.#options.paddingX ?? 0;
		const plainPadding = this.#options.ignoreTight === false ? getPaddingX(configuredPadding) : configuredPadding;
		const flat = this.#options.flat;
		const defaultContentWidth =
			this.#options.variant === "framed"
				? outputBlockContentWidth(width, undefined, undefined, flat)
				: Math.max(1, width - plainPadding * 2);
		const snapshot = this.#build({
			width,
			contentWidth: defaultContentWidth,
			contentWidthFor: (contentPaddingLeft?: number, contentPaddingRight?: number) =>
				this.#options.variant === "framed"
					? outputBlockContentWidth(width, contentPaddingLeft, contentPaddingRight, flat)
					: defaultContentWidth,
		});
		const contentWidth =
			this.#options.variant === "framed"
				? outputBlockContentWidth(width, snapshot.contentPaddingLeft, snapshot.contentPaddingRight, flat)
				: defaultContentWidth;

		const previousChildren = this.#renderedChildren;
		const nextChildren: Component[] = [];
		const nextChildSet = new Set<Component>();
		const retainChild = (component: Component | undefined): void => {
			if (!component || nextChildSet.has(component)) return;
			nextChildSet.add(component);
			nextChildren.push(component);
		};
		const sections: Array<{ label?: string; lines: readonly string[]; separator?: boolean }> = [];
		if (snapshot.body) {
			const body = resolveContent(snapshot.body, contentWidth);
			sections.push({ lines: body.lines });
			retainChild(body.component);
		}
		for (const section of snapshot.sections ?? []) {
			const resolved = resolveContent(section.content, contentWidth);
			sections.push({ label: section.label, lines: resolved.lines, separator: section.separator });
			retainChild(resolved.component);
		}
		if (snapshot.footer) {
			const footer = resolveContent(snapshot.footer, contentWidth);
			sections.push({ lines: footer.lines, separator: sections.length > 0 });
			retainChild(footer.component);
		}
		for (const previousChild of previousChildren) {
			if (!nextChildSet.has(previousChild)) previousChild.dispose?.();
		}
		this.#renderedChildren = nextChildren;

		const state = toolCardState(snapshot.phase);
		const header = snapshot.header ?? (snapshot.status ? renderStatusLine(snapshot.status, this.#theme) : undefined);
		if (this.#options.variant === "framed") {
			const previousOptions = this.#lastBlockOptions;
			const previousSections = previousOptions?.sections;
			const sectionsStable =
				previousSections?.length === sections.length &&
				sections.every((section, index) => {
					const previous = previousSections[index];
					return (
						previous?.label === section.label &&
						previous.lines === section.lines &&
						previous.separator === section.separator
					);
				});
			const reusableOptions =
				previousOptions?.width === width &&
				previousOptions.header === header &&
				previousOptions.headerMeta === snapshot.headerMeta &&
				previousOptions.state === state &&
				previousOptions.applyBg === snapshot.applyBg &&
				previousOptions.contentPaddingLeft === snapshot.contentPaddingLeft &&
				previousOptions.contentPaddingRight === snapshot.contentPaddingRight &&
				previousOptions.borderColor === snapshot.borderColor &&
				sectionsStable
					? previousOptions
					: undefined;
			const blockOptions: OutputBlockOptions = reusableOptions ?? {
				header,
				headerMeta: snapshot.headerMeta,
				state,
				sections,
				width,
				applyBg: snapshot.applyBg,
				contentPaddingLeft: snapshot.contentPaddingLeft,
				contentPaddingRight: snapshot.contentPaddingRight,
				borderColor: snapshot.borderColor,
				flat,
			};
			this.#lastBlockOptions = blockOptions;
			return this.#block.render(blockOptions, this.#theme);
		}

		const lines: string[] = [];
		if (header) {
			lines.push(snapshot.headerMeta ? `${header} ${snapshot.headerMeta}` : header);
		}
		for (const section of sections) {
			if (section.separator && lines.length > 0) lines.push("");
			if (section.label) lines.push(section.label);
			lines.push(...section.lines);
		}
		const text = lines.join("\n");
		const key = `${width}:${text.length}:${Bun.hash(text).toString(36)}:${state ?? "info"}:${snapshot.applyBg ?? true}`;
		if (key !== this.#plainKey) {
			this.#plainKey = key;
			this.#plainText.setText(text);
			this.#plainText.setCustomBgFn(
				state && snapshot.applyBg !== false ? value => this.#theme.bg(getStateBgColor(state), value) : undefined,
			);
		}
		return this.#plainText.render(width);
	}

	/**
	 * A `card` (flat `inset` for plain cards) with the state's tone and status
	 * chip, head from the header/status line, and body slots: components as
	 * children, pre-rendered rows as unwrapped text, labelled sections as
	 * `section`s. The builder gets the surface width as its only width.
	 */
	describe(cx: DescribeContext): NativeNode {
		const snapshot = this.#build({ width: cx.cols, contentWidth: cx.cols, contentWidthFor: () => cx.cols });
		const previous = this.#native;
		const slotInputs: { label: string | undefined; separator: boolean; content: ToolCardContent }[] = [];
		if (snapshot.body) slotInputs.push({ label: undefined, separator: false, content: snapshot.body });
		for (const section of snapshot.sections ?? []) {
			slotInputs.push({ label: section.label, separator: section.separator === true, content: section.content });
		}
		if (snapshot.footer)
			slotInputs.push({ label: undefined, separator: slotInputs.length > 0, content: snapshot.footer });

		const nextChildren: Component[] = [];
		const slots = slotInputs.map((input, index) => {
			const content = typeof input.content === "function" ? input.content(cx.cols) : input.content;
			const prior = previous?.slots[index];
			let child: NativeChild;
			if (isRenderedLines(content)) {
				child =
					prior !== undefined && isRenderedLines(prior.content) && sameItems(prior.content, content)
						? prior.child
						: rowsText(content);
			} else {
				child = content;
				if (!nextChildren.includes(content)) nextChildren.push(content);
			}
			return { label: input.label, separator: input.separator, content, child };
		});
		for (const child of this.#renderedChildren) {
			if (!nextChildren.includes(child)) child.dispose?.();
		}
		this.#renderedChildren = nextChildren;

		const head = snapshot.header ?? (snapshot.status ? JSON.stringify(snapshot.status) : "");
		if (
			previous !== undefined &&
			previous.head === head &&
			previous.meta === snapshot.headerMeta &&
			previous.phase === snapshot.phase &&
			previous.applyBg === snapshot.applyBg &&
			previous.borderColor === snapshot.borderColor &&
			previous.slots.length === slots.length &&
			slots.every((slot, index) => {
				const prior = previous.slots[index]!;
				return prior.label === slot.label && prior.separator === slot.separator && prior.child === slot.child;
			})
		) {
			return previous.node;
		}

		const headSpans: TspText | undefined = snapshot.header
			? compactText(styledSpans(snapshot.header))
			: snapshot.status
				? statusSpans(snapshot.status, this.#theme)
				: undefined;
		const sections: NativeOutputBlockSection[] = slots.map((slot, index) => ({
			label: slot.label === undefined ? undefined : compactText(styledSpans(slot.label)),
			separator: slot.separator,
			body: [slot.child],
			key: String(index),
		}));
		const state = toolCardState(snapshot.phase);
		const plain = this.#options.variant === "plain";
		const described = describeOutputBlock({
			head: headSpans,
			meta: snapshot.headerMeta ? compactText(styledSpans(snapshot.headerMeta)) : undefined,
			state,
			role: "omp.tool",
			tone:
				snapshot.borderColor !== undefined
					? (colorTone(snapshot.borderColor) ?? "neutral")
					: plain && snapshot.applyBg === false
						? "neutral"
						: undefined,
			sections,
			inset: plain || undefined,
		});
		this.#native = {
			head,
			meta: snapshot.headerMeta,
			phase: snapshot.phase,
			applyBg: snapshot.applyBg,
			borderColor: snapshot.borderColor,
			slots,
			node: described,
		};
		return described;
	}

	get debugChildren(): readonly Component[] {
		return this.#renderedChildren;
	}

	get wantsKeyRelease(): boolean {
		return this.#renderedChildren.some(child => child.wantsKeyRelease === true);
	}

	handleInput(data: string): void {
		for (const child of this.#renderedChildren) child.handleInput?.(data);
	}

	setIgnoreTight(ignore: boolean): void {
		this.#options.ignoreTight = ignore;
		this.#plainText.setIgnoreTight(ignore);
		for (const child of this.#renderedChildren) child.setIgnoreTight?.(ignore);
		this.invalidate();
	}

	invalidate(): void {
		this.#native = undefined;
		this.#block.invalidate();
		this.#lastBlockOptions = undefined;
		this.#plainKey = "";
		this.#plainText.invalidate();
		for (const child of this.#renderedChildren) child.invalidate?.();
		this.#options.onInvalidate?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const child of this.#renderedChildren) child.dispose?.();
		this.#options.onDispose?.();
		this.#renderedChildren = [];
	}
}

/** Construct a lazy framed tool card. */
export function framedToolCard(
	theme: Theme,
	build: (context: ToolCardBuildContext) => ToolCardSnapshot,
	options: Omit<ToolCardOptions, "variant"> = {},
): ToolCard {
	return new ToolCard(theme, { ...options, variant: "framed" }, build);
}

/** Construct a lazy inline tool card, optionally state-tinted. */
export function plainToolCard(
	theme: Theme,
	build: (context: ToolCardBuildContext) => ToolCardSnapshot,
	options: Omit<ToolCardOptions, "variant"> = {},
): ToolCard {
	return new ToolCard(theme, { ...options, variant: "plain" }, build);
}
