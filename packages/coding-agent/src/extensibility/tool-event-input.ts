import { HL_FILE_PREFIX, HL_FILE_SUFFIX } from "@oh-my-pi/pi-tui/tools/hashline-format";

const LEGACY_HASHLINE_FILE_PREFIX = "¶";
const HASHLINE_FILE_TAG_RE = /#[0-9a-fA-F]{4}$/u;
const WHITE_SPACE_CHAR_RE = /^\p{White_Space}$/u;

interface ToolEventInputResolver {
	name: string;
	resolveEventInput?: (input: string) => string;
}

/** Resolves mode-specific textual tool input before extension/hook event normalization. */
export function resolveToolEventInput(
	tool: ToolEventInputResolver,
	input: Record<string, unknown>,
): Record<string, unknown> {
	if (tool.name !== "edit" || typeof tool.resolveEventInput !== "function") return input;
	let resolved = input;
	for (const key of ["input", "_input"] as const) {
		const value = stringField(resolved, key);
		if (value === undefined) continue;
		const nextValue = tool.resolveEventInput(value);
		if (nextValue === value) continue;
		if (resolved === input) resolved = { ...input };
		resolved[key] = nextValue;
	}
	return resolved;
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
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

/**
 * Strips trailing Unicode White_Space like Rust's `trim_end`, which the patch
 * parser applies to headers (`String.prototype.trimEnd` misses U+0085). Scans
 * backward once: an unanchored `/\p{White_Space}+$/` is quadratic on rows
 * with long interior whitespace runs. Every White_Space code point is in the
 * BMP, so stepping by UTF-16 code unit is exact.
 */
function trimEndWhiteSpace(line: string): string {
	let end = line.length;
	while (end > 0 && WHITE_SPACE_CHAR_RE.test(line[end - 1])) end--;
	return end === line.length ? line : line.slice(0, end);
}

function extractHashlinePaths(input: string): string[] {
	const paths: string[] = [];
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	for (const rawLine of stripped.split("\n")) {
		const line = trimEndWhiteSpace(rawLine);
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
export function normalizeToolEventInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
	if (toolName !== "edit" || stringField(input, "path")) return input;

	// Hashline edit mode: the only authoritative target list is the parsed
	// `[PATH#TAG]` (or legacy `¶PATH#TAG`) headers inside the patch.
	// Trusting a passthrough `_path` here would let a model-supplied field
	// override the real edit target and bypass extension path allowlists.
	const rawInput = stringField(input, "input") ?? stringField(input, "_input");
	if (rawInput !== undefined) {
		const hashlinePaths = extractHashlinePaths(rawInput);
		if (hashlinePaths.length === 0) return input;
		if (hashlinePaths.length === 1) return { ...input, path: hashlinePaths[0], paths: hashlinePaths };
		return { ...input, paths: hashlinePaths };
	}

	// Replace/patch modes: `path` is the real parameter; some hosts forward
	// it as `_path` after schema normalization, so propagate it for gates.
	const directPath = stringField(input, "_path");
	if (directPath) return { ...input, path: directPath };

	return input;
}
