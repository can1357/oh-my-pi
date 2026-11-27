/** Process-wide inline transcript image dimension limits. */
import { signal } from "@oh-my-pi/pi-tui/reactive";

/** Default maximum width of a transcript image, in terminal columns. */
export const DEFAULT_INLINE_IMAGE_COLUMNS = 100;

/** Default maximum height of a transcript image, in terminal rows. */
export const DEFAULT_INLINE_IMAGE_ROWS = 20;

export const inlineImageLimits = signal({
	columns: DEFAULT_INLINE_IMAGE_COLUMNS,
	rows: DEFAULT_INLINE_IMAGE_ROWS,
});

/** Set the process-wide transcript image limits. */
export const setInlineImageLimits = inlineImageLimits.set;
