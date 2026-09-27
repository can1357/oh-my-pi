import type { MouseRoutable, SgrMouseEvent } from "../mouse";
import type { Component } from "../tui";

/** Semantic role of a wizard step's primary interactive content. */
export type WizardStepKind = "input" | "choice" | "confirm" | "async" | "custom";

/** A component slot rendered by {@link WizardStep}. */
export interface WizardStepSlot {
	readonly component: Component;
	/** Omit this slot when retaining it would squeeze content below `minContentLines`. */
	readonly optional?: boolean;
}

/** Composition and height policy for a single wizard step. */
export interface WizardStepOptions {
	readonly kind: WizardStepKind;
	readonly content: Component;
	readonly heading?: Component;
	readonly intro?: Component;
	readonly preview?: WizardStepSlot;
	readonly status?: Component;
	readonly footer?: Component;
	/** Blank rows inserted between non-empty slots. Defaults to one. */
	readonly gap?: number;
	/** Minimum useful content height used when deciding whether to show an optional preview. */
	readonly minContentLines?: number;
	/** Resize content-owned viewports before their next render. */
	readonly fitContent?: (maxLines: number | undefined) => void;
}

interface RenderedSlot {
	readonly component: Component;
	readonly lines: readonly string[];
}

function isMouseRoutable(component: Component): component is Component & MouseRoutable {
	return "routeMouse" in component && typeof component.routeMouse === "function";
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

/**
 * Reusable presentation for input, choice, confirmation, and asynchronous
 * wizard steps. Controllers retain state transitions; this component owns the
 * ordered slots, bounded content budget, optional-preview collapse, and mouse
 * coordinate translation into the interactive content child.
 */
export class WizardStep implements Component, MouseRoutable {
	readonly debugKind = "WizardStep";

	#kind: WizardStepKind;
	#content: Component;
	#heading: Component | undefined;
	#intro: Component | undefined;
	#preview: WizardStepSlot | undefined;
	#status: Component | undefined;
	#footer: Component | undefined;
	#gap: number;
	#minContentLines: number;
	#fitContent: ((maxLines: number | undefined) => void) | undefined;
	#maxHeight: number | undefined;
	#contentRowStart = -1;
	#contentRowCount = 0;
	#cachedLines: readonly string[] | undefined;

	constructor(options: WizardStepOptions) {
		this.#kind = options.kind;
		this.#content = options.content;
		this.#heading = options.heading;
		this.#intro = options.intro;
		this.#preview = options.preview;
		this.#status = options.status;
		this.#footer = options.footer;
		this.#gap = Math.max(0, Math.floor(options.gap ?? 1));
		this.#minContentLines = Math.max(0, Math.floor(options.minContentLines ?? 1));
		this.#fitContent = options.fitContent;
	}

	get debugChildren(): readonly Component[] {
		return [this.#heading, this.#intro, this.#preview?.component, this.#content, this.#status, this.#footer].filter(
			(component): component is Component => component !== undefined,
		);
	}

	debugState(): Record<string, unknown> {
		return {
			kind: this.#kind,
			maxHeight: this.#maxHeight ?? null,
			contentRowStart: this.#contentRowStart,
			contentRowCount: this.#contentRowCount,
			previewOptional: this.#preview?.optional === true,
		};
	}

	/** Update the semantic role exposed through debug state. */
	setKind(kind: WizardStepKind): void {
		this.#kind = kind;
	}

	/** Replace or remove the heading slot without rebuilding the step. */
	setHeading(heading: Component | undefined): void {
		this.#heading = heading;
	}

	/** Replace or remove the introductory slot without rebuilding the step. */
	setIntro(intro: Component | undefined): void {
		this.#intro = intro;
	}

	/** Replace or remove the preview slot without rebuilding the step. */
	setPreview(preview: WizardStepSlot | undefined): void {
		this.#preview = preview;
	}

	/** Replace the interactive content while retaining layout and height state. */
	setContent(content: Component): void {
		this.#content = content;
	}

	/** Replace or remove the status slot without rebuilding the step. */
	setStatus(status: Component | undefined): void {
		this.#status = status;
	}

	/** Replace or remove the footer slot without rebuilding the step. */
	setFooter(footer: Component | undefined): void {
		this.#footer = footer;
	}

	/** Bound the complete step, including heading, preview, status, and footer. */
	setMaxHeight(maxHeight: number | undefined): void {
		const next = maxHeight === undefined ? undefined : Math.max(0, Math.floor(maxHeight));
		if (next === this.#maxHeight) return;
		this.#maxHeight = next;
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		for (const child of this.debugChildren) child.invalidate?.();
	}

	dispose(): void {
		for (const child of this.debugChildren) child.dispose?.();
	}

	handleInput(data: string): void {
		this.#content.handleInput?.(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const content = this.#content;
		if (!isMouseRoutable(content)) return;
		if (event.wheel === null) {
			if (this.#contentRowStart < 0) return;
			if (line < this.#contentRowStart || line >= this.#contentRowStart + this.#contentRowCount) return;
		}
		content.routeMouse(event, line - this.#contentRowStart, col);
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, width);
		const gap = this.#gap;
		const maxHeight = this.#maxHeight;

		const heading = this.#renderSlot(this.#heading, safeWidth);
		const intro = this.#renderSlot(this.#intro, safeWidth);
		let preview = this.#renderSlot(this.#preview?.component, safeWidth);
		const status = this.#renderSlot(this.#status, safeWidth);
		const footer = this.#renderSlot(this.#footer, safeWidth);

		const fixedWithoutPreview = [heading, intro, status, footer].filter(
			(slot): slot is RenderedSlot => slot !== undefined && slot.lines.length > 0,
		);
		if (preview && preview.lines.length > 0 && this.#preview?.optional && maxHeight !== undefined) {
			const requiredSlots = fixedWithoutPreview.length + 1;
			const requiredRows =
				fixedWithoutPreview.reduce((total, slot) => total + slot.lines.length, 0) +
				Math.max(0, requiredSlots - 1) * gap +
				this.#minContentLines;
			const rowsWithPreview = requiredRows + preview.lines.length + gap;
			if (rowsWithPreview > maxHeight) preview = undefined;
		}

		const surrounding = [heading, intro, preview, status, footer].filter(
			(slot): slot is RenderedSlot => slot !== undefined && slot.lines.length > 0,
		);
		const slotCountWithContent = surrounding.length + 1;
		const surroundingRows = surrounding.reduce((total, slot) => total + slot.lines.length, 0);
		const gapRows = Math.max(0, slotCountWithContent - 1) * gap;
		const contentBudget = maxHeight === undefined ? undefined : Math.max(0, maxHeight - surroundingRows - gapRows);
		this.#fitContent?.(contentBudget);
		const contentLines = this.#content.render(safeWidth);
		const visibleContent = contentBudget === undefined ? contentLines : contentLines.slice(0, contentBudget);

		const ordered = [
			heading,
			intro,
			preview,
			{ component: this.#content, lines: visibleContent },
			status,
			footer,
		].filter((slot): slot is RenderedSlot => slot !== undefined && slot.lines.length > 0);
		const lines: string[] = [];
		this.#contentRowStart = -1;
		this.#contentRowCount = visibleContent.length;
		for (const slot of ordered) {
			if (lines.length > 0 && gap > 0) {
				for (let i = 0; i < gap; i++) lines.push("");
			}
			if (slot.component === this.#content) this.#contentRowStart = lines.length;
			lines.push(...slot.lines);
		}
		const bounded = maxHeight === undefined || lines.length <= maxHeight ? lines : lines.slice(0, maxHeight);
		if (this.#cachedLines && sameLines(this.#cachedLines, bounded)) return this.#cachedLines;
		this.#cachedLines = bounded;
		return bounded;
	}

	#renderSlot(component: Component | undefined, width: number): RenderedSlot | undefined {
		if (!component) return undefined;
		return { component, lines: component.render(width) };
	}
}
