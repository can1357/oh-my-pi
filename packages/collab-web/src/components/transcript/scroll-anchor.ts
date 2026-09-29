/** A visible content segment, independent of grouped-turn containers and React node identity. */
export interface TranscriptScrollAnchor {
	keys: readonly string[];
	offset: number;
}

/** Groups expose one key per tool so a changed three-call grouping still resolves the same activity. */
function anchorKeys(element: HTMLElement): string[] {
	return JSON.parse(element.dataset.scrollAnchors!) as string[];
}

/** Capture the first segment intersecting the viewport, not its potentially very tall parent turn. */
export function captureTranscriptAnchor(root: HTMLElement): TranscriptScrollAnchor | null {
	const top = root.getBoundingClientRect().top;
	for (const element of root.querySelectorAll<HTMLElement>("[data-scroll-anchors]")) {
		const rect = element.getBoundingClientRect();
		if (rect.height === 0 || rect.bottom <= top) continue;
		return { keys: anchorKeys(element), offset: rect.top - top };
	}
	return null;
}

/** Re-find by content identity: prepending can replace a grouped turn or reuse its nodes for older entries. */
export function restoreTranscriptAnchor(root: HTMLElement, anchor: TranscriptScrollAnchor): void {
	for (const element of root.querySelectorAll<HTMLElement>("[data-scroll-anchors]")) {
		if (!anchorKeys(element).some(key => anchor.keys.includes(key))) continue;
		root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
		return;
	}
}
