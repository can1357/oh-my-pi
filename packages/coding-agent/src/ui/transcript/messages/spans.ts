/**
 * ANSI-styled status text as TSP spans: attributes become span tokens
 * (`strong`, `em`, `underline`, `strike`, `inverse`, `faint`); colors are a
 * terminal look and are dropped.
 */
import { sgrParams, tokens } from "@oh-my-pi/pi-tui/text/ansi";
import type { TspSpan } from "@oh-my-pi/pi-wire";

const ATTRIBUTE_TOKENS: Readonly<Record<number, string>> = {
	1: "strong",
	2: "faint",
	3: "em",
	4: "underline",
	7: "inverse",
	9: "strike",
};

/** Codes that end attributes: each lists the attribute codes it turns off. */
const ATTRIBUTE_OFF: Readonly<Record<number, readonly number[]>> = {
	22: [1, 2],
	23: [3],
	24: [4],
	27: [7],
	29: [9],
};

/** The spans of `styled` (consecutive runs with the same attributes merge). */
export function ansiSpans(styled: string): TspSpan[] {
	const spans: TspSpan[] = [];
	const active = new Set<number>();
	const push = (text: string): void => {
		if (text === "") return;
		const style = [...active]
			.sort((a, b) => a - b)
			.map(code => ATTRIBUTE_TOKENS[code])
			.join(" ");
		const last = spans.at(-1);
		if (last && (last.s ?? "") === style) {
			spans[spans.length - 1] = style ? { t: last.t + text, s: style } : { t: last.t + text };
			return;
		}
		spans.push(style ? { t: text, s: style } : { t: text });
	};
	for (const token of tokens(styled)) {
		if (!token.escape) {
			push(token.text);
			continue;
		}
		const params = sgrParams(token.text);
		if (params === undefined) continue;
		const parts = params.split(";");
		for (let i = 0; i < parts.length; i++) {
			const raw = parts[i]!;
			const code = raw === "" ? 0 : Number(raw);
			// Extended colors carry their own parameters (`38;5;n`, `38;2;r;g;b`).
			if (code === 38 || code === 48 || code === 58) i += parts[i + 1] === "5" ? 2 : parts[i + 1] === "2" ? 4 : 0;
			else if (code === 0) active.clear();
			else if (ATTRIBUTE_TOKENS[code] !== undefined) active.add(code);
			else for (const off of ATTRIBUTE_OFF[code] ?? []) active.delete(off);
		}
	}
	return spans;
}
