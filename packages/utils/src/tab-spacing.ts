/**
 * Default tab width (display / tab expansion) and per-file width from `.editorconfig`.
 * Mirrors former `pi-natives` `indent` + `text` default-tab-width behavior (no N-API).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isFsError } from "./fs-error";

export const MIN_TAB_WIDTH = 1;
export const MAX_TAB_WIDTH = 16;
export const DEFAULT_TAB_WIDTH = 3;

/**
 * Per-component path length cap on common filesystems (`NAME_MAX = 255` on
 * Linux ext4 / macOS APFS / Windows NTFS). Paths with components longer than
 * this cannot be opened at all, so editorconfig discovery short-circuits to
 * the default instead of running into `ENAMETOOLONG` from `readFileSync`.
 */
const NAME_MAX_BYTES = 255;

const EDITORCONFIG_NAME = ".editorconfig";

const editorConfigCache = new Map<string, ParsedEditorConfig | null>();
const editorConfigChainCache = new Map<string, ChainEntry[]>();

interface EditorConfigSection {
	pattern: string;
	properties: Map<string, string>;
}

interface ParsedEditorConfig {
	root: boolean;
	sections: EditorConfigSection[];
}

interface ChainEntry {
	dir: string;
	parsed: ParsedEditorConfig;
}

const enum IndentStyle {
	Space,
	Tab,
}

type IndentSize = { kind: "spaces"; n: number } | { kind: "tab" };

interface EditorConfigMatch {
	indentStyle?: IndentStyle;
	indentSize?: IndentSize;
	tabWidth?: number;
}

function clampTabWidth(value: number): number {
	return Math.min(MAX_TAB_WIDTH, Math.max(MIN_TAB_WIDTH, Math.trunc(value)));
}

function parsePositiveInteger(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw)) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (parsed === 0) return undefined;
	return clampTabWidth(parsed);
}

function fixUnclosedBraces(pattern: string): string {
	const opens = [...pattern].filter(c => c === "{").length;
	const closes = [...pattern].filter(c => c === "}").length;
	if (opens > closes) {
		return pattern + "}".repeat(opens - closes);
	}
	return pattern;
}

/** Match `crates/pi-natives/src/glob_util.rs` `build_glob_pattern`. */
function buildGlobPattern(globStr: string, recursive: boolean): string {
	const normalized = globStr.replace(/\\/g, "/");
	const pattern =
		!recursive || normalized.includes("/") || normalized.startsWith("**") ? normalized : `**/${normalized}`;
	return fixUnclosedBraces(pattern);
}

function globMatches(pattern: string, relativePath: string): boolean {
	try {
		const g = new Bun.Glob(pattern);
		return g.match(relativePath);
	} catch {
		return false;
	}
}

function matchesEditorConfigPattern(pattern: string, relativePath: string): boolean {
	const normalized = pattern.replace(/^\/+/, "");
	if (!normalized) {
		return false;
	}

	const candidates = normalized.includes("/")
		? [buildGlobPattern(normalized, false)]
		: [buildGlobPattern(normalized, false), buildGlobPattern(normalized, true)];

	for (const p of candidates) {
		if (globMatches(p, relativePath)) {
			return true;
		}
	}
	return false;
}

function parseEditorConfigFile(content: string): ParsedEditorConfig {
	const parsed: ParsedEditorConfig = { root: false, sections: [] };
	let currentSectionIdx: number | undefined;

	for (const rawLine of content.split(/\n/)) {
		const line = rawLine.trim();
		if (line === "") continue;
		if (line.startsWith("#") || line.startsWith(";")) continue;

		if (line.startsWith("[") && line.endsWith("]") && line.length >= 2) {
			const secPattern = line.slice(1, -1).trim();
			if (secPattern === "") {
				currentSectionIdx = undefined;
				continue;
			}
			parsed.sections.push({ pattern: secPattern, properties: new Map() });
			currentSectionIdx = parsed.sections.length - 1;
			continue;
		}

		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim().toLowerCase();
		const value = line
			.slice(eq + 1)
			.trim()
			.toLowerCase();
		if (key === "") continue;

		if (currentSectionIdx !== undefined) {
			parsed.sections[currentSectionIdx]!.properties.set(key, value);
		} else if (key === "root") {
			parsed.root = value === "true";
		}
	}

	return parsed;
}

function parseCachedEditorConfig(configPath: string): ParsedEditorConfig | undefined {
	const key = path.resolve(configPath);
	const hit = editorConfigCache.get(key);
	if (hit !== undefined) {
		return hit ?? undefined;
	}

	let content: string;
	try {
		content = fs.readFileSync(key, "utf8");
	} catch (err) {
		// editorconfig discovery is best-effort. Any filesystem error
		// (`ENOENT`, `ENAMETOOLONG`, `ENOTDIR`, `EACCES`, `ELOOP`, `EINVAL`,
		// …) means "no usable config at this path" — never a fatal condition
		// for callers like the edit renderer that hand us arbitrary strings.
		if (isFsError(err)) return undefined;
		throw err;
	}
	const parsed = parseEditorConfigFile(content);
	editorConfigCache.set(key, parsed);
	return parsed;
}

function resolveFilePath(projectDir: string, file: string): string {
	if (path.isAbsolute(file)) {
		return path.normalize(path.resolve(file));
	}
	return path.normalize(path.resolve(projectDir, file));
}

