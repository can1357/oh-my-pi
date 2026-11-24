/**
 * Terminal → host reports: probe answers and notifications. None of these is
 * ever user input; the decoder routes them to their owners and swallows the
 * ones nobody owns.
 */
import { parseColorSpec, type Rgb } from "../caps/color";

export type TerminalReply =
	/** DA1 `CSI ? attrs c`: the sentinel every probe batch ends with. */
	| { readonly type: "da1"; readonly attrs: readonly number[] }
	/** DA2 `CSI > params c`. */
	| { readonly type: "da2"; readonly params: readonly number[] }
	/** Kitty keyboard flags `CSI ? flags u`. */
	| { readonly type: "kittyKeyboard"; readonly flags: number }
	/** DECRPM `CSI ? mode ; status $ y` (status 0 unknown, 1 set, 2 reset, 3 permanently set, 4 permanently reset). */
	| { readonly type: "decrpm"; readonly mode: number; readonly status: number; readonly dec: boolean }
	/** Mode 2031 color-scheme notification `CSI ? 997 ; 1|2 n`. */
	| { readonly type: "colorScheme"; readonly dark: boolean }
	/** DSR `CSI n n`. */
	| { readonly type: "dsr"; readonly status: number }
	/** Cursor position report `CSI row ; col R` (1-based; only owned while a CPR is pending). */
	| { readonly type: "cpr"; readonly row: number; readonly col: number }
	/** XTSMGRAPHICS `CSI ? item ; status ; values S`. */
	| {
			readonly type: "graphicsAttribute";
			readonly item: number;
			readonly status: number;
			readonly values: readonly number[];
	  }
	/** XTWINOPS size reports: `CSI 6;h;w t` (cell), `CSI 4;h;w t` (text area pixels), `CSI 8;rows;cols t`. */
	| {
			readonly type: "windowSize";
			readonly unit: "cell" | "pixels" | "chars";
			readonly height: number;
			readonly width: number;
	  }
	/** DEC 2048 in-band resize `CSI 48 ; rows ; cols ; height px ; width px t`. */
	| {
			readonly type: "inBandResize";
			readonly rows: number;
			readonly cols: number;
			readonly heightPx: number;
			readonly widthPx: number;
	  }
	/** OSC 10/11/12 (`index`) or OSC 4 palette (`index` = 4, `slot`) color reports. */
	| { readonly type: "color"; readonly index: number; readonly slot?: number; readonly rgb: Rgb | null }
	/** XTVERSION `DCS > | text ST`. */
	| { readonly type: "version"; readonly version: string }
	/** Kitty desktop-notification report `OSC 99 ; meta ; payload ST` (`meta`/`payload` are `k=v` lists joined by `:`). */
	| {
			readonly type: "notification";
			readonly meta: ReadonlyMap<string, string>;
			readonly payload: ReadonlyMap<string, string>;
	  }
	/** Kitty graphics response `APC G key=value… ; message ST`. */
	| { readonly type: "kittyGraphics"; readonly id: number | null; readonly ok: boolean; readonly message: string }
	/** Any other report (DECRQSS, XTGETTCAP, unknown OSC/DCS/APC): swallowed. */
	| { readonly type: "other"; readonly raw: string };

function numbers(text: string): number[] {
	return text === "" ? [] : text.split(";").map(part => Number(part.split(":")[0] || "0"));
}

function stringBody(seq: string): string {
	if (seq.endsWith("\x1b\\")) return seq.slice(2, -2);
	if (seq.endsWith("\x07")) return seq.slice(2, -1);
	return seq.slice(2);
}

/**
 * Classify a complete CSI sequence as a report. `cprPending` makes
 * `CSI r ; c R` a cursor report instead of the legacy Ctrl/Shift+F3 encoding.
 */
