/**
 * Static output: paint a node tree once to terminal rows, for CLI commands
 * that print a view and exit (`omp q`, `omp gallery`) instead of running a
 * live surface.
 */
import { createRoot, type JSXNode, resolveChildren } from "@oh-my-pi/pi-tui";
import { hyperlinksDefault } from "@oh-my-pi/pi-tui/driver/caps/env";
import { detectTerminalId } from "@oh-my-pi/pi-tui/driver/caps/identity";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { ensureTheme } from "./theme/service";

/** Options of {@link printRows}. */
export interface PrintRowsOptions {
	/** Clock the painters read (elapsed times, ages); default now. */
	readonly now?: number;
	/** Emit OSC 8 links (default: whether stdout's terminal renders them). */
	readonly hyperlinks?: boolean;
	/** Paint spinners at the frame of `now` (a live board repainting on a timer) instead of still. */
	readonly motion?: boolean;
}

/** The rows of the nodes `view` builds at `width`, painted still unless `motion`. */
export function printRows(view: () => JSXNode, width: number, options: PrintRowsOptions = {}): string[] {
	ensureTheme();
	const env = staticEnvironment(currentTheme(), {
		now: options.now ?? Date.now(),
		reduceMotion: options.motion !== true,
		hyperlinks:
			options.hyperlinks ?? (process.stdout.isTTY === true && hyperlinksDefault(Bun.env, detectTerminalId(Bun.env))),
	});
	return createRoot(dispose => {
		try {
			return resolveChildren(view)().flatMap(node => renderBlock(node, width, { env }).rows);
		} finally {
			dispose();
		}
	});
}
