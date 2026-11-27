/**
 * Mouse reports: SGR (`CSI < b ; x ; y M|m`), SGR-pixel (DECSET 1016: the same
 * framing in pixels) and the legacy X10 form (`CSI M b x y`).
 */
import type { MouseEvent } from "../contract";

const WHEEL: readonly MouseEvent["button"][] = ["wheel-up", "wheel-down", "wheel-left", "wheel-right"];
const BUTTONS: readonly MouseEvent["button"][] = ["left", "middle", "right", "none"];
const SGR = /^\x1b\[<(\d+);(-?\d+);(-?\d+)([Mm])$/;
/** Kitty sets this bit (with motion) on pointer leave; its position and button bits are not usable. */
const KITTY_LEAVE = 256;

/** How SGR-pixel reports map to cells: the cell size in pixels and the first pixel's number. */
export interface SgrPixelGeometry {
	readonly w: number;
	readonly h: number;
	/**
	 * xterm and WezTerm number pixels from 1; kitty and Ghostty from 0.
	 * https://github.com/wezterm/wezterm/blob/cab25161054c50fd6c705db4ceefef0f1e5a9575/term/src/terminalstate/mouse.rs#L96-L117
	 * https://github.com/kovidgoyal/kitty/blob/3d06c27a76526306ec003c1fbdce38718c844238/kitty/mouse.c#L92-L99
	 * https://github.com/ghostty-org/ghostty/blob/76895d97b74ff6b24c2b1543bcd69ccc18048a4d/src/input/mouse_encode.zig#L164-L172
	 */
	readonly origin: 0 | 1;
}

interface Position {
	readonly row: number;
	readonly col: number;
	readonly rowFraction?: number;
	readonly colFraction?: number;
}

function decodeButton(code: number, at: Position, released: boolean): MouseEvent {
	const mods: MouseEvent["mods"][number][] = [];
	if (code & 4) mods.push("shift");
	if (code & 8) mods.push("alt");
	if (code & 16) mods.push("ctrl");
	const motion = (code & 32) !== 0;
	const low = code & 3;
	if (code & 64) return { ...at, button: WHEEL[low]!, action: "press", mods };
	const button = BUTTONS[low]!;
	if (motion) return { ...at, button, action: button === "none" ? "move" : "drag", mods };
	if (released || button === "none") return { ...at, button: released ? button : "none", action: "release", mods };
	return { ...at, button, action: "press", mods };
}

/** One pixel coordinate as a cell index plus the position inside it; a pointer outside the window clamps to 0. */
function pixelAxis(value: number, origin: number, size: number): [cell: number, fraction: number] {
	const exact = Math.max(0, (value - origin) / size);
	const cell = Math.floor(exact);
	return [cell, exact - cell];
}

/** A report with SGR framing (cell or pixel), whether or not it decodes to an event. */
export function isSgrMouseReport(seq: string): boolean {
	return SGR.test(seq);
}

/**
 * Decode a complete mouse report, or null when `seq` is not one or is a
 * report to drop (kitty's pointer leave). Coordinates become 0-based cells.
 * With `pixels` (SGR-pixel reporting is on) SGR reports are in pixels and the
 * event also carries the position inside the cell.
 */
export function decodeMouse(seq: string, pixels?: SgrPixelGeometry | null): MouseEvent | null {
	const sgr = SGR.exec(seq);
	if (sgr) {
		const [code, x, y] = [Number(sgr[1]), Number(sgr[2]), Number(sgr[3])];
		if (code & KITTY_LEAVE) return null;
		const released = sgr[4] === "m";
		if (pixels && pixels.w > 0 && pixels.h > 0) {
			const [col, colFraction] = pixelAxis(x, pixels.origin, pixels.w);
			const [row, rowFraction] = pixelAxis(y, pixels.origin, pixels.h);
			return decodeButton(code, { row, col, rowFraction, colFraction }, released);
		}
		if (x < 1 || y < 1) return null;
		return decodeButton(code, { row: y - 1, col: x - 1 }, released);
	}
	if (seq.length === 6 && seq.startsWith("\x1b[M")) {
		const code = seq.charCodeAt(3) - 32;
		const x = seq.charCodeAt(4) - 32;
		const y = seq.charCodeAt(5) - 32;
		if (code < 0 || x < 1 || y < 1) return null;
		// X10 reports every release as button 3 ("none").
		return decodeButton(code, { row: y - 1, col: x - 1 }, (code & 3) === 3 && (code & 96) === 0);
	}
	return null;
}
