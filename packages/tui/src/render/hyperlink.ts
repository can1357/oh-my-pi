/**
 * OSC 8 terminal hyperlink support for paths and URLs.
 *
 * Wraps display text in `ESC ] 8 ; id=HASH ; URI ESC \ TEXT ESC ] 8 ; ; ESC \`
 * sequences when the active terminal supports hyperlinks and the user setting
 * permits it. Falls back to plain text when disabled.
 */
import * as url from "node:url";
import { setTerminalHyperlinks, TERMINAL, type TerminalId } from "../terminal-capabilities";

const OSC = "\x1b]";
const ST = "\x1b\\";
const BEL = "\x07";

/**
 * The terminal's detected OSC 8 capability, captured once at import before any
 * policy application mutates {@link TERMINAL}.hyperlinks. `auto` resolves against
 * this immutable value so a prior `always`/`off` selection can never poison
 * detection when the user switches back to `auto`.
 */
const DETECTED_TERMINAL_HYPERLINKS = TERMINAL.hyperlinks;
type HyperlinkMode = "off" | "auto" | "always";
let hyperlinkMode: HyperlinkMode = "auto";

/** Stable 8-char hex ID derived from a URI — hints terminals to coalesce identical adjacent links. */
function buildLinkId(uri: string): string {
	let h = 0;
	for (let i = 0; i < uri.length; i++) {
		// FNV-1a-inspired mix — good enough for a UI hint, no deps
		h = (Math.imul(31, h) + uri.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Build the OSC 8 target for a file path on `terminalId`.
 *
 * A `file:` URI handed to an editor has to be a plain path. `Paths.get(URI)`
 * rejects one carrying a query or a fragment outright — `IllegalArgumentException:
 * URI has a query component` / `URI has a fragment component` — so appending
 * `?line=` made every JVM-based language server (Kotlin LSP, Eclipse JDT LS)
 * fail *every* request for the resulting document, and VS Code reads the query
 * as part of the resource identity rather than as a cursor position: a blank
 * editor tab that navigates nowhere and persists across window reloads (#12109).
 *
 * The VS Code family instead navigates the documented
 * `vscode://file/<path>:<line>:<col>` form. Everywhere else the plain `file:`
 * URI is right, with the location left in the visible text — terminals that
 * parse a `path:line:col` suffix resolve that on their own.
 */
export function fileUriForTerminal(
	filePath: string,
	opts: { line?: number; col?: number } | undefined,
	terminalId: TerminalId,
): string {
	if (terminalId !== "vscode") return url.pathToFileURL(filePath).href;
	// vscode:// takes a filesystem path with forward slashes. Encode each
	// segment independently so separators and a Windows drive colon stay
	// structural while reserved bytes in file names cannot become URI syntax.
	const asPath = filePath.replace(/\\/gu, "/");
	const encodedPath = asPath
		.split("/")
		.map((segment, index) => (index === 0 && /^[a-z]:$/iu.test(segment) ? segment : encodeURIComponent(segment)))
		.join("/");
	const position =
		opts?.line === undefined ? "" : opts.col === undefined ? `:${opts.line}` : `:${opts.line}:${opts.col}`;
	return `vscode://file${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}${position}`;
}

/** Build the OSC 8 target for `filePath` on this terminal. */
function buildFileUri(filePath: string, opts?: { line?: number; col?: number }): string {
	return fileUriForTerminal(filePath, opts, TERMINAL.id);
}

/**
 * Returns true when OSC 8 hyperlinks should be emitted.
 *
 * Respects `tui.hyperlinks` setting:
 * - `"off"`: never
 * - `"auto"`: when `process.stdout.isTTY`, `NO_COLOR` is unset, and the detected terminal reports hyperlink support
 * - `"always"`: unconditionally (useful for viewers that support OSC 8 without advertising it)
 * Uses the last policy pushed by the host, defaulting to `"auto"`.
 */
export function isHyperlinkEnabled(): boolean {
	return resolveHyperlinkMode(hyperlinkMode);
}

function resolveHyperlinkMode(mode: HyperlinkMode): boolean {
	if (mode === "off") return false;
	if (mode === "always") return true;
	// auto: respect the detected capability (immutable snapshot, not the mutable
	// runtime flag that applyHyperlinkSetting overwrites) and NO_COLOR.
	if (Bun.env.NO_COLOR) return false;
	if (!process.stdout.isTTY) return false;
	return DETECTED_TERMINAL_HYPERLINKS;
}

/**
 * Push the resolved `tui.hyperlinks` policy into {@link TERMINAL}.hyperlinks, the
 * effective flag that pi-tui renderers gating on it directly — the Markdown
 * component's `[text](url)`/bare-URL links and the status-line PR link — consult.
 *
 * Detection stays immutable in {@link DETECTED_TERMINAL_HYPERLINKS}, so this only
 * ever writes the effective decision; `auto` transitions restore real detection
 * via {@link isHyperlinkEnabled}. Called at TUI startup and whenever the setting
 * changes at runtime.
 * Accepts the raw (unvalidated) setting value; anything but a known mode falls
 * back to the last policy pushed by the host.
 */
export function applyHyperlinkSetting(mode?: unknown): void {
	if (mode === "off" || mode === "auto" || mode === "always") hyperlinkMode = mode;
	setTerminalHyperlinks(isHyperlinkEnabled());
}

function safeHyperlinkUri(uri: string): string | undefined {
	if (!uri || /[\x00-\x1f\x7f]/.test(uri)) return undefined;
	return uri;
}

function wrapHyperlinkCore(uri: string, displayText: string, terminator: typeof ST | typeof BEL): string {
	// Do not double-wrap if the text already embeds an OSC 8 sequence.
	if (displayText.includes("\x1b]8;")) return displayText;
	const safeUri = safeHyperlinkUri(uri);
	if (!safeUri) return displayText;
	const id = buildLinkId(safeUri);
	return `${OSC}8;id=${id};${safeUri}${terminator}${displayText}${OSC}8;;${terminator}`;
}

function wrapHyperlink(uri: string, displayText: string): string {
	if (!isHyperlinkEnabled()) return displayText;
	return wrapHyperlinkCore(uri, displayText, ST);
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at `uri`.
 *
 * Returns `displayText` unchanged when hyperlinks are disabled, `uri` contains
 * terminal control bytes, or `displayText` already contains an OSC 8 sequence.
 */
export function uriHyperlink(uri: string, displayText: string): string {
	return wrapHyperlink(uri, displayText);
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at an HTTP(S) URL.
 * `www.example.com` inputs are linked as `https://www.example.com`.
 */
export function urlHyperlink(url: string, displayText: string): string {
	const normalized = url.match(/^www\./i) ? `https://${url}` : url;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return displayText;
		return wrapHyperlink(parsed.href, displayText);
	} catch {
		return displayText;
	}
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at an HTTP(S) URL,
 * bypassing terminal capability auto-detection. Used for auth prompts where
 * an inert "click" label blocks login on terminals whose capabilities are
 * not advertised. Still returns plain text when the host has explicitly opted
 * out by pushing the `"off"` policy.
 */
export function urlHyperlinkAlways(url: string, displayText: string): string {
	if (hyperlinkMode === "off") return displayText;
	const normalized = url.match(/^www\./i) ? `https://${url}` : url;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return displayText;
		return wrapHyperlinkCore(parsed.href, displayText, BEL);
	} catch {
		return displayText;
	}
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at a filesystem path.
 *
 * Returns `displayText` unchanged when hyperlinks are disabled or when
 * the text already contains an OSC 8 sequence (prevents double-wrapping).
 * Relative paths resolve against the current working directory before URI
 * encoding so the OSC 8 target is always a valid `file://` URL.
 *
 * @param filePath - Filesystem path
 * @param displayText - Text to render as the hyperlink anchor (may contain ANSI codes)
 * @param opts - Optional line/col position appended as `?line=N&col=M` query params
 */
export function fileHyperlink(filePath: string, displayText: string, opts?: { line?: number; col?: number }): string {
	return wrapHyperlink(buildFileUri(filePath, opts), displayText);
}
