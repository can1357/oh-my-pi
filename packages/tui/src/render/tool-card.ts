import { Text } from "../components/text";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import { getPaddingX } from "../utils";
import {
	CachedOutputBlock,
	markFramedBlockComponent,
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
		const defaultContentWidth =
			this.#options.variant === "framed" ? outputBlockContentWidth(width) : Math.max(1, width - plainPadding * 2);
		const snapshot = this.#build({
			width,
			contentWidth: defaultContentWidth,
			contentWidthFor: (contentPaddingLeft?: number, contentPaddingRight?: number) =>
				this.#options.variant === "framed"
					? outputBlockContentWidth(width, contentPaddingLeft, contentPaddingRight)
					: defaultContentWidth,
		});
		const contentWidth =
			this.#options.variant === "framed"
				? outputBlockContentWidth(width, snapshot.contentPaddingLeft, snapshot.contentPaddingRight)
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
