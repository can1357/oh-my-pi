/**
 * Shared row helpers of the transcript message looks: backgrounds that
 * survive nested resets, padded text blocks and hex foregrounds.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { padTo, replaceTabs, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { terminalPaddingX } from "../terminal-padding";

const BG_RESET = /\x1b\[(?:0|49)m/g;

/**
 * A node's props as the look reads them. Message components build these
 * nodes, so the shape is the one their component writes (props and `term`).
 */
export function propsOf<P extends object>(node: UiNode): Partial<P> {
	// Unchecked: the look's component wrote these props.
	const props = node.props() as unknown as Partial<P>;
	return props;
}

/** A node's terminal-only look facts (`term`). */
export function termOf<T extends object>(node: UiNode): Partial<T> {
	const term = propsOf<{ term: Partial<T> }>(node).term;
	return term ?? {};
}

/** The opening SGR of background `key`. */
export function bgOpen(theme: Theme, key: string): string {
	return theme.bg(key, "").slice(0, -"\x1b[49m".length);
}

/** `row` padded to `width` on background `key`, the fill resuming after every nested reset. */
export function fillRow(theme: Theme, key: string, row: string, width: number): string {
	const open = bgOpen(theme, key);
	const padded = visibleWidth(row) < width ? padTo(row, width) : row;
	return `${open}${padded.replace(BG_RESET, `$&${open}`)}\x1b[49m`;
}

const kResolved = Symbol("omp.messages.resolved-themes");

interface ResolvedHolder {
	[kResolved]?: Map<string, Theme>;
}

/**
 * `theme` with color `key` drawn through its contrast fallback when the theme
 * leaves it at the terminal default: prose on a filled background (the user
 * bubble) keeps a readable color.
 */
export function withResolvedColor(theme: Theme, key: string): Theme {
	if (theme.has(key)) return theme;
	const holder: Theme & ResolvedHolder = theme;
	const byKey = (holder[kResolved] ??= new Map());
	const cached = byKey.get(key);
	if (cached) return cached;
	const created: Theme = {
		name: theme.name,
		dark: theme.dark,
		depth: theme.depth,
		symbols: theme.symbols,
		style(tokens, text) {
			const list = tokens?.split(" ") ?? [];
			if (!list.includes(key)) return theme.style(tokens, text);
			return theme.fgResolved(key, theme.style(list.filter(token => token !== key).join(" "), text));
		},
		fg: (color, text) => (color === key ? theme.fgResolved(color, text) : theme.fg(color, text)),
		fgResolved: (color, text) => theme.fgResolved(color, text),
		bg: (color, text) => theme.bg(color, text),
		palette: (slot, text) => theme.palette(slot, text),
		has: color => color === key || theme.has(color),
		fgSgr: color => (color === key ? theme.fgResolved(color, "").slice(0, -"\x1b[39m".length) : theme.fgSgr(color)),
		hex: color => theme.hex(color),
	};
	byKey.set(key, created);
	return created;
}

/** Foreground `#rrggbb`, ending with a foreground reset. */
export function hexFg(hex: string, text: string): string {
	const value = Number.parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m${text}\x1b[39m`;
}

/**
 * Styled text wrapped with the terminal's standard horizontal padding,
 * every row padded to the full width.
 */
export function paddedText(text: string, width: number): string[] {
	if (text === "") return [];
	const paddingX = terminalPaddingX();
	const inner = Math.max(1, width - paddingX * 2);
	const pad = " ".repeat(paddingX);
	return wrap(replaceTabs(text), inner).map(line => padTo(`${pad}${line}`, width));
}
