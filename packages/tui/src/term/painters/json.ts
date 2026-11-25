/**
 * `json`: a JSON value as a tree. The root's entries are listed as
 * `└ • key: value`; containers within `open` levels list their own entries
 * below on `├─`/`└─` branches, deeper ones fold to an inline preview
 * (`{id: "x", stars: 3}`) cut to the row. Scalars are colored like code.
 */
import type { TspJsonProps } from "@oh-my-pi/pi-wire";
import type { Theme } from "../../theme/contract";
import { replaceTabs, truncate } from "../../text/width";
import { type Block, definePainter } from "../paint";

/** A scalar as JSON, colored by type. */
export function jsonScalar(theme: Theme, value: unknown): string {
	if (typeof value === "string") return theme.fg("syntaxString", replaceTabs(JSON.stringify(value)));
	if (typeof value === "number" || typeof value === "bigint") return theme.fg("syntaxNumber", String(value));
	if (typeof value === "boolean" || value === null || value === undefined)
		return theme.fg("syntaxKeyword", String(value ?? null));
	return theme.fg("muted", String(value));
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
	return typeof value === "object" && value !== null;
}

/** A value on one line: containers as `{k: v, …}` / `[a, b]` with muted punctuation. */
export function jsonInline(theme: Theme, value: unknown): string {
	if (!isContainer(value)) return jsonScalar(theme, value);
	if (Array.isArray(value)) {
		const parts = value.map(item => jsonInline(theme, item));
		return `${theme.fg("muted", "[")}${parts.join(theme.fg("muted", ", "))}${theme.fg("muted", "]")}`;
	}
	const parts = Object.entries(value).map(
		([key, item]) => `${theme.fg("muted", `${key}: `)}${jsonInline(theme, item)}`,
	);
	return `${theme.fg("muted", "{")}${parts.join(theme.fg("muted", ", "))}${theme.fg("muted", "}")}`;
}

function entries(value: Record<string, unknown> | unknown[]): [string, unknown][] {
	return Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value);
}

function size(value: Record<string, unknown> | unknown[]): string {
	return Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
}

/** Tree rows of `value` at `width`, containers expanded `open` levels below the root's entries. */
export function jsonRows(theme: Theme, value: unknown, width: number, open = 0): string[] {
	const rows: string[] = [];
	const push = (row: string) => rows.push(truncate(row, width, theme.symbols.ellipsis));
	const dim = (text: string) => theme.fg("dim", text);
	const branch = (children: [string, unknown][], indent: string, level: number) => {
		for (let i = 0; i < children.length; i++) {
			const [key, item] = children[i]!;
			const last = i === children.length - 1;
			const lead = `${indent}${dim(last ? "└─" : "├─")} ${dim(key)}: `;
			if (isContainer(item) && level < open) {
				push(`${indent}${dim(last ? "└─" : "├─")} ${dim(key)} ${dim(size(item))}`);
				branch(entries(item), `${indent}${last ? "   " : `${dim("│")}  `}`, level + 1);
			} else push(`${lead}${jsonInline(theme, item)}`);
		}
	};
	if (!isContainer(value)) {
		push(jsonScalar(theme, value));
		return rows;
	}
	const top = entries(value);
	if (top.length === 0) {
		push(theme.fg("muted", Array.isArray(value) ? "[]" : "{}"));
		return rows;
	}
	for (let i = 0; i < top.length; i++) {
		const [key, item] = top[i]!;
		const lead = `${dim(i === top.length - 1 ? "└" : "├")} ${dim("•")} ${theme.fg("muted", key)}`;
		if (isContainer(item) && open > 0 && entries(item).length > 0) {
			push(`${lead} ${dim(size(item))}`);
			branch(entries(item), "    ", 1);
		} else push(`${lead}: ${jsonInline(theme, item)}`);
	}
	return rows;
}

definePainter("json", (node, cx): Block => {
	const props = node.props() as TspJsonProps;
	if (cx.width <= 0) return { rows: [] };
	return {
		rows: jsonRows(cx.theme, props.value ?? null, cx.width, props.open ?? 0),
	};
});
