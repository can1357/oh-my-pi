/** One segment of a {@link HookSelectorSlider} — a label and an optional
 *  detail line (e.g. the resolved model name) shown beneath the track while
 *  the segment is active. Segment colors come from the track's theme palette,
 *  assigned by position. */
export interface HookSelectorSliderSegment {
	label: string;
	/** Secondary line rendered under the track when this segment is selected. */
	detail?: string;
}

/**
 * A horizontal left/right selector rendered above the option list. Unlike the
 * up/down option cursor, the slider is moved with the left/right arrows from
 * any list position, letting the caller capture an orthogonal choice (e.g. the
 * model tier to continue execution with) alongside the selected option.
 */
export interface HookSelectorSlider {
	/** Dim caption rendered before the slider track (e.g. "continue with"). */
	caption?: string;
	segments: HookSelectorSliderSegment[];
	/** Initially highlighted segment index. */
	index: number;
	/** Invoked with the new index whenever the slider moves. */
	onChange?: (index: number) => void;
}
