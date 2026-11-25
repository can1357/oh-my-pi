/**
 * iTerm2 inline images (OSC 1337 `File=`), also understood by WezTerm,
 * Konsole and others.
 */
import type { TerminalCapabilities } from "../contract";
import { wrapPassthrough } from "../mux/tmux";

/**
 * Display base64 image data at the cursor in a `columns`×`rows` cell box
 * (aspect ratio kept inside it). The height is explicit: iTerm2 drops an
 * `auto`-height image written to a background tab.
 */
export function itermImage(
	data: string,
	columns: number,
	rows: number,
	multiplexer: TerminalCapabilities["multiplexer"] = null,
): string {
	return wrapPassthrough(`\x1b]1337;File=inline=1;width=${columns};height=${rows}:${data}\x07`, multiplexer);
}
