/**
 * JSON tree rendering utilities shared across tool renderers.
 */
import { INTENT_FIELD, type TspSpan, type TspTreeNode } from "@oh-my-pi/pi-wire";
import { sanitizeText, sanitizeTextDeep } from "@oh-my-pi/pi-utils";
import { TreeView, treeRowPrefix } from "../components/tree-view";
import { truncateToWidth } from "../render/render-utils";
import type { Theme, ThemeColor } from "../theme/theme";
import { node, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { plainText } from "../native/spans";

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
/** Characters a container's one-line form may take before a JSON tree lists its entries instead. */
export const JSON_TREE_INLINE_LEN = 60;

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
			if (!Object.hasOwn(args, key) || key in HIDDEN_ARG_KEYS) continue;
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

/** Object keys a one-line JSON form shows unquoted. */
const BARE_KEY = /^[\w$-]+$/;

/** One styled run of a one-line JSON form. */
type InlineRun = readonly [text: string, color: ThemeColor];

/**
 * A container's one-line form (`[[3, "vt"], 98]`, `{lines: 70, done: true}`)
 * as styled runs, so tree rows show small containers whole instead of one row
 * per value; undefined for a scalar or a form past {@link JSON_TREE_INLINE_LEN}
 * characters. Keys stay bare unless {@link BARE_KEY} rejects them, strings are
 * JSON-escaped, and `clean` sanitizes both first.
 */
function inlineJson(value: unknown, clean: (text: string) => string): InlineRun[] | undefined {
	if (!Array.isArray(value) && !isRecord(value)) return undefined;
	const runs: InlineRun[] = [];
	let length = 0;
	// Every container pushes a bracket before descending, so cycles hit the cap too.
	const push = (text: string, color: ThemeColor): boolean => {
		length += text.length;
		if (length > JSON_TREE_INLINE_LEN) return false;
		const last = runs.at(-1);
		if (last?.[1] === color) runs[runs.length - 1] = [last[0] + text, color];
		else runs.push([text, color]);
		return true;
	};
	const walk = (entry: unknown): boolean => {
		if (Array.isArray(entry)) {
			if (!push("[", "muted")) return false;
			for (let index = 0; index < entry.length; index++) {
				if ((index > 0 && !push(", ", "muted")) || !walk(entry[index])) return false;
			}
			return push("]", "muted");
		}
		if (isRecord(entry)) {
			if (!push("{", "muted")) return false;
			let sep = "";
			for (const key in entry) {
				const name = clean(key);
				if (!push(`${sep}${BARE_KEY.test(name) ? name : JSON.stringify(name)}: `, "muted")) return false;
				if (!walk(entry[key])) return false;
				sep = ", ";
			}
			return push("}", "muted");
		}
		if (typeof entry === "string") return push(JSON.stringify(clean(entry)), "syntaxString");
		return push(clean(formatScalar(entry, JSON_TREE_INLINE_LEN)), jsonScalarToken(entry));
	};
	return walk(value) ? runs : undefined;
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

type JsonTreeNodeKind = "array" | "object" | "inline" | "scalar" | "placeholder";

interface JsonTreeNode {
	id: number;
	key: string | undefined;
	value: unknown;
	depth: number;
	kind: JsonTreeNodeKind;
	/** The key's color: `dim` for array indices, else `muted`. */
	keyColor?: ThemeColor;
	/** The one-line form of an `inline` container. */
	inline?: readonly InlineRun[];
	placeholder?: "…";
	children?: readonly JsonTreeNode[];
}

function jsonNodeKind(value: unknown): JsonTreeNodeKind {
	if (Array.isArray(value)) return "array";
	if (isRecord(value)) return "object";
	return "scalar";
}

/**
 * Render a JSON value as bounded tree lines, containers that fit
 * {@link JSON_TREE_INLINE_LEN} on one row. The positional form remains the
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

	const node = (nodeValue: unknown, key: string | undefined, depth: number, keyColor?: ThemeColor): JsonTreeNode => {
		const inline = inlineJson(nodeValue, sanitize);
		const kind = inline ? "inline" : jsonNodeKind(nodeValue);
		return { id: nextId++, key, value: nodeValue, depth, kind, keyColor, inline };
	};
	const entryNodes = (entries: readonly JsonEntry[], depth: number): JsonTreeNode[] =>
		entries.map(([key, child, keyColor]) => node(child, key, depth, keyColor));

	const roots: readonly JsonTreeNode[] =
		Array.isArray(value) || isRecord(value)
			? entryNodes(jsonEntries(value, hiddenRootKeys), 1)
			: [node(value, undefined, 0)];

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
					children = entryNodes(jsonEntries(values), item.depth + 1);
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
					children = entryNodes(jsonEntries(record), item.depth + 1);
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
				item.keyColor ?? "muted",
				displayKey || (item.kind === "array" ? "array" : item.kind === "object" ? "object" : "value"),
			);
			if (item.kind === "placeholder") {
				body = [theme.fg("dim", item.placeholder ?? "…")];
			} else if (item.kind === "inline") {
				body = [`${label}: ${(item.inline ?? []).map(([text, color]) => theme.fg(color, text)).join("")}`];
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

/** Data caps for {@link describeJsonTree}. */
export interface JsonTreeDescribeOptions {
	/** Deepest level expanded into child nodes; deeper containers get a `…` child. */
	maxDepth?: number;
	/** Tree nodes emitted before the remaining siblings collapse into `… N more`. */
	maxNodes?: number;
	/** Characters kept per string scalar (data cap, not a width). */
	maxScalarLen?: number;
	/** Levels open initially; deeper containers start closed. */
	openDepth?: number;
	/** Root object keys omitted. Defaults to internal tool argument metadata. */
	hiddenRootKeys?: readonly string[];
	/** Called after the tree is built if a depth, node or scalar cap left part of the value out. */
	onTruncated?: () => void;
}

type JsonEntry = readonly [key: string, value: unknown, keyColor: ThemeColor];

function clipScalar(value: string, maxLen: number): string {
	return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
}

/**
 * `value`'s entries: an array's indices dim and right-aligned like line
 * numbers, an object's keys (less `hidden`) muted.
 */
function jsonEntries(value: unknown[] | Record<string, unknown>, hidden?: readonly string[]): JsonEntry[] {
	const out: JsonEntry[] = [];
	if (Array.isArray(value)) {
		const width = String(value.length - 1).length;
		for (let index = 0; index < value.length; index++) {
			out.push([String(index).padStart(width), value[index], "dim"]);
		}
		return out;
	}
	for (const key in value) {
		if (!hidden?.includes(key)) out.push([key, value[key], "muted"]);
	}
	return out;
}

function jsonScalarToken(value: unknown): ThemeColor {
	if (typeof value === "number" || typeof value === "bigint") return "syntaxNumber";
	if (typeof value === "boolean" || value === null || value === undefined) return "syntaxKeyword";
	return "dim";
}

/**
 * TSP `tree` of a JSON value: containers that fit {@link JSON_TREE_INLINE_LEN}
 * become `key: [1, "a"]` leaves, larger ones expandable nodes labelled with
 * their key and size, scalars `key: value` leaves styled by type. Bounded by
 * depth, node count and scalar length; no width math.
 */
export function describeJsonTree(value: unknown, options: JsonTreeDescribeOptions = {}): NativeNode {
	const maxDepth = Math.max(0, options.maxDepth ?? JSON_TREE_MAX_DEPTH_EXPANDED);
	const maxScalarLen = Math.max(1, options.maxScalarLen ?? JSON_TREE_SCALAR_LEN_EXPANDED);
	const openDepth = options.openDepth ?? JSON_TREE_MAX_DEPTH_COLLAPSED;
	let budget = Math.max(1, options.maxNodes ?? JSON_TREE_MAX_LINES_EXPANDED);
	let truncated = false;
	let nextId = 0;
	const leaf = (label: readonly TspSpan[]): TspTreeNode => ({ id: `${nextId++}`, label });

	const describeEntries = (entries: readonly JsonEntry[], depth: number): TspTreeNode[] => {
		const out: TspTreeNode[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (budget <= 0) {
				truncated = true;
				out.push(leaf([span(`… ${entries.length - index} more`, "dim")]));
				break;
			}
			out.push(describeValue(entries[index], depth));
		}
		return out;
	};

	const describeValue = (
		[key, entry, keyColor]: readonly [key: string | undefined, value: unknown, keyColor?: ThemeColor],
		depth: number,
	): TspTreeNode => {
		budget--;
		const id = `${nextId++}`;
		const keySpans: TspSpan[] = key === undefined ? [] : [span(plainText(key), keyColor)];
		const prefix = keySpans.length > 0 ? [...keySpans, span(": ", "muted")] : [];
		const inline = inlineJson(entry, plainText);
		if (inline) return { id, label: [...prefix, ...inline.map(([text, color]) => span(text, color))] };
		if (Array.isArray(entry) || isRecord(entry)) {
			const entries = jsonEntries(entry);
			const size = Array.isArray(entry) ? `[${entry.length}]` : `{${entries.length}}`;
			const label = keySpans.length > 0 ? [...keySpans, span(` ${size}`, "dim")] : [span(size, "dim")];
			if (depth >= maxDepth) truncated = true;
			const children = depth >= maxDepth ? [leaf([span("…", "dim")])] : describeEntries(entries, depth + 1);
			return { id, label, open: depth < openDepth, children };
		}
		if (typeof entry === "string") {
			const lines = plainText(entry).split("\n");
			if (lines.some(line => line.length > maxScalarLen)) truncated = true;
			const first = clipScalar(lines[0], maxScalarLen);
			if (lines.length === 1) return { id, label: [...prefix, span(`"${first}"`, "syntaxString")] };
			const children: TspTreeNode[] = [];
			for (let index = 0; index < lines.length; index++) {
				if (budget <= 0) {
					truncated = true;
					children.push(leaf([span(`… ${lines.length - index} more lines`, "dim")]));
					break;
				}
				budget--;
				children.push(leaf([span(clipScalar(lines[index], maxScalarLen), "syntaxString")]));
			}
			return {
				id,
				label: [...prefix, span(`"${first}…"`, "syntaxString"), span(` (${lines.length} lines)`, "dim")],
				open: false,
				children,
			};
		}
		return { id, label: [...prefix, span(plainText(formatScalar(entry, maxScalarLen)), jsonScalarToken(entry))] };
	};

	let nodes: TspTreeNode[];
	if (Array.isArray(value) || isRecord(value)) {
		const hidden = Array.isArray(value) ? undefined : (options.hiddenRootKeys ?? DEFAULT_HIDDEN_ROOT_KEYS);
		const entries = jsonEntries(value, hidden);
		nodes =
			entries.length > 0 ? describeEntries(entries, 1) : [leaf([span(Array.isArray(value) ? "[]" : "{}", "dim")])];
	} else {
		nodes = [describeValue([undefined, value], 0)];
	}
	if (truncated) options.onTruncated?.();
	return node("tree", { nodes });
}

/** Options of {@link describeJsonValue}: the `json` node's own, plus the fallback tree's. */
export interface JsonValueDescribeOptions extends JsonTreeDescribeOptions {
	/** The host draws the `json` kind (`cx.supports("json")`). */
	native?: boolean;
	/** `json` node: container levels expanded below the top-level entries (default 0). */
	open?: number;
}

/**
 * A JSON value for a TSP host: the terminal's own `json` viewer when it draws
 * the kind, which folds and previews containers itself and never cuts (so
 * `onTruncated` never fires), else {@link describeJsonTree} with the same
 * options. Root keys the tree would hide are left out of the sent value too;
 * strings are sanitized like the tree's labels.
 */
export function describeJsonValue(value: unknown, options: JsonValueDescribeOptions = {}): NativeNode {
	if (!options.native) return describeJsonTree(value, options);
	let shown = value;
	if (isRecord(value)) {
		const hidden = options.hiddenRootKeys ?? DEFAULT_HIDDEN_ROOT_KEYS;
		if (hidden.some(key => Object.hasOwn(value, key))) {
			const kept: Record<string, unknown> = {};
			for (const key in value) if (!hidden.includes(key)) kept[key] = value[key];
			shown = kept;
		}
	}
	return node("json", { value: sanitizeTextDeep(shown), open: options.open || undefined });
}
