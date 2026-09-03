/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@earendil-works/pi-tui` or `@mariozechner/pi-tui`.
 *
 * The historical root exported `decodeKittyPrintable`; the canonical TUI now
 * exposes the equivalent, broader `decodePrintableKey` helper. Keep the legacy
 * name available without reintroducing it into the canonical package surface.
 */
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

export * from "@oh-my-pi/pi-tui";
export { decodePrintableKey as decodeKittyPrintable } from "@oh-my-pi/pi-tui";

/** Report canonical terminal capabilities through the legacy Pi TUI shape. */
export function getCapabilities(): {
	images: "kitty" | "iterm2" | null;
	trueColor: boolean;
	hyperlinks: boolean;
} {
	const images =
		TERMINAL.imageProtocol === ImageProtocol.Kitty
			? "kitty"
			: TERMINAL.imageProtocol === ImageProtocol.Iterm2
				? "iterm2"
				: null;
	return { images, trueColor: TERMINAL.trueColor, hyperlinks: TERMINAL.hyperlinks };
}

/**
 * Delete one Kitty graphics image by id, matching the legacy Pi TUI helper.
 *
 * Returns the bare control sequence exactly like upstream Pi: legacy callers
 * (e.g. pi-sprite) apply their own tmux passthrough wrapping, so wrapping here
 * would double-wrap under tmux and the outer terminal would drop the command.
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/** Delete every Kitty graphics image using the legacy Pi TUI bare sequence. */
export function deleteAllKittyImages(): string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}
