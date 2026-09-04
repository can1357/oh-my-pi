import { type } from "@oh-my-pi/omptype";
import { HL_FILE_PREFIX, HL_FILE_SUFFIX } from "../tools/hashline-format";
import { normalizeMutationPaths } from "../tools/path-utils";

const LEGACY_HASHLINE_FILE_PREFIX = "¶";
const HASHLINE_FILE_TAG_RE = /#[0-9a-fA-F]{4}$/u;
const nonEmptyString = type("string > 0");

/**
 * A tool call's arguments as extensions and hooks observe them: the tool's own
 * fields plus the path projection this module derives. Field values come from
 * the model, so nothing here is trusted until a boundary parses it — the
 * omptype guards below and each tool's own schema are those boundaries.
 */
export interface ToolEventInput extends Record<string, unknown> {}

/** The tool surface this module reads: its name, its edit-payload resolver, and its mutation-target parser. */
interface ToolEventInputResolver {
	name: string;
	resolveEventInput?: (input: string) => string;
	/** A method, not a property, so a tool can declare its own parameter type. */
	mutationPaths?(args: ToolEventInput): readonly string[] | undefined;
}

/** Tools whose calls write files, and therefore carry `plannedMutationPaths`. */
const MUTATING_TOOL_NAMES = { ast_edit: true, edit: true, lsp: true, write: true } satisfies Record<string, true>;

/** Resolves mode-specific textual tool input before extension/hook event normalization. */
export function resolveToolEventInput(tool: ToolEventInputResolver, input: ToolEventInput): ToolEventInput {
	if (tool.name !== "edit" || tool.resolveEventInput === undefined) return input;
	let resolved = input;
	for (const key of ["input", "_input"] as const) {
		const value = stringField(resolved, key);
		if (value === undefined) continue;
		const nextValue = tool.resolveEventInput(value);
		if (nextValue === value) continue;
		resolved = Object.assign({}, resolved, { [key]: nextValue });
	}
	return resolved;
}

function stringField(input: ToolEventInput, key: string): string | undefined {
	const value = nonEmptyString(Object.getOwnPropertyDescriptor(input, key)?.value);
	return value instanceof type.errors ? undefined : value;
}

function normalizeHashlineHeaderPath(body: string): string | undefined {
	const trimmed = body.trim();
	if (trimmed.length === 0) return undefined;
	const hashStart = HASHLINE_FILE_TAG_RE.exec(trimmed)?.index;
	const rawPath = hashStart === undefined ? trimmed : trimmed.slice(0, hashStart);
	if (rawPath.length < 2) return rawPath.length > 0 ? rawPath : undefined;
	const first = rawPath[0];
	const last = rawPath[rawPath.length - 1];
	if ((first === '"' || first === "'") && first === last) return rawPath.slice(1, -1);
	return rawPath;
}

function extractHashlinePaths(input: string): string[] {
	const paths: string[] = [];
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		let body: string;
		if (line.startsWith(HL_FILE_PREFIX) && line.endsWith(HL_FILE_SUFFIX)) {
			body = line.slice(HL_FILE_PREFIX.length, line.length - HL_FILE_SUFFIX.length);
		} else {
			const legacyLine = line.trimStart();
			if (!legacyLine.startsWith(LEGACY_HASHLINE_FILE_PREFIX)) continue;
			let prefixEnd = 0;
			while (prefixEnd < legacyLine.length && legacyLine[prefixEnd] === LEGACY_HASHLINE_FILE_PREFIX) {
				prefixEnd++;
			}
			body = legacyLine.slice(prefixEnd);
		}
		const path = normalizeHashlineHeaderPath(body);
		if (path) paths.push(path);
	}
	return paths;
}

/** Adds derived compatibility fields to tool event input without changing tool execution parameters. */
export function normalizeToolEventInput(toolName: string, input: ToolEventInput): ToolEventInput {
	if (toolName !== "edit" || stringField(input, "path") !== undefined) return input;

	// Hashline edit mode: the only authoritative target list is the parsed
	// `[PATH#TAG]` (or legacy `¶PATH#TAG`) headers inside the patch.
	// Trusting a passthrough `_path` here would let a model-supplied field
	// override the real edit target and bypass extension path allowlists.
	const rawInput = stringField(input, "input") ?? stringField(input, "_input");
	if (rawInput !== undefined) {
		const hashlinePaths = extractHashlinePaths(rawInput);
		if (hashlinePaths.length === 0) return input;
		return hashlinePaths.length === 1
			? Object.assign({}, input, { path: hashlinePaths[0], paths: hashlinePaths })
			: Object.assign({}, input, { paths: hashlinePaths });
	}

	// Replace/patch modes: `path` is the real parameter; some hosts forward
	// it as `_path` after schema normalization, so propagate it for gates.
	const directPath = stringField(input, "_path");
	return directPath === undefined ? input : Object.assign({}, input, { path: directPath });
}

/** The tool's own parsed targets, or `undefined` when its parser could not name them. */
function parsedMutationPaths(tool: ToolEventInputResolver, input: ToolEventInput): readonly string[] {
	try {
		return tool.mutationPaths?.(input) ?? [];
	} catch {
		// A payload the parser rejects names no target; `[]` reports absence below.
		return [];
	}
}

/**
 * Add the parser-derived mutation-target contract to an extension event input.
 *
 * `plannedMutationPaths` is attached only when the tool named at least one
 * filesystem target. An empty list would assert that the call writes nothing,
 * and every empty case here means the opposite — the parser could not tell
 * (device URL, unparsable payload, whole-tree scope), so a gate must keep
 * using its own bookkeeping.
 */
export function normalizeToolEventInputForTool(
	tool: ToolEventInputResolver,
	input: ToolEventInput,
	cwd: string,
): ToolEventInput {
	const normalized = normalizeToolEventInput(tool.name, input);
	if (!Object.hasOwn(MUTATING_TOOL_NAMES, tool.name)) return normalized;
	const planned = normalizeMutationPaths(parsedMutationPaths(tool, normalized), cwd);
	if (planned.length === 0) return normalized;
	return Object.assign({}, normalized, { plannedMutationPaths: planned });
}
