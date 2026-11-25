/**
 * The host's Markdown look: what `renderMarkdownFrame` draws with where a
 * caller leaves `colorful` or `mermaid` unset, so every Markdown surface
 * follows the host's settings. Reactive: a painter that renders Markdown
 * repaints when it changes.
 */
import { signal } from "../../reactive";

/** Palette hues for headings, emphasis and inline code; mermaid fences as diagrams. */
export interface MarkdownLook {
	readonly colorful: boolean;
	readonly mermaid: boolean;
}

const look = signal<MarkdownLook>({ colorful: true, mermaid: true });

/** The host's Markdown look (reactive); a new object on every change. */
export function markdownLook(): MarkdownLook {
	return look();
}

/** Set the host's Markdown look (`tui.colorfulMarkdown`, `tui.renderMermaid`). */
export function setMarkdownLook(next: MarkdownLook): void {
	const current = look();
	if (current.colorful !== next.colorful || current.mermaid !== next.mermaid) look.set(next);
}
