import { afterEach, beforeEach } from "bun:test";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";

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
