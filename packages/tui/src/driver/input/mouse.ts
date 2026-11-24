/** Mouse reports: SGR (`CSI < b ; x ; y M|m`) and the legacy X10 form (`CSI M b x y`). */
import type { MouseEvent } from "../contract";

const WHEEL: readonly MouseEvent["button"][] = ["wheel-up", "wheel-down", "wheel-left", "wheel-right"];
const BUTTONS: readonly MouseEvent["button"][] = ["left", "middle", "right", "none"];

function decodeButton(code: number, row: number, col: number, released: boolean): MouseEvent {
	const mods: MouseEvent["mods"][number][] = [];
	if (code & 4) mods.push("shift");
	if (code & 8) mods.push("alt");
	if (code & 16) mods.push("ctrl");
	const motion = (code & 32) !== 0;
	const low = code & 3;
	if (code & 64) return { row, col, button: WHEEL[low]!, action: "press", mods };
	const button = BUTTONS[low]!;
	if (motion) return { row, col, button, action: button === "none" ? "move" : "drag", mods };
	if (released || button === "none") return { row, col, button: released ? button : "none", action: "release", mods };
	return { row, col, button, action: "press", mods };
}

/** Decode a complete mouse report, or null when `seq` is not one. Coordinates become 0-based. */
export function decodeMouse(seq: string): MouseEvent | null {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
	if (sgr) {
		const [code, x, y] = [Number(sgr[1]), Number(sgr[2]), Number(sgr[3])];
		if (x < 1 || y < 1) return null;
		return decodeButton(code, y - 1, x - 1, sgr[4] === "m");
	}
	if (seq.length === 6 && seq.startsWith("\x1b[M")) {
		const code = seq.charCodeAt(3) - 32;
		const x = seq.charCodeAt(4) - 32;
		const y = seq.charCodeAt(5) - 32;
		if (code < 0 || x < 1 || y < 1) return null;
		// X10 reports every release as button 3 ("none").
		return decodeButton(code, y - 1, x - 1, (code & 3) === 3 && (code & 96) === 0);
	}
	return null;
}
