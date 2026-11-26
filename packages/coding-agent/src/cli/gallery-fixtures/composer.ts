/**
 * `omp gallery --surface composer`: every registered composer shape, drawn by
 * the shape picker's preview with the gallery session's status line where
 * the shape puts it.
 */
import { signal } from "@oh-my-pi/pi-tui";
import type { StatusLineSettings } from "../../modes/view-model/status-line/types";
import { ComposerShapePreview } from "../../ui/overlays/composer-shape-preview";
import { printRows } from "../../ui/print-rows";
import type { StatusFacts } from "../../ui/status/facts";
import { createStatusLine, shapePlacement } from "../../ui/status/status-line";
import "../../ui/styles/composer";
import "../../ui/styles/status";
import { composerShape, composerShapeIds } from "../../ui/styles/composer/shapes";
import "../../ui/styles/overlays/composer-shape-preview";
import { GALLERY_NOW, galleryStatusFacts, galleryStatusSettings } from "./status-facts";
import type { GalleryPreviewEntry } from "./types";

/** Production composer registry in selector order. */
export function getComposerGalleryInventory(): readonly string[] {
	return composerShapeIds();
}

/** The status line the composer previews show. */
const COMPOSER_STATUS = galleryStatusSettings(["pi", "model", "mode"], ["session_name", "context_pct"], {
	contextLine: "annotated",
});

/** Shape `id`'s preview, its status line built from the gallery session. */
export function renderComposerPreview(
	id: string,
	width: number,
	settings: StatusLineSettings = COMPOSER_STATUS,
	facts: StatusFacts = galleryStatusFacts(),
): string[] {
	const status = createStatusLine({
		settings: () => settings,
		facts: () => facts,
		placement: () => shapePlacement(composerShape(id), false),
	});
	return printRows(() => ComposerShapePreview({ shape: signal(id), status: status.chrome }), width, {
		now: GALLERY_NOW,
	});
}

/** Every registered composer style, rendered through the production preview. */
export function getComposerGalleryEntries(): readonly GalleryPreviewEntry[] {
	return composerShapeIds().map(id => {
		const shape = composerShape(id);
		return {
			id,
			heading: `composer · ${id} — ${shape.label ?? id}`,
			variants: [{ label: "canonical preview", render: width => renderComposerPreview(id, width) }],
		};
	});
}
