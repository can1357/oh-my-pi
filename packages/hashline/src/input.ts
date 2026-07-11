/**
 * Top-level patch parser. Splits an authored hashline input into a list of
 * {@link PatchSection}s, each rooted at a `[PATH#HASH]` header, then exposes
 * a {@link Patch} class that gives lazy access to the parsed edits per
 * section.
 *
 * The splitter is purely lexical — it doesn't know whether a section's path
 * actually exists. That's the patcher's job.
 */
import * as path from "node:path";
import { applyEdits } from "./apply";
import { resolveBlockEdits } from "./block";
import { HL_FILE_HASH_EXAMPLES, HL_FILE_HASH_LENGTH, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "./format";
import { parsePatch, parsePatchStreaming } from "./parser";
import { Tokenizer } from "./tokenizer";
import type { ApplyResult, BlockResolver, Edit, FileOp, SplitOptions } from "./types";

// Pure classification — single shared tokenizer is safe.
const TOKENIZER = new Tokenizer();

function unquoteHashlinePath(pathText: string): string {
	if (pathText.length < 2) return pathText;
	const first = pathText[0];
	const last = pathText[pathText.length - 1];
	if ((first === '"' || first === "'") && first === last) return pathText.slice(1, -1);
	return pathText;
}

/**
 * Strip apply_patch-style noise that models reflexively prepend to the
 * path. Examples observed in benchmark traces:
 *
 *   `Update File:foo.ts`, `Update:foo.ts`, `UpdateFile:foo.ts`,
 *   `Update/File:foo.ts`, `Update-file:foo.ts`, `Update(File):foo.ts`,
 *   `Update<File:foo.ts`, `Add File:foo.ts`, `Delete File:foo.ts`,
 *   `Move to:foo.ts`, `***foo.ts`, `***Update File:foo.ts`.
 *
 * We strip a leading `***` (the model duplicating the header sigil) and a
 * leading `(Update|Add|Delete|Move)[<separator>]*(File|to)?[<separator>]*:`
 * keyword block, case-insensitive. The remaining text is the real path.
 */
const APPLY_PATCH_PATH_NOISE_RE =
	/^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i;

function stripApplyPatchPathNoise(pathText: string): string {
	return pathText.replace(APPLY_PATCH_PATH_NOISE_RE, "");
}

/**
 * Best-effort recovery for bracketed header lines the strict tokenizer
 * rejects. Strips apply_patch keyword noise (`Update File:`, `Update:`,
 * etc.) and an extra leading `***` (some models emit a hybrid
 * `[***foo.ts#HASH]` shape), then expects `PATH(#HASH)?`.
 * Returns `null` when no clean path can be salvaged.
 */
function tryParseRecoveryHeader(line: string, cwd?: string): RawSection | null {
	if (!line.startsWith(HL_FILE_PREFIX) || !line.endsWith(HL_FILE_SUFFIX)) return null;
	const body = stripApplyPatchPathNoise(line.slice(HL_FILE_PREFIX.length, line.length - HL_FILE_SUFFIX.length).trim());
	if (body.length === 0) return null;

	// Trailing `#XXXX` is the tag; everything before it is the path. The
	// path may contain whitespace (Windows OneDrive folders, Program Files,
	// etc.), so we anchor the tag at end-of-body rather than scanning
	// forward and stopping at the first space.
	const trailing = new RegExp(`#([0-9A-Fa-f]{${HL_FILE_HASH_LENGTH}})\\s*$`).exec(body);
	let pathText: string;
	let fileHash: string | undefined;
	if (trailing !== null) {
		pathText = body.slice(0, trailing.index);
		fileHash = trailing[1].toUpperCase();
	} else {
		pathText = body.replace(/\s+$/, "");
	}

	// Same rule as the strict tokenizer: the hashline header grammar uses
	// `#` as the path/tag separator and does not allow `#` inside
	// filenames. Anything `#` left in the path body — short tags, non-hex
	// tags, over-long tags, stale-tag copy-paste, line-suffixed tags —
	// means the header is malformed, not a path with an embedded hash.
	if (pathText.includes("#")) return null;

	const path = normalizeHashlinePath(pathText, cwd);
	if (path.length === 0) return null;
	return fileHash !== undefined ? { path, fileHash, diff: "" } : { path, diff: "" };
}

function normalizeHashlinePath(rawPath: string, cwd?: string): string {
	const unquoted = stripApplyPatchPathNoise(unquoteHashlinePath(rawPath.trim()));
	if (!cwd || !path.isAbsolute(unquoted)) return unquoted;
	const relative = path.relative(path.resolve(cwd), path.resolve(unquoted));
	const normalizedRelative = relative.split(path.sep).join("/");
	const isWithinCwd = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	return isWithinCwd ? normalizedRelative || "." : unquoted;
}

interface RawSection {
	path: string;
	fileHash?: string;
	diff: string;
}

/**
 * Parse a `[PATH]` or `[PATH#hash]` header line. Returns `null` for lines that do
 * not start with `[`. Throws the strict "Input header must be …" error
 * when a bracketed line fails the strict shape (so malformed paths
 * surface immediately instead of being silently re-classified as payload).
 */
function parseHashlineHeaderLine(line: string, cwd?: string): RawSection | null {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith(HL_FILE_PREFIX)) return null;

	const token = TOKENIZER.tokenize(trimmed);
	if (token.kind !== "header") {
		// Recovery: try to extract a path from the raw line after stripping
		// apply_patch noise. This handles `[*** Update File:foo.ts#CB5A]` and
		// the half-dozen variants models actually emit.
		const recovered = tryParseRecoveryHeader(trimmed, cwd);
		if (recovered !== null) return recovered;
		throw new Error(
			`Input header must be ${HL_FILE_PREFIX}PATH${HL_FILE_SUFFIX} or ${HL_FILE_PREFIX}PATH${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX} with a ${HL_FILE_HASH_LENGTH}-hex content-hash tag; got ${JSON.stringify(trimmed)}.`,
		);
	}

	const parsedPath = normalizeHashlinePath(token.path, cwd);
	if (parsedPath.length === 0) {
		throw new Error(`Input header "${HL_FILE_PREFIX}${HL_FILE_SUFFIX}" is empty; provide a file path.`);
	}
	return token.fileHash !== undefined
		? { path: parsedPath, fileHash: token.fileHash, diff: "" }
		: { path: parsedPath, diff: "" };
}

