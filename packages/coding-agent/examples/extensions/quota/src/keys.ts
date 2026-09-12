// Portable key event matching for interactive TUI components.
// Zero external dependencies so it runs identically under `bun test` and inside OMP.

export type ActionKey =
	| "up"
	| "down"
	| "enter"
	| "escape"
	| "close"
	| "toggle_attention"
	| "toggle_healthy"
	| "refresh"
	| "page_up"
	| "page_down"
	| "home"
	| "end"
	| "unknown";

export function matchActionKey(data: string): ActionKey {
	if (data === "\x03" || data === "q" || data === "Q") {
		return "close";
	}
	if (data === "\x1b" || data === "\x1b\x1b") {
		return "escape";
	}
	if (data === "\x0d" || data === "\x0a" || data === "\x1bOM") {
		return "enter";
	}
	if (data === "\x1b[A" || data === "\x1bOA" || data === "k") {
		return "up";
	}
	if (data === "\x1b[B" || data === "\x1bOB" || data === "j") {
		return "down";
	}
	if (data === "a" || data === "A") {
		return "toggle_attention";
	}
	if (data === "h" || data === "H") {
		return "toggle_healthy";
	}
	if (data === "r" || data === "R") {
		return "refresh";
	}
	if (data === "\x1b[5~") {
		return "page_up";
	}
	if (data === "\x1b[6~") {
		return "page_down";
	}
	if (data === "\x1b[H" || data === "\x1b[1~") {
		return "home";
	}
	if (data === "\x1b[F" || data === "\x1b[4~") {
		return "end";
	}
	return "unknown";
}
