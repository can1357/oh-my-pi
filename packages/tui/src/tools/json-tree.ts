/**
 * JSON tree rendering utilities shared across tool renderers.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { TreeView, treeRowPrefix } from "../components/tree-view";
import { truncateToWidth } from "../render/render-utils";
import type { Theme, ThemeColor } from "../theme/theme";

/** Max depth for JSON tree rendering */
export const JSON_TREE_MAX_DEPTH_COLLAPSED = 2;
/** Maximum expanded JSON tree depth. */
export const JSON_TREE_MAX_DEPTH_EXPANDED = 6;
/** Maximum collapsed JSON tree rows. */
export const JSON_TREE_MAX_LINES_COLLAPSED = 6;
/** Maximum expanded JSON tree rows. */
export const JSON_TREE_MAX_LINES_EXPANDED = 200;
/** Maximum collapsed JSON scalar width. */
export const JSON_TREE_SCALAR_LEN_COLLAPSED = 60;
/** Maximum expanded JSON scalar width. */
export const JSON_TREE_SCALAR_LEN_EXPANDED = 2000;

const HIDDEN_ARG_KEYS = { [INTENT_FIELD]: 1, __partialJson: 1 };
const DEFAULT_HIDDEN_ROOT_KEYS: readonly string[] = Object.keys(HIDDEN_ARG_KEYS);

const ARGS_INLINE_PAIR_SEP = ", ";
const ARGS_INLINE_PAIR_SEP_WIDTH = Bun.stringWidth(ARGS_INLINE_PAIR_SEP);
const ARGS_INLINE_MORE = "…";
const ARGS_INLINE_MORE_WIDTH = Bun.stringWidth(ARGS_INLINE_MORE);
/** Minimal value footprint (quotes + a couple chars) reserved for each not-yet-rendered key. */
const ARGS_INLINE_TAIL_VALUE_RESERVE = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Sanitization, string summary, and budgeting policy for inline JSON. */
export interface InlineFormatOptions {
	sanitizeText?: (text: string) => string;
	multilineSummary?: boolean;
	/** Character-count output budget, retaining the first pair even when oversized. */
	characterBudget?: boolean;
}

