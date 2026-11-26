import * as url from "node:url";
import { isVideoPath } from "../../../utils/video-preview";

/** Live composer state the TSP layout shows; the interactive host wires {@link CustomEditor.composerState}. */
export interface ComposerNativeState {
	/**
	 * The draft runs as a shell command (`!`, `!!`), Python (`$`, `$$`) or a `/btw` side question (`?`);
	 * `excluded` keeps it from the model. Role `omp.editor.<kind>`, except btw's `omp.editor.btw-ask`
	 * (`omp.editor.btw` is the focused note's).
	 */
	readonly shell?: {
		readonly kind: "bash" | "python" | "btw";
		readonly excluded: boolean;
	};
	/** Thinking effort word (`high`, `off`, `auto`); undefined when the model has no thinking. */
	readonly thinking?: string;
	/** The thinking level draws as the model chip's icon instead of its own chip (where the terminal has `effort`). */
	readonly thinkingInModel?: boolean;
	/** Generation tok/s after the thinking level (live while running, else the last reading); undefined hides it. */
	readonly rate?: number;
	/** A turn is running: the send keycap becomes a Stop button. */
	readonly running: boolean;
	/** Native dictation control; undefined hides it for hosts without speech-to-text. */
	readonly dictation?: "idle" | "starting" | "recording" | "transcribing";
	/** The viewed subagent's lineage, outermost first and the viewed agent last; undefined on the main session. */
	readonly viewing?: readonly string[];
	/** Drafts go to the `/btw` note the user clicked, as its follow-ups: role `omp.editor.btw`, a `btw` chip. */
	readonly btw?: boolean;
	/**
	 * An ask waits inline above the composer (Tern). `pending`: the placeholder says typing here skips it, and
	 * the composer folds to its compact row while the keys are away from it. `skip`: sending the draft skips
	 * the ask, so a `skips ask` chip leads the input and send reads Skip & send.
	 */
	readonly ask?: "pending" | "skip";
	/** The session's title, quoted in italics as the TSP placeholder; undefined until it has one. */
	readonly title?: string;
}

const BRACKETED_IMAGE_PATH_REGEX = /\.(?:png|jpe?g|gif|webp)$/i;

