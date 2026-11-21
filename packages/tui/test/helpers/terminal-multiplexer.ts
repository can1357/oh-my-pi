import { afterEach, beforeEach } from "bun:test";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";

/**
 * Neutralize every terminal-multiplexer signal for the calling test file.
 *
 * Multiplexer session markers and a `tmux`/`screen` `TERM` route rendering down
 * the path that cannot rebuild scrollback, and Warp's `TERM_PROGRAM` or
 * `PI_TUI_RESIZE_IN_PLACE` select the in-place resize path. Tests that assert the
 * destructive full-paint behavior otherwise fail for anyone running the suite
 * inside a multiplexer. Restores whatever was set afterwards.
 */
export function withoutTerminalMultiplexer(): void {
	const keys = [...TERMINAL_MULTIPLEXER_ENV_KEYS, "TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"];
	const previous = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of keys) {
			previous.set(key, Bun.env[key]);
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		previous.clear();
	});
}
