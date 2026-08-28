import { logger } from "@oh-my-pi/pi-utils";
import xterm, { type Terminal as XtermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { readTerminalRows } from "../tools/terminal-output";
import { DAEMON_PTY_COLUMNS, DAEMON_PTY_ROWS } from "./protocol";

const VIRTUAL_SCROLLBACK_ROWS = 4_096;

/** Controls which virtual terminal rows a launch log exposes. */
export interface TerminalOutputOptions {
	head: boolean;
	maxRows: number;
}

function writeTerminal(terminal: XtermTerminal, output: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	terminal.write(output, resolve);
	return promise;
}

/** Replays daemon bytes with the same xterm screen renderer used by PTY mode. */
export async function renderTerminalOutput(
	output: string,
	options: TerminalOutputOptions,
): Promise<string[] | undefined> {
	if (!output) return [];
	const maxRows = Math.max(1, Math.floor(options.maxRows));
	const terminal = new xterm.Terminal({
		cols: DAEMON_PTY_COLUMNS,
		rows: DAEMON_PTY_ROWS,
		scrollback: Math.max(VIRTUAL_SCROLLBACK_ROWS, maxRows),
		allowProposedApi: true,
	});
	try {
		await writeTerminal(terminal, output);
		const rows = readTerminalRows(terminal, 0, terminal.buffer.active.length);
		while (rows.at(-1) === "") rows.pop();
		return options.head ? rows.slice(0, maxRows) : rows.slice(-maxRows);
	} catch (error) {
		logger.debug("Failed to render launch terminal output", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	} finally {
		terminal.dispose();
	}
}
