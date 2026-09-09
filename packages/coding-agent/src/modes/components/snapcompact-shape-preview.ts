/**
 * Live preview for the `snapcompact.shape` setting: renders a sample session
 * transcript through the real snapcompact rasterizer as a miniature page and
 * shows it zoomed, so cell size, ink hues, highlight bands, and dim tool-result
 * spans are legible at terminal scale.
 *
 * The mini-frame (a {@link SRC_FRAME_PX}px page) is upscaled with
 * nearest-neighbor so the glyph pixels stay crisp when the terminal scales the
 * placement box. Graphics display requires the Kitty unicode-placeholder path —
 * `renderImage` returning `lines` is the gate — because the bordered settings
 * frame re-fits every row, which direct cursor-positioned placements (iTerm2,
 * Sixel, Kitty `a=p`) do not survive. Everything else falls back to the stats
 * line plus a dim notice.
 */
import { type Component, type ImageBudget, renderImage, TERMINAL } from "@oh-my-pi/pi-tui";
import {
	DIM_OFF,
	DIM_ON,
	geometry,
	isShapeVariantName,
	normalize,
	renderMany,
	resolveShape,
	SHAPE_VARIANT_NAMES,
	SHAPE_VARIANTS,
	type Shape,
	type ShapeTarget,
	type ShapeVariantName,
} from "@oh-my-pi/snapcompact";
import { theme } from "../theme/theme";
import sampleDoc from "./snapcompact-shape-preview-doc.md" with { type: "text" };

/** Mini-frame edge in px — a small page from the real rasterizer ≈ a zoomed crop. */
const SRC_FRAME_PX = 128;
/** Nearest-neighbor upscale factor; keeps glyph pixels crisp on HiDPI cell boxes. */
const ZOOM_SCALE = 4;
/** Display box in terminal cells (square-ish at the typical 1:2 cell aspect). */
const MAX_IMAGE_COLS = 28;
const MAX_IMAGE_ROWS = 14;

/** Sample transcript with `<out>…</out>` bodies wrapped in dim-ink toggles. */
const PREVIEW_TEXT = sampleDoc
	.trim()
	.replace(/<out>\n([\s\S]*?)\n<\/out>/g, (_match, body: string) => `<out>\n${DIM_ON}${body}${DIM_OFF}\n</out>`);

type PreviewEntry =
	| { state: "rendering" }
	| { state: "failed" }
	| { state: "ready"; data: string; edgePx: number; imageId: number; transmitted: boolean };

export interface SnapcompactShapePreviewOptions {
	/** Active model (api + id); resolves what `auto` maps to for this reader. */
	model?: ShapeTarget;
	/** Shared TUI image budget: stable graphics ids, transmit-once, exit cleanup. */
	imageBudget?: ImageBudget;
	/** Schedules a re-render once an async sample render completes. */
	requestRender?: () => void;
}

export class SnapcompactShapePreview implements Component {
	#model: ShapeTarget | undefined;
	#budget: ImageBudget | undefined;
	#requestRender: () => void;
	#variant: ShapeVariantName | "auto" = "auto";
	#entries = new Map<ShapeVariantName, PreviewEntry>();

	constructor(currentValue: string, options: SnapcompactShapePreviewOptions = {}) {
		this.#model = options.model;
		this.#budget = options.imageBudget;
		this.#requestRender = options.requestRender ?? (() => {});
		this.setValue(currentValue);
	}

	/** Track the highlighted option; the next render reflects it. */
	setValue(value: string): void {
		this.#variant = isShapeVariantName(value) ? value : "auto";
	}

