import type { Component } from "../index";
let composerShape = "box";

/** Set the process-wide editor gap layout. */
export function setEditorGapComposerShape(shape: string): void {
	composerShape = shape;
}

const GAP: readonly string[] = [""];
const FLUSH: readonly string[] = [];

/**
 * One-line top margin between the working/status HUD row and the editor.
 * The band composer's status band is designed to sit flush under the working
 * row, so the gap collapses there — but only while that row actually rendered
 * content (the loader and idle title bring their own leading blank). An empty
 * status row keeps the gap so the band never sits flush against the
 * transcript. Shape and row state are read at render time, so runtime changes
 * apply immediately.
 */
export class EditorTopGap implements Component {
	/** @param statusRowOccupied Whether the status/working row directly above rendered lines this frame. */
	constructor(readonly statusRowOccupied: () => boolean) {}

	render(_width: number): readonly string[] {
		return composerShape === "band" && this.statusRowOccupied() ? FLUSH : GAP;
	}
}
