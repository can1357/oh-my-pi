/** @jsxImportSource @oh-my-pi/pi-tui */
/** Views the extension UI controller mounts that need markup of their own. */
import type { JSXNode, UiNode } from "@oh-my-pi/pi-tui";
import "../../ui/styles/overlays/bare-sheet";
import { SESSION_PAGE } from "./selector-views";

/**
 * An extension's `custom` view as an overlay: docked to the bottom, or centered on the whole
 * screen; the terminal adds no frame around what the view draws.
 * Tern gets a view that is an `overlay` of its own as the sheet it declares, a fullscreen
 * view as a page, and any other in a modal sheet at the bottom edge.
 */
export function extensionOverlay(view: UiNode, fullscreen: boolean, native: boolean): JSXNode {
	if (!native) {
		// The view draws its own look: no frame, the screen's width, at the bottom edge.
		return fullscreen ? (
			<overlay key="extension" size="full" role="omp.sheet.bare">
				{view}
			</overlay>
		) : (
			<overlay key="extension" anchor="bottom" role="omp.sheet.bare" term={{ width: "full" }}>
				{view}
			</overlay>
		);
	}
	if (view.kind === "overlay") return view;
	if (fullscreen) {
		return (
			<overlay key="extension" size="full" role="omp.app.screen" page={SESSION_PAGE}>
				{view}
			</overlay>
		);
	}
	return (
		<overlay key="extension" anchor="bottom" size="lg" modal>
			{view}
		</overlay>
	);
}