const SHELL_ESCAPED_PATH_CHAR_REGEX = /\\([\\\s'"()[\]{}&;<>|?*!$`])/g;

const URI_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;

const FILE_URI_REGEX = /^file:\/\//i;

/**
 * Alternation of the filesystem prefixes that make a path unambiguously
 * absolute (POSIX root, home, `file://`, UNC, Windows drive). Shared by
 * {@link ABSOLUTE_PATH_PREFIX_REGEX} and {@link INTERIOR_PATH_ANCHOR_REGEX} so
 * the leading-anchor test and the second-anchor test can never disagree about
 * what counts as the start of a path.
 */
const ABSOLUTE_PATH_PREFIX_SOURCE = String.raw`(?:\/|~\/|file:\/\/|\\\\|[A-Za-z]:[\\/])`;

/**
 * Whole-string anchor for paths that are unambiguously absolute. Restricts the
 * "treat the entire text as one path" pass of {@link extractWholeTextAttachmentPath}
 * to inputs that start with a clearly-anchored filesystem prefix, so prose
 * containing a path-shaped fragment (e.g. "see /tmp/x.png") never hijacks the
 * smart fallback.
 */
const ABSOLUTE_PATH_PREFIX_REGEX = new RegExp(`^${ABSOLUTE_PATH_PREFIX_SOURCE}`);

/**
 * A second path anchor after *unescaped* whitespace — the signature of a
 * multi-path payload (`/tmp/a.png /tmp/b shot.png`, `/tmp/a.png ./b shot.png`)
 * rather than of one path whose name merely contains spaces. Anchors are the
 * absolute prefixes plus dot-relative starts (`./`, `../`, `.\`), which never
 * begin a component of a single sane path. Bare relatives (`dir/b shot.png`)
 * are deliberately NOT anchors: an interior `token/` after a space is exactly
 * the shape of a single path with a spaced directory name
 * (`/Users/me/My Photos/shot 1.png`), which this fallback exists to recover.
 * Escaped whitespace (`/tmp/My\ Photos/x.png`) is exempt: the escape is the
 * terminal asserting the space belongs to the path.
 */
const INTERIOR_PATH_ANCHOR_REGEX = new RegExp(String.raw`(?<!\\)\s(?:${ABSOLUTE_PATH_PREFIX_SOURCE}|\.\.?[\\/])`);

function isPastedPathSeparator(char: string | undefined): boolean {
	return char === undefined || char === " " || char === "\t" || char === "\r" || char === "\n";
}

function normalizePastedPath(path: string): string {
	const trimmed = path.trim();
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	const unquoted =
		trimmed.length > 1 && (first === '"' || first === "'") && last === first ? trimmed.slice(1, -1) : trimmed;
	// `file://` URL → local filesystem path. Mirrors Codex's
	// `normalize_pasted_path` (codex-rs/tui/src/clipboard_paste.rs) so a
	// pasteboard whose text representation is a `file:///Users/…/img.png`
	// URL — common when terminals forward the macOS pasteboard's
	// `public.file-url` representation — loads as the file itself rather
	// than failing in `loadImageInput` with a literal-`file://` path.
	if (FILE_URI_REGEX.test(unquoted)) {
		try {
			return url.fileURLToPath(unquoted);
		} catch {
			// Windows rejects drive-less URLs (`file:///Users/…`, forwarded from a
			// macOS pasteboard or a remote session); decode them as POSIX paths.
			try {
				return url.fileURLToPath(unquoted, { windows: false });
			} catch {
				// Malformed file URL: drop through to the shell-unescape branch
				// so the caller can still reject it as a non-explicit path.
			}
		}
	}
	return (unquoted.startsWith("\\~/") ? unquoted.slice(1) : unquoted).replace(SHELL_ESCAPED_PATH_CHAR_REGEX, "$1");
}

function isExplicitPastedPath(path: string): boolean {
	if (ABSOLUTE_PATH_PREFIX_REGEX.test(path) || /^\.\.?[\\/]/.test(path)) return true;
	if (URI_SCHEME_REGEX.test(path)) return false;
	return path.includes("\\");
}

/** A pasted local image or video can become a vision-ready image attachment. */
function isPreviewableAttachmentPath(path: string): boolean {
	return BRACKETED_IMAGE_PATH_REGEX.test(path) || isVideoPath(path);
}

function splitPastedPathSegments(payload: string): string[] | undefined {
	const segments: string[] = [];
	let segment = "";
	let quote: string | undefined;
	let escaped = false;

	for (let i = 0; i < payload.length; i++) {
		const char = payload[i];
		if (escaped) {
			segment += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			segment += char;
			escaped = true;
			continue;
		}
		if (quote) {
			segment += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			segment += char;
			quote = char;
			continue;
		}
		if (isPastedPathSeparator(char)) {
			if (segment) {
				segments.push(segment);
				segment = "";
			}
			continue;
		}
		segment += char;
	}

	if (escaped || quote) return undefined;
	if (segment) segments.push(segment);
	return segments.length > 0 ? segments : undefined;
}

/**
 * Extract whitespace/quoted-separated path-like segments from `payload`.
 * Shared backend of {@link extractBracketedPastePaths} and {@link extractPastePathsFromText}.
 * Returns the segments only when EVERY segment looks like an anchored local
 * path or uses Windows separators; otherwise undefined so ambiguous relative
 * URL/path text falls back to a plain text paste.
 */
function extractExplicitPathSegments(payload: string): string[] | undefined {
	const pasted = payload.trim();
	if (!pasted) return undefined;

	const segments = splitPastedPathSegments(pasted);
	if (!segments) return undefined;

	const paths: string[] = [];
	for (const segment of segments) {
		const path = normalizePastedPath(segment);
		if (!path || !isExplicitPastedPath(path)) return undefined;
		paths.push(path);
	}
	return paths;
}

/**
 * Extract image-or-other file paths from plain (un-bracketed) clipboard text.
 * Mirrors {@link extractBracketedPastePaths} for terminals/handlers that
 * already stripped the `\x1b[200~`…`\x1b[201~` markers (e.g. clipboard text
 * read directly via `pbpaste`/PowerShell).
 */
export function extractPastePathsFromText(text: string): string[] | undefined {
	return extractExplicitPathSegments(text);
}

/**
 * Attachment paths in a pasted payload (markers already stripped): every segment an explicit
 * image or video path, else the whole text as one such path (a dropped macOS screenshot whose
 * name has unescaped spaces, #6578). Undefined for any other paste.
 */
export function extractImagePastePathsFromText(text: string): string[] | undefined {
	const paths = extractPastePathsFromText(text);
	if (paths !== undefined) return paths.every(isPreviewableAttachmentPath) ? paths : undefined;
	const wholePath = extractWholeTextAttachmentPath(text);
	return wholePath ? [wholePath] : undefined;
}

/**
 * Whole-text-as-path pass shared by {@link extractImagePastePathsFromText}
 * and {@link extractImagePathFromText}: treat the entire text as one path
 * when it is anchored by {@link ABSOLUTE_PATH_PREFIX_REGEX}, contains no
 * newlines, and points at a vision-previewable image or video extension. Recovers single paths
 * whose unescaped spaces defeat the segment splitter (macOS screenshot names).
 *
 * Refuses payloads carrying a second {@link INTERIOR_PATH_ANCHOR_REGEX} anchor.
 * Dragging two files at once emits `/tmp/a.png /tmp/b shot.png`, which the
 * splitter also refuses (`shot.png` is not explicit); swallowing it as one path
 * attaches nothing, and `handleImagePathPaste`'s ENOENT branch only surfaces a
 * status — unlike its other failure branches it never re-pastes the text — so
 * both paths would vanish. Genuinely ambiguous input lands here too (a
 * directory whose name ends in a space, as in `/tmp/odd dir /sub/x.png`); a
 * plain text paste is the losing-nothing outcome, so ambiguity resolves that way.
 */
function extractWholeTextAttachmentPath(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed || /[\r\n]/.test(trimmed) || !ABSOLUTE_PATH_PREFIX_REGEX.test(trimmed)) return undefined;
	if (INTERIOR_PATH_ANCHOR_REGEX.test(trimmed)) return undefined;
	const wholePath = normalizePastedPath(trimmed);
	return wholePath && isExplicitPastedPath(wholePath) && isPreviewableAttachmentPath(wholePath)
		? wholePath
		: undefined;
}

/**
 * Return a single previewable file path when `text` is exactly one explicit
 * image (`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`) or video path. Used by the
 * keybind-driven clipboard image paste path so a
 * clipboard whose only payload is an image file (e.g. Finder `Cmd+C` on
 * macOS) attaches the image instead of pasting the path as literal text.
 *
 * Two-stage detection:
 *
 * 1. Splitter pass (shared with the bracketed-paste handler) — handles
 *    quoted paths, shell-escaped spaces, and unambiguous single tokens.
 *    Returns the single previewable path when it parses cleanly; explicitly
 *    returns `undefined` when the splitter found multiple segments (so
 *    ambiguous multi-path clipboard text like `/tmp/a.png /tmp/b.png`
 *    still falls through to the text fallback instead of being mis-loaded
 *    as one giant path).
 * 2. {@link extractWholeTextAttachmentPath} — only reached when the splitter
 *    failed (every segment must look like an explicit path; an unescaped
 *    space in a real path breaks that). This is what recovers macOS
 *    screenshot filenames like
 *    `/Users/me/Desktop/Screenshot 2026-06-25 at 1.23.45 PM.png`.
 */
export function extractImagePathFromText(text: string): string | undefined {
	const paths = extractPastePathsFromText(text);
	if (paths?.length === 1 && isPreviewableAttachmentPath(paths[0])) return paths[0];
	if (paths !== undefined) return undefined;
	return extractWholeTextAttachmentPath(text);
}
