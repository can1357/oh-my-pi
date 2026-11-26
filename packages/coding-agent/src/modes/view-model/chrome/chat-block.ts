/**
 * Capabilities a mounted {@link ChatBlock} may use against its host transcript.
 * Kept minimal so blocks never reach into the full TUI/InteractiveMode surface.
 */
export interface ChatBlockHost {
	/** Schedule a repaint of the transcript. */
	requestRender(): void;
}