	render(width: number): readonly string[] {
		const shape = resolveShape(this.#model, this.#variant);
		const name = resolvedVariantName(shape);
		const geo = geometry(shape);
		const label = this.#variant === "auto" ? `auto → ${name}` : name;
		const chars = geo.capacity >= 1000 ? `${(geo.capacity / 1000).toFixed(1)}k` : String(geo.capacity);
		const tokens =
			shape.frameTokenEstimate >= 1000
				? `${(shape.frameTokenEstimate / 1000).toFixed(1)}k`
				: String(shape.frameTokenEstimate);
		const stats = `full frame ${geo.cols}×${geo.rows} cells ≈ ${chars} chars ≈ ${tokens} tokens`;
		const lines: string[] = [theme.fg("muted", `  Sample (zoomed) · ${label} · ${stats}`), ""];

		if (!this.#budget || !TERMINAL.imageProtocol) {
			lines.push(theme.fg("dim", "  (graphic sample needs a Kitty-graphics terminal)"));
			return lines;
		}

		const entry = this.#ensureEntry(name, shape);
		if (entry.state === "rendering") {
			lines.push(theme.fg("dim", "  rendering sample…"));
			return lines;
		}
		if (entry.state === "failed") {
			lines.push(theme.fg("dim", "  (sample render failed)"));
			return lines;
		}

		const result = renderImage(
			entry.data,
			{ widthPx: entry.edgePx, heightPx: entry.edgePx },
			{
				maxWidthCells: Math.max(8, Math.min(MAX_IMAGE_COLS, width - 4)),
				maxHeightCells: MAX_IMAGE_ROWS,
				imageId: entry.imageId,
				includeTransmit: !entry.transmitted,
			},
		);
		// Only the unicode-placeholder path returns text-cell `lines`; cursor-moving
		// placements would corrupt the bordered settings frame, so skip them.
		if (!result?.lines) {
			lines.push(theme.fg("dim", "  (graphic sample needs Kitty unicode-placeholder graphics)"));
			return lines;
		}
		if (result.transmit) {
			this.#budget.enqueueTransmit(entry.imageId, result.transmit);
			entry.transmitted = true;
		}
		for (const line of result.lines) {
			lines.push(`  ${line}`);
		}
		return lines;
	}

	#ensureEntry(name: ShapeVariantName, shape: Shape): PreviewEntry {
		let entry = this.#entries.get(name);
		if (!entry) {
			entry = { state: "rendering" };
			this.#entries.set(name, entry);
			void this.#buildEntry(name, shape);
		}
		return entry;
	}

	async #buildEntry(name: ShapeVariantName, shape: Shape): Promise<void> {
		try {
			// Fill the mini-page so every variant shows a fully inked window.
			const capacity = geometry(shape, SRC_FRAME_PX).capacity;
			let text = PREVIEW_TEXT;
			while (normalize(text).length < capacity) {
				text += ` ${PREVIEW_TEXT}`;
			}
			const frame = (await renderMany(text, { shape, frameSize: SRC_FRAME_PX, maxFrames: 1 }))[0];
			if (!frame) throw new Error("empty sample frame");
			const edgePx = SRC_FRAME_PX * ZOOM_SCALE;
			const zoomed = await new Bun.Image(Buffer.from(frame.data, "base64"))
				.resize(edgePx, edgePx, { filter: "nearest" })
				.png()
				.bytes();
			this.#entries.set(name, {
				state: "ready",
				data: zoomed.toBase64(),
				edgePx,
				// Keyed id: reopening settings reuses the id, so data already in the
				// terminal store is never re-transmitted (enqueueTransmit no-ops).
				imageId: this.#budget?.acquireId(`snapshape:${name}:${edgePx}`) ?? 0,
				transmitted: false,
			});
		} catch {
			this.#entries.set(name, { state: "failed" });
		}
		this.#requestRender();
	}
}

/** Research name of the concrete geometry `resolveShape` picked (for `auto`). */
function resolvedVariantName(shape: Shape): ShapeVariantName {
	for (const name of SHAPE_VARIANT_NAMES) {
		const candidate = SHAPE_VARIANTS[name];
		if (
			candidate.font === shape.font &&
			candidate.cellWidth === shape.cellWidth &&
			candidate.cellHeight === shape.cellHeight &&
			candidate.variant === shape.variant &&
			candidate.lineRepeat === shape.lineRepeat &&
			candidate.frameSize === shape.frameSize
		) {
			return name;
		}
	}
	// resolveShape only hands out table geometries; the legacy shape is the
	// conservative label if that invariant ever changes.
	return "5x8-sent";
}
