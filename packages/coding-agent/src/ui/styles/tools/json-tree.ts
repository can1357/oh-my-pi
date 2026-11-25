/**
 * JSON values as terminal tree rows (a tool's args, a JSON result).
 *
 * The root's entries are bullets (`└ • key: value`, then `  • key: value`);
 * a container that fits {@link INLINE_LEN} cells stays on its entry's row as
 * `{a: 1, b: [2, 3]}` in muted punctuation, a larger one opens a subtree of
 * `├─`/`└─` rows under its `key [n]`/`key {n}` row. Keys are muted (array
 * indices dim), strings `syntaxString`, numbers `syntaxNumber`, booleans and
 * null `syntaxKeyword`.
 */
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";

/** Widest inline container, in cells. */
const INLINE_LEN = 60;

/** Bounds of a tree. */
export interface JsonTreeLimits {
	readonly maxDepth: number;
	readonly maxLines: number;
	/** Longest scalar, in cells. */
	readonly maxScalar: number;
}

/** Limits of an expanded tree. */
export const EXPANDED_TREE: JsonTreeLimits = { maxDepth: 6, maxLines: 200, maxScalar: 2000 };
/** Limits of a collapsed tree. */
export const COLLAPSED_TREE: JsonTreeLimits = { maxDepth: 2, maxLines: 6, maxScalar: 60 };

const BARE_KEY = /^[A-Za-z_$][\w$]*$/;

/** Theme key of a scalar's color. */
function scalarColor(value: unknown): string {
	if (typeof value === "string") return "syntaxString";
	if (typeof value === "number" || typeof value === "bigint") return "syntaxNumber";
	return "syntaxKeyword";
}

/** `value` on one row (`{a: 1}`), or undefined when it does not fit `INLINE_LEN`. */
function inlineValue(theme: Theme, value: unknown): string | undefined {
	let width = 0;
	let out = "";
	let run = "";
	let runColor = "";
	const flush = (): void => {
		if (run) out += theme.fg(runColor, run);
		run = "";
	};
	const push = (text: string, color: string): boolean => {
		width += visibleWidth(text);
		if (width > INLINE_LEN) return false;
		if (color !== runColor) flush();
		runColor = color;
		run += text;
		return true;
	};
	const walk = (entry: unknown): boolean => {
		if (Array.isArray(entry)) {
			if (!push("[", "muted")) return false;
			for (let i = 0; i < entry.length; i++) {
				if ((i > 0 && !push(", ", "muted")) || !walk(entry[i])) return false;
			}
			return push("]", "muted");
		}
		if (entry !== null && typeof entry === "object") {
			if (!push("{", "muted")) return false;
			let sep = "";
			for (const name in entry) {
				if (!push(`${sep}${BARE_KEY.test(name) ? name : JSON.stringify(name)}: `, "muted")) return false;
				if (!walk((entry as Record<string, unknown>)[name])) return false;
				sep = ", ";
			}
			return push("}", "muted");
		}
		return push(scalarText(entry), scalarColor(entry));
	};
	if (!walk(value)) return undefined;
	flush();
	return out;
}

function scalarText(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === undefined) return "undefined";
	return String(value);
}

