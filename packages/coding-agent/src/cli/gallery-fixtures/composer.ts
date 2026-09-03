import { renderComposerShapePreview } from "../../modes/components/composer-shape-preview";
import { getComposerShapeOptions } from "../../modes/components/composer-shape-registry";
import { StatusLineComponent } from "../../modes/components/status-line";
import { createGallerySession } from "./preview-session";
import type { GalleryPreviewEntry } from "./types";

/** Production composer registry in selector order. */
export function getComposerGalleryInventory(): readonly string[] {
	return getComposerShapeOptions().map(option => option.value);
}

function renderComposer(shape: string, width: number): readonly string[] {
	const status = new StatusLineComponent(createGallerySession());
	status.updateSettings({
		preset: "custom",
		leftSegments: ["pi", "model", "mode"],
		rightSegments: ["session_name", "context_pct"],
		separator: "powerline-thin",
		sessionAccent: false,
		contextLine: "annotated",
	});
	status.setPlanModeStatus({ enabled: true, paused: false });
	try {
		return renderComposerShapePreview(shape, width, status);
	} finally {
		status.dispose();
	}
}

/** Every registered composer style, rendered through the production preview. */
export function getComposerGalleryEntries(): readonly GalleryPreviewEntry[] {
	return getComposerShapeOptions().map(option => ({
		id: option.value,
		heading: `composer · ${option.value} — ${option.label}`,
		variants: [
			{
				label: "canonical preview",
				render: width => renderComposer(option.value, width),
			},
		],
	}));
}
