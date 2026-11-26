/**
 * The host's Markdown look: what `renderMarkdownFrame` draws with where a
 * caller leaves `colorful`, `mermaid` or `linkUrls` unset, so every Markdown
 * surface follows the host's settings. Reactive: a painter that renders
 * Markdown repaints when it changes.
 */
import { signal } from "../../reactive";

/** Palette hues for headings, emphasis and inline code; mermaid fences as diagrams. */
export interface MarkdownLook {
	readonly colorful: boolean;
	readonly mermaid: boolean;
	readonly linkUrls: boolean;
}

const look = signal<MarkdownLook>({ colorful: true, mermaid: true, linkUrls: true });

/** The host's Markdown look (reactive); a new object on every change. */
export function markdownLook(): MarkdownLook {
	return look();
}

/**
 * Set the host's Markdown look (`tui.colorfulMarkdown`, `tui.renderMermaid`,
 * `tui.showLinkUrl`); fields `next` leaves unset keep their value.
 */
export function setMarkdownLook(next: Partial<MarkdownLook>): void {
	const current = look();
	const merged: MarkdownLook = {
		colorful: next.colorful ?? current.colorful,
		mermaid: next.mermaid ?? current.mermaid,
		linkUrls: next.linkUrls ?? current.linkUrls,
	};
	if (
		merged.colorful !== current.colorful ||
		merged.mermaid !== current.mermaid ||
		merged.linkUrls !== current.linkUrls
	)
		look.set(merged);
}
