import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** The released build's spelling of a fullscreen overlay. */
const RELEASED_FULLSCREEN = { overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } };

/**
 * `/parity-overlay`: a rows view shown with `ctx.ui.custom(..., { overlay: true })`; Escape or `q`
 * closes it. `/parity-overlay full` asks for the whole screen, in both spellings of the option.
 */
export default function ternOverlay(pi: ExtensionAPI): void {
	pi.registerCommand("parity-overlay", {
		description: "Open the parity overlay",
		handler: async (args, ctx) => {
			const fullscreen = args.trim() === "full";
			await ctx.ui.custom<void>(
				(_ui, _theme, _keybindings, done) => ({
					render: (width: number) => ["Parity overlay", "Escape closes it"].map(line => line.slice(0, width)),
					handleInput: (data: string) => {
						if (data === "\x1b" || data === "\x1b[27u" || data === "q") done();
					},
					invalidate: () => {},
				}),
				fullscreen ? { overlay: true, fullscreen: true, ...RELEASED_FULLSCREEN } : { overlay: true },
			);
		},
	});
}