/** Like `pathdiff::diff_paths` + forward slashes (see `indent.rs`). */
function relativePathUnified(baseDir: string, absoluteFile: string): string {
	const base = path.resolve(baseDir);
	const file = path.resolve(absoluteFile);
	const rel = path.relative(base, file);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return ".";
	}
	return rel.replace(/\\/g, "/");
}

function collectEditorConfigChain(startDir: string): ChainEntry[] {
	const key = path.resolve(startDir);
	const cached = editorConfigChainCache.get(key);
	if (cached !== undefined) {
		return cached;
	}

	const chain: ChainEntry[] = [];
	let cursor = key;
	for (;;) {
		const configPath = path.join(cursor, EDITORCONFIG_NAME);
		const parsed = parseCachedEditorConfig(configPath);
		if (parsed !== undefined) {
			chain.push({ dir: cursor, parsed });
			if (parsed.root) {
				break;
			}
		}

		const parent = path.dirname(cursor);
		if (parent === cursor) {
			break;
		}
		cursor = parent;
	}

	chain.reverse();
	editorConfigChainCache.set(key, chain);
	return chain;
}

function resolveEditorConfigMatch(absoluteFile: string): EditorConfigMatch | undefined {
	const fileDir = path.dirname(absoluteFile);
	const chain = collectEditorConfigChain(fileDir);
	if (chain.length === 0) {
		return undefined;
	}

	const match: EditorConfigMatch = {};
	for (const { dir, parsed } of chain) {
		const relativePath = relativePathUnified(dir, absoluteFile);
		for (const section of parsed.sections) {
			if (!matchesEditorConfigPattern(section.pattern, relativePath)) {
				continue;
			}

			const style = section.properties.get("indent_style");
			if (style === "space") {
				match.indentStyle = IndentStyle.Space;
			} else if (style === "tab") {
				match.indentStyle = IndentStyle.Tab;
			}

			const rawSize = section.properties.get("indent_size");
			if (rawSize === "tab") {
				match.indentSize = { kind: "tab" };
			} else if (rawSize !== undefined) {
				const n = parsePositiveInteger(rawSize);
				if (n !== undefined) {
					match.indentSize = { kind: "spaces", n };
				}
			}

			const tw = parsePositiveInteger(section.properties.get("tab_width"));
			if (tw !== undefined) {
				match.tabWidth = tw;
			}
		}
	}

	if (match.indentStyle === undefined && match.indentSize === undefined && match.tabWidth === undefined) {
		return undefined;
	}
	return match;
}

function hasOverlongPathComponent(filePath: string): boolean {
	for (const part of filePath.split(/[\\/]/)) {
		if (part.length > 0 && Buffer.byteLength(part) > NAME_MAX_BYTES) {
			return true;
		}
	}
	return false;
}

/**
 * `.editorconfig`-derived formatting options for an LSP `textDocument/formatting` request.
 *
 * Both fields are absent when the resolved `.editorconfig` chain does not pin them, so callers
 * can layer their own fallbacks (content sniffing, project defaults) underneath. Returned values
 * are clamped to {@link MIN_TAB_WIDTH}..{@link MAX_TAB_WIDTH}.
 */
export interface EditorConfigFormatting {
	/** Effective indent width in columns, from `indent_size` or `tab_width`. */
	tabSize?: number;
	/** `true` for `indent_style = space`, `false` for `indent_style = tab` (or `indent_size = tab`). */
	insertSpaces?: boolean;
}

/**
 * Resolve `.editorconfig` formatting hints for `file` without falling back to any default.
 *
 * Used by the LSP format-on-write path so a missing `.editorconfig` declaration falls through
 * to caller-provided defaults instead of clobbering the file with the renderer's
 * display tab width (issue #2329).
 */
export function getEditorConfigFormatting(file?: string | null, projectDir?: string | null): EditorConfigFormatting {
	if (file === undefined || file === null || file === "") {
		return {};
	}

	const cwd = projectDir ?? process.cwd();
	const absoluteFile = resolveFilePath(cwd, file);

	// NAME_MAX guard: editorconfig discovery is
	// best-effort and must never escape as `ENAMETOOLONG` from a renderer's
	// stray gibberish path.
	if (hasOverlongPathComponent(absoluteFile)) {
		return {};
	}

	const match = resolveEditorConfigMatch(absoluteFile);
	if (match === undefined) {
		return {};
	}

	const result: EditorConfigFormatting = {};

	if (match.indentSize?.kind === "spaces") {
		result.tabSize = clampTabWidth(match.indentSize.n);
	} else if (match.tabWidth !== undefined) {
		result.tabSize = clampTabWidth(match.tabWidth);
	}

	if (match.indentStyle === IndentStyle.Space) {
		result.insertSpaces = true;
	} else if (match.indentStyle === IndentStyle.Tab || match.indentSize?.kind === "tab") {
		result.insertSpaces = false;
	} else if (match.indentSize?.kind === "spaces") {
		// `indent_size = <n>` without an explicit `indent_style` is universally
		// read as "indent with N spaces" — both VSCode and Sublime infer
		// `indent_style = space` in that case.
		result.insertSpaces = true;
	}

	return result;
}
