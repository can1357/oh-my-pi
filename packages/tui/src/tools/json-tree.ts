/**
 * JSON tree rendering utilities shared across tool renderers.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { TreeView, treeRowPrefix } from "../components/tree-view";
import { truncateToWidth } from "../render/render-utils";
import type { Theme } from "../theme/theme";

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

/**
 * Format a scalar value for inline display.
 */
export function formatScalar(value: unknown, maxLen: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const escaped = value.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		const truncated = truncateToWidth(escaped, maxLen);
		return `"${truncated}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return `{${keys.length} keys}`;
	}
	return String(value);
}

/**
 * Format args inline for collapsed view.
 */
export function formatArgsInline(args: Record<string, unknown>, maxWidth: number): string {
	const keys: string[] = [];
	for (const key in args) {
		if (key in HIDDEN_ARG_KEYS) continue;
		keys.push(key);
	}
	let result = "";
	let width = 0;
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const value = args[key];
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
			tailReserve += ARGS_INLINE_PAIR_SEP_WIDTH + Bun.stringWidth(keys[j]) + 1 + ARGS_INLINE_TAIL_VALUE_RESERVE;
		}
		// Budget the whole `key=value` piece against the width left after the
		// tail reserve, then back out the value's share. The last key reserves
		// nothing and fills the line.
		const pieceBudget = Math.min(cap, maxWidth - current - tailReserve);
		const valueMaxLen = Math.max(1, pieceBudget - Bun.stringWidth(key) - 3);
		const valueStr = formatScalar(value, valueMaxLen);
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
	/** Existing argument trees draw every root object key with a terminal connector. */
	rootConnectors?: "all-last" | "siblings";
}

type JsonTreeNodeKind = "array" | "object" | "scalar" | "placeholder";

interface JsonTreeNode {
	id: number;
	key: string | undefined;
	value: unknown;
	depth: number;
	kind: JsonTreeNodeKind;
	placeholder?: "[]" | "{}" | "…";
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
	const rootConnectors = options.rootConnectors ?? "all-last";
	const forceTerminalRootConnectors = rootConnectors === "all-last" && isRecord(value);
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

	const iconObject = theme.styledSymbol("icon.folder", "muted");
	const iconArray = theme.styledSymbol("icon.package", "muted");
	const iconScalar = theme.styledSymbol("icon.file", "muted");
	const prefixStyle = { vertical: (symbol: string) => symbol };
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
					children = [
						{
							id: nextId++,
							key: undefined,
							value: undefined,
							depth: item.depth + 1,
							kind: "placeholder",
							placeholder: "[]",
						},
					];
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
					children = [
						{
							id: nextId++,
							key: undefined,
							value: undefined,
							depth: item.depth + 1,
							kind: "placeholder",
							placeholder: "{}",
						},
					];
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
			if (!forceTerminalRootConnectors) return treeRowPrefix(itemRow, theme, prefixStyle);
			const ancestors =
				itemRow.ancestors.length === 0
					? itemRow.ancestors
					: [{ ...itemRow.ancestors[0]!, isLast: true }, ...itemRow.ancestors.slice(1)];
			return treeRowPrefix(
				{ ...itemRow, ancestors, isLast: itemRow.parentKey === undefined || itemRow.isLast },
				theme,
				prefixStyle,
			);
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
				body = [`${iconArray} ${label}`];
			} else if (item.kind === "object") {
				body = [`${iconObject} ${label}`];
			} else if (typeof item.value === "string" && multilineStrings) {
				const sanitized = sanitize(item.value);
				if (sanitized.includes("\n")) {
					const sourceLines = sanitized.split("\n");
					const available = Math.max(1, maxLines - renderedLineCount);
					const displayedCount = Math.min(sourceLines.length, Math.max(1, available - 1));
					const scalarLines = [
						`${iconScalar} ${label}: ${theme.fg("dim", `"${truncateToWidth(sourceLines[0] ?? "", maxScalarLen)}`)}`,
					];
					for (let index = 1; index < displayedCount; index++) {
						scalarLines.push(
							`   ${theme.fg("dim", ` ${truncateToWidth(sourceLines[index] ?? "", maxScalarLen)}`)}`,
						);
					}
					if (sourceLines.length > displayedCount) {
						scalarTruncated = true;
						scalarLines.push(`   ${theme.fg("dim", ` …(${sourceLines.length - displayedCount} more lines)"`)}`);
					} else {
						const lastIndex = scalarLines.length - 1;
						scalarLines[lastIndex] = `${scalarLines[lastIndex]}${theme.fg("dim", '"')}`;
					}
					body = scalarLines;
				} else {
					const scalar = escapeStringWhitespace
						? formatScalar(sanitized, maxScalarLen)
						: `"${truncateToWidth(sanitized, maxScalarLen)}"`;
					body = [`${iconScalar} ${label}: ${theme.fg("dim", scalar)}`];
				}
			} else {
				const scalar =
					typeof item.value === "string"
						? formatScalar(sanitize(item.value), maxScalarLen)
						: formatScalar(item.value, maxScalarLen);
				body = [`${iconScalar} ${label}: ${theme.fg("dim", sanitize(scalar))}`];
			}
			renderedLineCount += body.length;
			return body;
		},
	});
	const rendered = tree.renderWithState(Number.POSITIVE_INFINITY);
	return { lines: [...rendered.lines], truncated: rendered.truncated || scalarTruncated };
}