/** Rows of a JSON value's tree. Keys in `hidden` are left out of the root. */
export function jsonTreeRows(
	theme: Theme,
	value: unknown,
	limits: JsonTreeLimits = EXPANDED_TREE,
	hidden: readonly string[] = [],
): { rows: string[]; truncated: boolean } {
	const rows: string[] = [];
	let truncated = false;
	const entriesOf = (container: unknown, root: boolean): [string, unknown, string][] => {
		if (Array.isArray(container)) return container.map((entry, i) => [String(i), entry, "dim"]);
		const out: [string, unknown, string][] = [];
		for (const key in container as Record<string, unknown>) {
			if (root && hidden.includes(key)) continue;
			out.push([key, (container as Record<string, unknown>)[key], "muted"]);
		}
		return out;
	};
	/**
	 * An entry's rows: `key: value` (a multi-line string continues under its
	 * opening quote, cut to the rows left), or `key [n]`/`key {n}` for a
	 * container that opens a subtree.
	 */
	const entryRows = (
		key: string,
		keyColor: string,
		entry: unknown,
		first: string,
		continuation: string,
	): { rows: string[]; container: boolean } => {
		const label = theme.fg(keyColor, key);
		if (entry !== null && typeof entry === "object") {
			const inline = inlineValue(theme, entry);
			if (inline !== undefined) return { rows: [`${first}${label}: ${inline}`], container: false };
			const size = Array.isArray(entry) ? entry.length : Object.keys(entry).length;
			const count = theme.fg("dim", Array.isArray(entry) ? `[${size}]` : `{${size}}`);
			return { rows: [`${first}${label} ${count}`], container: true };
		}
		if (typeof entry === "string" && entry.includes("\n")) {
			const lines = entry.split("\n");
			const shown = Math.min(lines.length, Math.max(1, limits.maxLines - rows.length - 1));
			const head = `${key}: `;
			const indent = `${continuation}${" ".repeat(visibleWidth(head) + 1)}`;
			const out = [`${first}${label}: ${theme.fg("syntaxString", `"${truncate(lines[0]!, limits.maxScalar)}`)}`];
			for (let i = 1; i < shown; i++)
				out.push(`${indent}${theme.fg("syntaxString", truncate(lines[i]!, limits.maxScalar))}`);
			if (lines.length > shown) {
				truncated = true;
				out.push(`${indent}${theme.fg("dim", `…(${lines.length - shown} more lines)"`)}`);
			} else out[out.length - 1] += theme.fg("syntaxString", '"');
			return { rows: out, container: false };
		}
		return {
			rows: [`${first}${label}: ${theme.fg(scalarColor(entry), truncate(scalarText(entry), limits.maxScalar))}`],
			container: false,
		};
	};
	const lastBranch = theme.fg("dim", theme.symbols.symbol("tree.last"));
	const branch = theme.fg("dim", theme.symbols.symbol("tree.branch"));
	const hook = theme.symbols.symbol("tree.hook");
	const vertical = theme.symbols.symbol("tree.vertical");

	/** A container's children under `gutter`; past the depth limit a lone `…` stands for them. */
	const walk = (container: object, depth: number, gutter: string): void => {
		const entries = entriesOf(container, false);
		if (entries.length === 0) return;
		if (depth > limits.maxDepth) {
			if (rows.length >= limits.maxLines) truncated = true;
			else rows.push(`${gutter}${lastBranch} ${theme.fg("dim", "…")}`);
			return;
		}
		entries.forEach(([key, entry, keyColor], i) => {
			if (rows.length >= limits.maxLines) {
				truncated = true;
				return;
			}
			const last = i === entries.length - 1;
			// The rails of open ancestors stay unstyled.
			const below = `${gutter}${last ? "   " : `${vertical}  `}`;
			const row = entryRows(key, keyColor, entry, `${gutter}${last ? lastBranch : branch} `, below);
			rows.push(...row.rows);
			if (row.container) walk(entry as object, depth + 1, below);
		});
	};
	if (value === null || typeof value !== "object") {
		rows.push(`${theme.fg("dim", hook)} ${theme.fg(scalarColor(value), scalarText(value))}`);
		return { rows, truncated };
	}
	const entries = entriesOf(value, true);
	const bullet = theme.symbols.symbol("format.bullet");
	const hookPad = " ".repeat(1 + visibleWidth(hook));
	const gutter = `${hookPad}${" ".repeat(1 + visibleWidth(bullet))}`;
	entries.forEach(([key, entry, keyColor], i) => {
		if (rows.length >= limits.maxLines) {
			truncated = true;
			return;
		}
		const lead = i === 0 ? `${theme.fg("dim", hook)} ` : hookPad;
		const row = entryRows(key, keyColor, entry, `${lead}${theme.fg("dim", bullet)} `, gutter);
		rows.push(...row.rows);
		if (row.container) walk(entry as object, 2, gutter);
	});
	return { rows, truncated };
}
