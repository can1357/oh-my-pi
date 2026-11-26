import type * as XtermModule from "@oh-my-pi/pi-utils/vterm";

let xtermTerminalCtor: typeof XtermModule.Terminal | undefined;

/** Lazily load the headless terminal shared by PTY display paths. */
export async function loadXtermTerminal(): Promise<typeof XtermModule.Terminal> {
	if (!xtermTerminalCtor) {
		const mod = (await import("@oh-my-pi/pi-utils/vterm")) as typeof XtermModule & { default?: typeof XtermModule };
		xtermTerminalCtor = (mod.default ?? mod).Terminal;
	}
	return xtermTerminalCtor;
}