/** Format a scalar with optional sanitized multiline summaries. */
export function formatScalar(value: unknown, maxLen: number, options: InlineFormatOptions = {}): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const text = options.sanitizeText?.(value) ?? value;
		if (options.multilineSummary) {
			const lines = text.split("\n");
			const firstLine = lines[0].trim();
			if (!firstLine) return `"" (${lines.length} lines)`;
			const preview = truncateToWidth(firstLine, maxLen);
			return lines.length > 1 ? `"${preview}…" (${lines.length} lines)` : `"${preview}"`;
		}
		const escaped = text.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		const truncated = truncateToWidth(escaped, maxLen);
		return `"${truncated}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return `{${keys.length} keys}`;
	}
	const text = String(value);
	return options.sanitizeText?.(text) ?? text;
}

/** Format args inline with either display-cell or legacy output character budgeting. */
export function formatArgsInline(
	args: Record<string, unknown>,
	maxWidth: number,
	options: InlineFormatOptions = {},
): string {
	if (options.characterBudget) {
		const pairs: string[] = [];
		let length = 0;
		for (const key in args) {
			if (!Object.hasOwn(args, key)) continue;
			const pair = `${options.sanitizeText?.(key) ?? key}=${formatScalar(args[key], 24, options)}`;
			const added = pair.length + (pairs.length > 0 ? 2 : 0);
			if (length + added > maxWidth && pairs.length > 0) {
				pairs.push("…");
				break;
			}
			pairs.push(pair);
			length += added;
		}
		return pairs.join(", ");
	}
	const keys: string[] = [];
	for (const key in args) {
		if (key in HIDDEN_ARG_KEYS) continue;
		keys.push(key);
	}
	let result = "";
	let width = 0;
	for (let i = 0; i < keys.length; i++) {
		const rawKey = keys[i];
		const key = options.sanitizeText?.(rawKey) ?? rawKey;
		const value = args[rawKey];
		const sep = width > 0 ? ARGS_INLINE_PAIR_SEP : "";
		const sepW = width > 0 ? ARGS_INLINE_PAIR_SEP_WIDTH : 0;
		const current = width + sepW;
		const cap = maxWidth - current - ARGS_INLINE_MORE_WIDTH;
		if (cap <= 0) {
			return `${result}${ARGS_INLINE_MORE}`;
		}
		// Reserve each still-pending key's minimal footprint (sep + name + `=` +
		// a short value) so a long value can't starve the keys that follow it.
		let tailReserve = 0;
		for (let j = i + 1; j < keys.length; j++) {
			const tailKey = options.sanitizeText?.(keys[j]) ?? keys[j];
			tailReserve += ARGS_INLINE_PAIR_SEP_WIDTH + Bun.stringWidth(tailKey) + 1 + ARGS_INLINE_TAIL_VALUE_RESERVE;
		}
		// Budget the whole `key=value` piece against the width left after the
		// tail reserve, then back out the value's share. The last key reserves
		// nothing and fills the line.
		const pieceBudget = Math.min(cap, maxWidth - current - tailReserve);
		const valueMaxLen = Math.max(1, pieceBudget - Bun.stringWidth(key) - 3);
		const valueStr = formatScalar(value, valueMaxLen, options);
		const piece = `${key}=${valueStr}`;
		const pieceW = Bun.stringWidth(piece);
		if (pieceW > pieceBudget) {
			return `${result}${sep}${truncateToWidth(piece, cap)}`;
		}
		result += sep + piece;
		width = current + pieceW;
	}
	return result;
}

const OUTPUT_INLINE_OPTIONS: InlineFormatOptions = {
	sanitizeText,
	multilineSummary: true,
	characterBudget: true,
};

/** Summarize a task's structured output without expanding its JSON tree. */
export function formatOutputInline(data: unknown, maxWidth = 80): string {
	const options = OUTPUT_INLINE_OPTIONS;
	if (data === null || data === undefined) return "Output: none";
	if (typeof data !== "object") return `Output: ${formatScalar(data, 60, options)}`;
	if (Array.isArray(data)) {
		if (data.length === 0) return "Output: []";
		return `Output: [${data.length} items] ${formatScalar(data[0], 40, options)}${data.length > 1 ? "…" : ""}`;
	}
	return `Output: ${formatArgsInline(data as Record<string, unknown>, maxWidth - "Output: ".length, options) || "{}"}`;
}

/** JSON hierarchy policy accepted by {@link renderJsonTreeLines}. */
export interface JsonTreeRenderOptions {
	maxDepth: number;
	maxLines: number;
	maxScalarLen: number;
	/** Sanitize object keys and string/scalar text before styling. */
	sanitizeText?: (text: string) => string;
	/** Root object keys omitted from display. Defaults to internal tool argument metadata. */
	hiddenRootKeys?: readonly string[];
	/** Preserve embedded newlines as continuation rows. Defaults to true. */
	multilineStrings?: boolean;
	/** Escape inline tabs/newlines as JSON-style sequences. Defaults to true. */
	escapeStringWhitespace?: boolean;
	/**
	 * Root row gutter. `hooked` (default) attaches the tree to the block above:
	 * the first root draws `└ •`, the rest ` •`, and nested rows branch from
	 * under the bullet. `siblings` draws standard `├─`/`└─` root connectors.
	 */
	rootConnectors?: "hooked" | "siblings";
}

type JsonTreeNodeKind = "array" | "object" | "scalar" | "placeholder";

interface JsonTreeNode {
	id: number;
	key: string | undefined;
	value: unknown;
	depth: number;
	kind: JsonTreeNodeKind;
	placeholder?: "…";
	children?: readonly JsonTreeNode[];
}

function jsonNodeKind(value: unknown): JsonTreeNodeKind {
	if (Array.isArray(value)) return "array";
	if (isRecord(value)) return "object";
	return "scalar";
}

/**
 * Render a JSON value as bounded tree lines. The positional form remains the
 * public tool-renderer contract; the options form exposes sanitization and root
 * connector policy for specialized adapters such as nested task output.
 */
export function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	maxDepth: number,
	maxLines: number,
	maxScalarLen: number,
): { lines: string[]; truncated: boolean };
export function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	options: JsonTreeRenderOptions,
): { lines: string[]; truncated: boolean };
export function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	optionsOrMaxDepth: JsonTreeRenderOptions | number,
	maxLinesArg?: number,
	maxScalarLenArg?: number,
): { lines: string[]; truncated: boolean } {
	const options: JsonTreeRenderOptions =
		typeof optionsOrMaxDepth === "number"
			? {
					maxDepth: optionsOrMaxDepth,
					maxLines: maxLinesArg ?? JSON_TREE_MAX_LINES_EXPANDED,
					maxScalarLen: maxScalarLenArg ?? JSON_TREE_SCALAR_LEN_EXPANDED,
				}
			: optionsOrMaxDepth;
	const maxDepth = Math.max(0, Math.trunc(options.maxDepth));
	const maxLines = Math.max(0, Math.trunc(options.maxLines));
	const maxScalarLen = Math.max(0, Math.trunc(options.maxScalarLen));
	const sanitize = options.sanitizeText ?? (text => text);
	const hiddenRootKeys = options.hiddenRootKeys ?? DEFAULT_HIDDEN_ROOT_KEYS;
	const multilineStrings = options.multilineStrings ?? true;
	const escapeStringWhitespace = options.escapeStringWhitespace ?? true;
	const hookedRoots = (options.rootConnectors ?? "hooked") === "hooked";
	let nextId = 0;

	const node = (nodeValue: unknown, key: string | undefined, depth: number): JsonTreeNode => ({
		id: nextId++,
		key,
		value: nodeValue,
		depth,
		kind: jsonNodeKind(nodeValue),
	});

	let roots: readonly JsonTreeNode[];
	if (isRecord(value)) {
		const objectRoots: JsonTreeNode[] = [];
		for (const key in value) {
			if (!hiddenRootKeys.includes(key)) objectRoots.push(node(value[key], key, 1));
		}
		roots = objectRoots;
	} else if (Array.isArray(value)) {
		roots = value.map((child, index) => node(child, `[${index}]`, 1));
	} else {
		roots = [node(value, undefined, 0)];
	}

	const prefixStyle = { vertical: (symbol: string) => symbol };
	const hook = theme.tree.hook;
	const hookPad = " ".repeat(Bun.stringWidth(hook));
	const bullet = theme.format.bullet;
	// Nested rows drop the root's three-cell gutter and branch from under the root label.
	const rootGutter = `${hookPad} ${" ".repeat(Bun.stringWidth(bullet))} `;
	let renderedLineCount = 0;
	let scalarTruncated = false;

	const tree = new TreeView<JsonTreeNode, number>({
		roots,
		getKey: item => item.id,
		getChildren: item => {
			if (item.children) return item.children;
			let children: readonly JsonTreeNode[] = [];
			if (item.kind === "array" && Array.isArray(item.value)) {
				const values = item.value;
				if (values.length === 0) {
					children = [];
				} else if (item.depth >= maxDepth) {
					children = [
						{
							id: nextId++,
							key: undefined,
							value: undefined,
							depth: item.depth + 1,
							kind: "placeholder",
							placeholder: "…",
						},
					];
				} else {
					children = values.map((child, index) => node(child, `[${index}]`, item.depth + 1));
				}
			} else if (item.kind === "object" && isRecord(item.value)) {
				const record = item.value;
				const keys = Object.keys(record);
				if (item.depth >= maxDepth) {
					children = [
						{
							id: nextId++,
							key: undefined,
							value: undefined,
							depth: item.depth + 1,
							kind: "placeholder",
							placeholder: "…",
						},
					];
				} else if (keys.length === 0) {
					children = [];
				} else {
					const objectChildren: JsonTreeNode[] = [];
					for (const key in record) objectChildren.push(node(record[key], key, item.depth + 1));
					children = objectChildren;
				}
			}
			item.children = children;
			return children;
		},
		maxItems: maxLines + 1,
		maxLines,
		theme,
		renderPrefix: itemRow => {
			if (!hookedRoots) return treeRowPrefix(itemRow, theme, prefixStyle);
			if (itemRow.ancestors.length === 0) {
				const lead = itemRow.siblingIndex === 0 ? theme.fg("dim", hook) : hookPad;
				return { first: `${lead} ${theme.fg("dim", bullet)} `, continuation: rootGutter };
			}
			const inner = treeRowPrefix({ ...itemRow, ancestors: itemRow.ancestors.slice(1) }, theme, prefixStyle);
			return { first: `${rootGutter}${inner.first}`, continuation: `${rootGutter}${inner.continuation}` };
		},
		renderRow: item => {
			let body: readonly string[];
			const displayKey = item.key ? sanitize(item.key) : undefined;
			const label = theme.fg(
				"muted",
				displayKey || (item.kind === "array" ? "array" : item.kind === "object" ? "object" : "value"),
			);
			if (item.kind === "placeholder") {
				body = [theme.fg("dim", item.placeholder ?? "…")];
			} else if (item.kind === "array") {
				body = [`${label} ${theme.fg("dim", `[${(item.value as unknown[]).length}]`)}`];
			} else if (item.kind === "object") {
				body = [`${label} ${theme.fg("dim", `{${Object.keys(item.value as object).length}}`)}`];
			} else if (typeof item.value === "string") {
				const sanitized = sanitize(item.value);
				if (multilineStrings && sanitized.includes("\n")) {
					const sourceLines = sanitized.split("\n");
					const available = Math.max(1, maxLines - renderedLineCount);
					const displayedCount = Math.min(sourceLines.length, Math.max(1, available - 1));
					const head = `${label}: `;
					// Continuation rows sit under the opening quote.
					const indent = " ".repeat(Bun.stringWidth(Bun.stripANSI(head)) + 1);
					const scalarLines = [
						`${head}${theme.fg("syntaxString", `"${truncateToWidth(sourceLines[0] ?? "", maxScalarLen)}`)}`,
					];
					for (let index = 1; index < displayedCount; index++) {
						scalarLines.push(
							`${indent}${theme.fg("syntaxString", truncateToWidth(sourceLines[index] ?? "", maxScalarLen))}`,
						);
					}
					if (sourceLines.length > displayedCount) {
						scalarTruncated = true;
						scalarLines.push(
							`${indent}${theme.fg("dim", `…(${sourceLines.length - displayedCount} more lines)"`)}`,
						);
					} else {
						const lastIndex = scalarLines.length - 1;
						scalarLines[lastIndex] = `${scalarLines[lastIndex]}${theme.fg("syntaxString", '"')}`;
					}
					body = scalarLines;
				} else {
					const scalar = escapeStringWhitespace
						? formatScalar(sanitized, maxScalarLen)
						: `"${truncateToWidth(sanitized, maxScalarLen)}"`;
					body = [`${label}: ${theme.fg("syntaxString", scalar)}`];
				}
			} else {
				const color: ThemeColor =
					typeof item.value === "number"
						? "syntaxNumber"
						: typeof item.value === "boolean" || item.value === null || item.value === undefined
							? "syntaxKeyword"
							: "dim";
				body = [`${label}: ${theme.fg(color, sanitize(formatScalar(item.value, maxScalarLen)))}`];
			}
			renderedLineCount += body.length;
			return body;
		},
	});
	const rendered = tree.renderWithState(Number.POSITIVE_INFINITY);
	return { lines: [...rendered.lines], truncated: rendered.truncated || scalarTruncated };
}