function stripLeadingBlankLines(input: string): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const lines = stripped.split("\n");
	while (lines.length > 0) {
		const head = lines[0].replace(/\r$/, "");
		if (head.trim().length === 0 || TOKENIZER.tokenize(head).kind === "envelope-begin") {
			lines.shift();
			continue;
		}
		break;
	}
	return lines.join("\n");
}

/**
 * Returns true when the input contains at least one line that the tokenizer
 * recognizes as a hashline op. Used by streaming previews to decide whether
 * the partial input is worth treating as a hashline patch yet.
 */
export function containsRecognizableHashlineOperations(input: string): boolean {
	for (const line of input.split(/\r?\n/)) {
		if (TOKENIZER.isOp(line)) return true;
	}
	return false;
}

function normalizeFallbackInput(input: string, options: SplitOptions): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const hasExplicitHeader = stripped
		.split(/\r?\n/)
		.some(rawLine => parseHashlineHeaderLine(rawLine, options.cwd) !== null);
	if (hasExplicitHeader) return input;

	if (!options.path || !containsRecognizableHashlineOperations(input)) return input;
	const fallbackPath = normalizeHashlinePath(options.path, options.cwd);
	if (fallbackPath.length === 0) return input;
	return `${HL_FILE_PREFIX}${fallbackPath}${HL_FILE_SUFFIX}\n${input}`;
}

function splitRawSections(input: string, options: SplitOptions = {}): RawSection[] {
	const stripped = stripLeadingBlankLines(normalizeFallbackInput(input, options));
	const lines = stripped.split(/\r?\n/);
	const firstLine = lines[0] ?? "";

	if (parseHashlineHeaderLine(firstLine, options.cwd) === null) {
		// Catch unified-diff hunk-header contamination on the first line so
		// the model sees a focused error.
		const firstTrimmed = firstLine.trimEnd();
		if (/^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/.test(firstTrimmed)) {
			throw new Error(
				"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. " +
					`File sections start with \`${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}HASH${HL_FILE_SUFFIX}\`; use \`replace\`, \`delete\`, or \`insert\` ops.`,
			);
		}
		const preview = JSON.stringify(firstLine.slice(0, 120));
		throw new Error(
			`input must begin with "${HL_FILE_PREFIX}PATH${HL_FILE_HASH_SEP}HASH${HL_FILE_SUFFIX}" on the first non-blank line for anchored edits; got: ${preview}. ` +
				`Example: "${HL_FILE_PREFIX}src/foo.ts${HL_FILE_HASH_SEP}${HL_FILE_HASH_EXAMPLES[0]}${HL_FILE_SUFFIX}" then edit ops.`,
		);
	}

	const sections: RawSection[] = [];
	let current: RawSection | undefined;
	let currentLines: string[] = [];

	const flush = () => {
		if (!current) return;
		const hasOps = currentLines.some(line => line.trim().length > 0);
		if (hasOps) sections.push({ ...current, diff: currentLines.join("\n") });
		currentLines = [];
	};

	for (const line of lines) {
		const trimmed = line.trimEnd();
		const token = TOKENIZER.tokenize(line);
		if (token.kind === "envelope-end" || token.kind === "abort") break;
		if (token.kind === "envelope-begin") continue;

		// Route every bracket-prefixed line through parseHashlineHeaderLine so
		// malformed headers still raise the strict "Input header must be …"
		// diagnostic (the tokenizer alone would silently classify them as
		// payload).
		if (trimmed.startsWith(HL_FILE_PREFIX)) {
			const header = parseHashlineHeaderLine(line, options.cwd);
			if (header !== null) {
				flush();
				current = header;
				currentLines = [];
				continue;
			}
		}
		currentLines.push(line);
	}
	flush();
	return sections;
}

