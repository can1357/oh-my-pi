/**
 * OSC 8 terminal hyperlink support for paths and URLs.
 *
 * Wraps display text in `ESC ] 8 ; id=HASH ; URI ESC \ TEXT ESC ] 8 ; ; ESC \`
 * sequences when the active terminal supports hyperlinks and the user setting
 * permits it. Falls back to plain text when disabled.
 */
import * as url from "node:url";
import { setTerminalHyperlinks, TERMINAL } from "@oh-my-pi/pi-tui";
import { isSettingsInitialized, settings } from "../config/settings";
import {
	LocalProtocolHandler,
	memoryRootsFromRegistry,
	parseInternalUrl,
	resolveLocalUrlToPath,
	resolveMemoryUrlToPath,
} from "../internal-urls";

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

/** Stable 8-char hex ID derived from a URI — hints terminals to coalesce identical adjacent links. */
function buildLinkId(uri: string): string {
	let h = 0;
	for (let i = 0; i < uri.length; i++) {
		// FNV-1a-inspired mix — good enough for a UI hint, no deps
		h = (Math.imul(31, h) + uri.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Build a properly encoded `file://` URI with optional line/col query params. */
function buildFileUri(filePath: string, opts?: { line?: number; col?: number }): string {
	const uri = url.pathToFileURL(filePath);
	if (opts?.line !== undefined) uri.searchParams.set("line", String(opts.line));
	if (opts?.col !== undefined) uri.searchParams.set("col", String(opts.col));
	return uri.href;
}

/**
 * Returns true when OSC 8 hyperlinks should be emitted.
 *
 * Respects `tui.hyperlinks` setting:
 * - `"off"`: never
 * - `"auto"`: when `process.stdout.isTTY`, `NO_COLOR` is unset, and the detected terminal reports hyperlink support
 * - `"always"`: unconditionally (useful for viewers that support OSC 8 without advertising it)
 * Before settings initialization, returns false so early render paths stay plain text.
 */
export function isHyperlinkEnabled(): boolean {
	if (!isSettingsInitialized()) return false;
	return resolveHyperlinkMode(settings.get("tui.hyperlinks"));
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
 * back to the setting-resolved default.
 */
export function applyHyperlinkSetting(mode?: unknown): void {
	const valid = mode === "off" || mode === "auto" || mode === "always" ? mode : undefined;
	setTerminalHyperlinks(valid === undefined ? isHyperlinkEnabled() : resolveHyperlinkMode(valid));
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
 * not advertised. Still returns plain text before settings initialization or
 * when the user has explicitly opted out via `tui.hyperlinks=off`.
 */
export function urlHyperlinkAlways(url: string, displayText: string): string {
	if (!isSettingsInitialized()) return displayText;
	if (settings.get("tui.hyperlinks") === "off") return displayText;
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

/**
 * Synchronously resolve a filesystem-backed internal URL (e.g. `local://foo.md`,
 * `memory://root/notes.md`) to its absolute filesystem path. Returns `undefined`
 * for inputs that aren't fs-backed, aren't resolvable in the current session
 * registry, or fail to parse.
 *
 * Used by renderers to wrap fs-backed internal URLs in OSC 8 hyperlinks even
 * when the resolved path isn't yet available from tool result details (e.g.
 * during the call/streaming phase before a result lands).
 *
 * Async-resolved schemes (`artifact://`, `agent://`, `skill://`, `rule://`,
 * `omp://`) are not handled here — those rely on `details.resolvedPath` set
 * by the read tool's router resolution.
 */
export function tryResolveInternalUrlSync(input: string): string | undefined {
	try {
		if (input.startsWith("local://")) {
			const opts = LocalProtocolHandler.resolveOptions();
			if (!opts) return undefined;
			return resolveLocalUrlToPath(input, opts);
		}
		if (input.startsWith("memory://")) {
			const url = parseInternalUrl(input);
			const roots = memoryRootsFromRegistry();
			for (const root of roots) {
				try {
					return resolveMemoryUrlToPath(url, root);
				} catch {
					// Try the next root; some sessions may not have this namespace mounted.
				}
			}
			return undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
