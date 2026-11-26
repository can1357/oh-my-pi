/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Sheets: a screen Tern draws inside a glass sheet of its own (a titled,
 * sized, anchored `overlay` in the surface's `layer`), and terminal rows draw
 * as the screen itself, with the look its painter gives it.
 */
import { type Accessor, type JSX, type JSXNode, nativeRendering } from "@oh-my-pi/pi-tui";
import type { OverlayHandle, OverlayOptions } from "../shell/overlays";
import type { Shell } from "../shell/shell";

/** A sheet's `overlay` attributes: its role, head, size and anchor, and handlers kept on the layer. */
export type SheetAttributes = Omit<JSX.IntrinsicElements["overlay"], "children" | "page">;

/** `screen` in its sheet (centered, medium and modal unless `sheet` says otherwise) where Tern draws; as it is in terminal rows. */
export function sheetView(native: boolean, sheet: SheetAttributes, screen: JSXNode): JSXNode {
	if (!native) return screen;
	return (
		<overlay anchor="center" size="md" modal {...sheet}>
			{screen}
		</overlay>
	);
}

/**
 * Mount `screen` as a sheet: Tern gets it inside the `sheet` overlay, terminal
 * rows get `screen` as before. Keyboard focus goes to the screen (or to what
 * `options.focus` picks under it), never to the sheet around it.
 */
export function showSheet(
	shell: Pick<Shell, "native" | "overlays">,
	sheet: SheetAttributes,
	screen: () => JSXNode,
	options?: OverlayOptions,
): OverlayHandle {
	if (!shell.native()) return shell.overlays.show(screen, options);
	const focus = options?.focus ?? true;
	return shell.overlays.show(() => sheetView(true, sheet, screen()), {
		...options,
		focus:
			focus === false
				? false
				: root => {
						const inner = root.children()[0] ?? root;
						return focus === true ? inner : focus(inner);
					},
	});
}

/**
 * A root role only terminal rows carry: the painter keyed to it draws the
 * screen there, while Tern gets the node bare inside its sheet.
 */
export function rowsRole(role: string): Accessor<string | undefined> {
	return () => (nativeRendering() ? undefined : role);
}