/**
 * Snapshot of one section in a parsed {@link Patch}: a target file plus the
 * lazily-parsed list of edits that should land on it. Constructed by
 * {@link Patch.parse}; consumers usually iterate `patch.sections` rather
 * than build these directly.
 */
export class PatchSection {
	readonly path: string;
	readonly fileHash: string | undefined;
	readonly diff: string;
	#parsed: { edits: Edit[]; fileOp?: FileOp; warnings: string[] } | undefined;

	constructor(raw: RawSection) {
		this.path = raw.path;
		this.fileHash = raw.fileHash;
		this.diff = raw.diff;
	}

	/**
	 * Parse this section's diff body. Cached: subsequent calls return the
	 * same `{ edits, fileOp?, warnings }` object so callers can safely call this from
	 * multiple paths (preflight, apply, diff-preview).
	 */
	parse(): { edits: Edit[]; fileOp?: FileOp; warnings: readonly string[] } {
		this.#parsed ??= parsePatch(this.diff);
		const parsed = this.#parsed;
		const fileOp =
			parsed.fileOp === undefined
				? undefined
				: parsed.fileOp.kind === "move"
					? { kind: "move" as const, dest: normalizeHashlinePath(parsed.fileOp.dest) }
					: parsed.fileOp;
		return fileOp === parsed.fileOp
			? parsed
			: { edits: parsed.edits, ...(fileOp === undefined ? {} : { fileOp }), warnings: parsed.warnings };
	}

	/** Parsed edits for this section. */
	get edits(): readonly Edit[] {
		return this.parse().edits;
	}

	/** Optional whole-file operation (`REM` / `MV`). */
	get fileOp(): FileOp | undefined {
		return this.parse().fileOp;
	}

	/** Warnings emitted during parsing of this section. */
	get warnings(): readonly string[] {
		return this.parse().warnings;
	}

	/**
	 * True when at least one edit anchors to concrete file content. Pure
	 * `insert head:` / `insert tail:` literal inserts do not count: those are
	 * safe to apply to files that don't yet exist.
	 */
	get hasAnchorScopedEdit(): boolean {
		return this.edits.some(edit => {
			if (edit.kind === "delete") return true;
			// A `replace_block N:` edit is anchored to concrete content on line N.
			if (edit.kind === "block") return true;
			return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
		});
	}

	/** Anchor lines touched by this section, sorted ascending and deduplicated. */
	collectAnchorLines(): readonly number[] {
		const lines = new Set<number>();
		for (const edit of this.edits) {
			if (edit.kind === "delete") {
				lines.add(edit.anchor.line);
				continue;
			}
			if (edit.kind === "block") {
				lines.add(edit.anchor.line);
				continue;
			}
			if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") {
				lines.add(edit.cursor.anchor.line);
			}
		}
		return [...lines].sort((a, b) => a - b);
	}

	/**
	 * Apply this section's edits to `text` and return the post-edit result.
	 * Pure: does no I/O, does not validate the section snapshot tag. The
	 * {@link Patcher} owns tag validation and recovery; reach for this
	 * method directly when you've already validated the file content and
	 * just want the result.
	 *
	 * `blockResolver` resolves any `replace_block N:` edits against `text`; an
	 * unresolvable block throws (this is the final, authoritative preview path).
	 */
	applyTo(text: string, blockResolver?: BlockResolver): ApplyResult {
		const { edits, warnings } = this.parse();
		const resolveWarnings: string[] = [];
		const resolved = resolveBlockEdits(edits, text, this.path, blockResolver, {
			onUnresolved: "throw",
			onWarning: warning => resolveWarnings.push(warning),
		});
		const result = applyEdits(text, resolved);
		// Preserve parse warnings so consumers don't need to call `parse()`
		// separately.
		const merged = [...warnings, ...resolveWarnings, ...(result.warnings ?? [])];
		return merged.length > 0
			? { ...result, warnings: merged }
			: { text: result.text, firstChangedLine: result.firstChangedLine };
	}

	/**
	 * Streaming-tolerant counterpart to {@link applyTo}. Uses
	 * {@link parsePatchStreaming} so a trailing in-flight op (no payload yet,
	 * or a per-token parse error mid-stream) does not throw or emit a phantom
	 * empty-payload edit. Intended for incremental diff previews; the writer
	 * path should always use {@link applyTo}.
	 *
	 * `blockResolver` resolves any `replace_block N:` edits against `text`; an
	 * unresolvable block is silently dropped so a half-written file does not
	 * throw mid-stream.
	 */
	applyPartialTo(text: string, blockResolver?: BlockResolver): ApplyResult {
		const { edits, warnings } = parsePatchStreaming(this.diff);
		const resolveWarnings: string[] = [];
		const resolved = resolveBlockEdits(edits, text, this.path, blockResolver, {
			onUnresolved: "drop",
			onWarning: warning => resolveWarnings.push(warning),
		});
		const result = applyEdits(text, resolved);
		const merged = [...warnings, ...resolveWarnings, ...(result.warnings ?? [])];
		return merged.length > 0
			? { ...result, warnings: merged }
			: { text: result.text, firstChangedLine: result.firstChangedLine };
	}

	/**
	 * A copy of this section rebound to a different target `path`, preserving
	 * the snapshot tag, diff body, and any cached parse result. Used by the
	 * patcher's tag-based path recovery to redirect an edit whose authored
	 * path does not exist onto the file its snapshot tag actually names.
	 */
	withPath(path: string): PatchSection {
		const next = new PatchSection({
			path,
			...(this.fileHash !== undefined ? { fileHash: this.fileHash } : {}),
			diff: this.diff,
		});
		next.#parsed = this.#parsed;
		return next;
	}
}