function csiReply(seq: string, cprPending: boolean): TerminalReply | null {
	const body = seq.slice(2);
	const final = body.at(-1);
	const marker = body[0];
	if (marker === "?") {
		const inner = body.slice(1);
		if (final === "c") return { type: "da1", attrs: numbers(inner.slice(0, -1)) };
		if (final === "u" && /^\d+u$/.test(inner)) return { type: "kittyKeyboard", flags: Number(inner.slice(0, -1)) };
		const rpm = /^(\d+);(\d+)\$y$/.exec(inner);
		if (rpm) return { type: "decrpm", mode: Number(rpm[1]), status: Number(rpm[2]), dec: true };
		if (final === "n") {
			const [code, value] = numbers(inner.slice(0, -1));
			if (code === 997) return { type: "colorScheme", dark: value === 1 };
			return { type: "other", raw: seq };
		}
		if (final === "S") {
			const [item = 0, status = 0, ...values] = numbers(inner.slice(0, -1));
			return { type: "graphicsAttribute", item, status, values };
		}
		// DECXCPR and anything else marked private is a report.
		return { type: "other", raw: seq };
	}
	if (marker === ">" || marker === "=") {
		if (marker === ">" && final === "c") return { type: "da2", params: numbers(body.slice(1, -1)) };
		return { type: "other", raw: seq };
	}
	const params = body.slice(0, -1);
	const rpm = /^(\d+);(\d+)\$y$/.exec(body);
	if (rpm) return { type: "decrpm", mode: Number(rpm[1]), status: Number(rpm[2]), dec: false };
	if (/[^\d;:]/.test(params)) return null;
	if (final === "t") {
		const [kind, a = 0, b = 0, c = 0, d = 0] = numbers(params);
		if (kind === 48) return { type: "inBandResize", rows: a, cols: b, heightPx: c, widthPx: d };
		if (kind === 6) return { type: "windowSize", unit: "cell", height: a, width: b };
		if (kind === 4) return { type: "windowSize", unit: "pixels", height: a, width: b };
		if (kind === 8) return { type: "windowSize", unit: "chars", height: a, width: b };
		return { type: "other", raw: seq };
	}
	if (final === "n" && /^\d+$/.test(params)) return { type: "dsr", status: Number(params) };
	if (final === "R" && cprPending && /^\d+;\d+$/.test(params)) {
		const [row = 1, col = 1] = numbers(params);
		return { type: "cpr", row, col };
	}
	return null;
}

/** OSC 99 `k=v:k=v` section (single-letter keys; anything else is ignored). */
function osc99Fields(section: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const part of section.split(":")) {
		if (part.indexOf("=") !== 1) continue;
		fields.set(part[0]!, part.slice(2));
	}
	return fields;
}

function oscReply(seq: string): TerminalReply {
	const body = stringBody(seq);
	const notification = /^99;([^;]*);(.*)$/s.exec(body);
	if (notification) {
		return { type: "notification", meta: osc99Fields(notification[1]!), payload: osc99Fields(notification[2]!) };
	}
	const color = /^(1[0-2]);(.*)$/s.exec(body);
	if (color) return { type: "color", index: Number(color[1]), rgb: parseColorSpec(color[2]!) };
	const palette = /^4;(\d+);(.*)$/s.exec(body);
	if (palette) return { type: "color", index: 4, slot: Number(palette[1]), rgb: parseColorSpec(palette[2]!) };
	return { type: "other", raw: seq };
}

function apcReply(seq: string): TerminalReply {
	const body = stringBody(seq);
	if (body.startsWith("G")) {
		const semi = body.indexOf(";");
		const keys = semi < 0 ? body.slice(1) : body.slice(1, semi);
		const message = semi < 0 ? "" : body.slice(semi + 1);
		const id = /(?:^|,)i=(\d+)/.exec(keys)?.[1];
		return { type: "kittyGraphics", id: id === undefined ? null : Number(id), ok: message === "OK", message };
	}
	return { type: "other", raw: seq };
}

/**
 * Classify a complete sequence as a terminal report, or null when it is
 * input (keys, mouse, focus, paste markers, TSP messages).
 */
export function parseReply(seq: string, cprPending = false): TerminalReply | null {
	if (seq.length < 3 || seq[0] !== "\x1b") return null;
	switch (seq[1]) {
		case "[":
			return csiReply(seq, cprPending);
		case "]":
			return oscReply(seq);
		case "P": {
			const body = stringBody(seq);
			if (body.startsWith(">|")) return { type: "version", version: body.slice(2) };
			return { type: "other", raw: seq };
		}
		case "_":
			return apcReply(seq);
		case "^":
		case "X":
			return { type: "other", raw: seq };
		default:
			return null;
	}
}
