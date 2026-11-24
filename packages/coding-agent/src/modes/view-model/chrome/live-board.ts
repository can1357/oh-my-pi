import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { ensureTheme } from "../../../ui/theme/service";
import { replaceTabs, truncateToWidth } from "../../../utils/text-width";

/** Output contract for the live board (satisfied by `process.stdout`). */
export interface LiveBoardOutput {
	isTTY?: boolean;
	columns?: number;
	rows?: number;
	write(text: string): boolean;
}

/**
 * Transient multi-line status board for standalone CLI commands.
 *
 * Repaints a caller-rendered block of lines in place at ~12.5fps while
 * permanent output logged through {@link LiveBoard.log} scrolls above it.
 * Non-TTY outputs disable rendering entirely and `log` degrades to plain
 * writes, so callers keep one code path for both modes.
 */
export interface LiveBoard {
	readonly interactive: boolean;
	/** Print a permanent line above the board; plain write when non-interactive. */
	log(text: string): void;
	/** Repaint immediately after a state change instead of waiting for the next tick. */
	repaint(): void;
	/** Clear the board, stop the timer, and restore the cursor. */
	close(): void;
}

const RENDER_INTERVAL_MS = 80;

/**
 * Create a live board whose content comes from `render(spinner, width)` on
 * every tick. An empty render result paints nothing and releases the cursor,
 * so an idle board never interferes with other terminal UI (e.g. pickers).
 */
export function createLiveBoard(
	render: (spinner: string, width: number) => string[],
	output: LiveBoardOutput = process.stdout,
): LiveBoard {
	const interactive = output.isTTY === true;
	let frame = 0;
	let lineCount = 0;
	let cursorHidden = false;
	let closed = false;
	let timer: NodeJS.Timeout | undefined;

	const dimensions = (): { width: number; maxRows: number } => {
		const columns = output.columns ?? 0;
		const rows = output.rows ?? 0;
		return {
			width: Number.isFinite(columns) && columns > 0 ? Math.trunc(columns) : 80,
			maxRows: Math.max(4, (Number.isFinite(rows) && rows > 0 ? Math.trunc(rows) : 24) - 2),
		};
	};

	const paint = (lines: string[]): void => {
		// Erase each row and cap it to the terminal width so the cursor-up count
		// always matches the rows written, even without ONLCR (raw mode), where
		// wrapped rows would otherwise staircase into scrollback.
		if (lines.length === 0 && lineCount === 0) return;
		const { width } = dimensions();
		let out = lineCount > 0 ? `\x1b[${lineCount}A\r` : "\r";
		if (lines.length > 0) {
			out += `${lines.map(line => `\x1b[2K${truncateToWidth(replaceTabs(line), width)}`).join("\r\n")}\r\n`;
		}
		out += "\x1b[0J";
		if (lines.length > 0 && !cursorHidden) {
			out += "\x1b[?25l";
			cursorHidden = true;
		} else if (lines.length === 0 && cursorHidden) {
			out += "\x1b[?25h";
			cursorHidden = false;
		}
		output.write(out);
		lineCount = lines.length;
	};

	const repaint = (): void => {
		if (!interactive || closed) return;
		const { width, maxRows } = dimensions();
		ensureTheme();
		const frames = currentTheme().symbols.activityFrames;
		let lines = render(frames[frame % frames.length] ?? "*", width);
		if (lines.length > maxRows) {
			lines = [...lines.slice(0, maxRows - 1), `… +${lines.length - (maxRows - 1)} more`];
		}
		paint(lines);
	};

	if (interactive) {
		timer = setInterval(() => {
			frame += 1;
			repaint();
		}, RENDER_INTERVAL_MS);
		timer.unref?.();
	}

	return {
		interactive,
		log(text) {
			if (closed || !interactive) {
				output.write(`${text}\n`);
				return;
			}
			paint([]);
			output.write(`${text}\n`);
			repaint();
		},
		repaint,
		close() {
			if (closed) return;
			closed = true;
			if (!interactive) return;
			clearInterval(timer);
			paint([]);
		},
	};
}