/**
 * A parsed hashline patch — zero or more {@link PatchSection}s, each rooted
 * at a `[PATH#HASH]` header. Construct via {@link Patch.parse}.
 *
 * `Patch` is pure data: parsing is line-anchored and does not look at the
 * filesystem. To apply a patch, hand it to {@link Patcher.apply}.
 */
export class Patch {
	readonly sections: readonly PatchSection[];

	private constructor(sections: PatchSection[]) {
		this.sections = sections;
	}

	/**
	 * Parse `input` into a {@link Patch}. `options.cwd` resolves absolute
	 * paths inside headers to cwd-relative form; `options.path` provides a
	 * fallback when the input lacks a header but contains hashline ops
	 * (useful for streaming previews).
	 *
	 * Consecutive sections targeting the same path are merged into a single
	 * section with concatenated diff bodies. Anchors authored against the
	 * same file snapshot must be applied as one batch; otherwise the first
	 * sub-edit shifts line numbers out from under the second's anchors and
	 * validation fails.
	 */
	static parse(input: string, options: SplitOptions = {}): Patch {
		const raw = mergeSamePathSections(splitRawSections(input, options));
		return new Patch(raw.map(section => new PatchSection(section)));
	}

	/**
	 * Parse `input` and return only the first section. Throws if the input
	 * has zero sections. Convenience for the single-section case where the
	 * caller already knows the patch is one hunk.
	 */
	static parseSingle(input: string, options: SplitOptions = {}): PatchSection {
		const patch = Patch.parse(input, options);
		const first = patch.sections[0];
		if (!first) throw new Error("Patch input did not produce any sections.");
		return first;
	}
}

/**
 * Collapse consecutive or interleaved sections targeting the same path into a
 * single section with concatenated diffs. Anchors authored against the same
 * file snapshot must be applied as one batch; otherwise the first sub-edit
 * shifts line numbers out from under the second's anchors and validation
 * fails. Path order is preserved by first occurrence.
 */
function mergeSamePathSections(sections: RawSection[]): RawSection[] {
	const byPath = new Map<string, { fileHash?: string; diffs: string[] }>();
	for (const section of sections) {
		const existing = byPath.get(section.path);
		if (existing) {
			if (
				existing.fileHash !== undefined &&
				section.fileHash !== undefined &&
				existing.fileHash !== section.fileHash
			) {
				throw new Error(
					`Conflicting hashline snapshot tags for ${section.path}: #${existing.fileHash} and #${section.fileHash}. Re-read the file and retry with one current header.`,
				);
			}
			if (existing.fileHash === undefined && section.fileHash !== undefined) existing.fileHash = section.fileHash;
			existing.diffs.push(section.diff);
			continue;
		}
		byPath.set(section.path, {
			...(section.fileHash !== undefined ? { fileHash: section.fileHash } : {}),
			diffs: [section.diff],
		});
	}
	return Array.from(byPath, ([sectionPath, entry]) => ({
		path: sectionPath,
		...(entry.fileHash !== undefined ? { fileHash: entry.fileHash } : {}),
		diff: entry.diffs.join("\n"),
	}));
}
