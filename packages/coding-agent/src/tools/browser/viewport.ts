import { type } from "@oh-my-pi/omptype";

/** Viewport dimensions accepted by runtime emulation. */
export interface EmulationViewport {
	/** Viewport width in CSS pixels. */
	width: number;
	/** Viewport height in CSS pixels. */
	height: number;
	/** Device scale factor. */
	scale?: number;
	/** Mobile metrics (`meta viewport`, overlay scrollbars), as a phone's browser has. */
	isMobile?: boolean;
	/** Touch events and `(pointer: coarse)`. */
	hasTouch?: boolean;
}

/** Viewport keys a browser `open` and `tab.emulate()` take; anything else (Puppeteer's names included) is refused. */
const viewportInputSchema = type({
	width: "number",
	height: "number",
	"scale?": "number",
	"deviceScaleFactor?": "number",
	"isMobile?": "boolean",
	"hasTouch?": "boolean",
	"+": "reject",
});

/**
 * The viewport a browser `open` and `tab.emulate()` take: `{width, height, scale?, isMobile?, hasTouch?}`, with
 * Puppeteer's `deviceScaleFactor` read as `scale`. Other keys are refused.
 */
export const viewportSchema = viewportInputSchema.pipe(({ deviceScaleFactor, scale, ...rest }): EmulationViewport => {
	const viewport: EmulationViewport = rest;
	const resolved = scale ?? deviceScaleFactor;
	if (resolved !== undefined) viewport.scale = resolved;
	return viewport;
});
