/**
 * OSC 8 terminal hyperlink support for paths and URLs.
 *
 * Wraps display text in `ESC ] 8 ; id=HASH ; URI ESC \ TEXT ESC ] 8 ; ; ESC \`
 * sequences when the active terminal supports hyperlinks and the user setting
 * permits it. Falls back to plain text when disabled.
 */
import * as os from "node:os";
import * as url from "node:url";
import { logger } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { span } from "../native/describe";
import { setTerminalHyperlinks, TERMINAL, type TerminalId } from "../terminal-capabilities";
import { LINK_SCHEME, mappedLinkUri } from "./link-map";

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

export interface FileLinkConfig {
	scheme?: string;
	host?: string;
}

/**
 * What a file link points at. A caller that cannot tell without a filesystem call passes `unknown`,
 * which links as a file.
 */
export type FileLinkKind = "file" | "dir" | "unknown";

/** A filesystem path to link: what it is and, for a file, where in it to land. */
export interface FileLink {
	path: string;
	kind: FileLinkKind;
	line?: number;
	col?: number;
	/** Native image open actions need a local file URL: no `tui.linkMap` target, no desktop handler, no position. */
	local?: boolean;
}

type LinkPosition = Pick<FileLink, "line" | "col">;

let fileLinkTarget: { scheme: string; host: string } | undefined;

/** A bare host name with an optional port: no userinfo, path, query, or whitespace that would reshape the URI. */
const FILE_LINK_HOST = /^[A-Za-z0-9._-]+(?::\d{1,5})?$/;

/**
 * Resolve the remote file-link configuration once at host startup. Passing an
 * explicit object lets SDK hosts and tests configure links without changing the
 * process environment; an empty object restores ordinary file links. An invalid
 * scheme or host logs a warning and keeps ordinary links.
 */
export function applyFileLinkSetting(
	config: FileLinkConfig = {
		scheme: Bun.env.PI_LINK_SCHEME,
		host: Bun.env.PI_LINK_HOST,
	},
): void {
	fileLinkTarget = undefined;
	if (!config.scheme) return;
	const scheme = config.scheme.toLowerCase();
	if (!LINK_SCHEME.test(scheme)) {
		logger.warn("Invalid PI_LINK_SCHEME; using ordinary file links", { scheme: config.scheme });
		return;
	}
	const host = config.host || os.hostname();
	if (!FILE_LINK_HOST.test(host)) {
		logger.warn("Invalid PI_LINK_HOST; using ordinary file links", { host });
		return;
	}
	fileLinkTarget = { scheme, host };
}

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
 * The target of a file link, or `undefined` when its path cannot be encoded. Without `terminalId` this is the
 * target for native spans, fields and tool heads; with it, the OSC 8 target for that terminal.
 *
 * Precedence: a `tui.linkMap` entry covering the path, then the `PI_LINK_SCHEME`
 * handler, then a plain `file:` URL. `link.local` skips the first two for actions that
 * run on this machine. Explicit hrefs supplied by a renderer keep their own target.
 *
 * `link.kind` decides the position: a `dir` never carries a line or a column, in any target form, and
 * `unknown` links as a `file` does.
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
 * `vscode://file/<path>:<line>:<col>` form, which a `file:///` map target keeps
 * there. Everywhere else the plain `file:` URI is right, with the location left
 * in the visible text — terminals that parse a `path:line:col` suffix resolve
 * that on their own. A configured custom handler receives optional `line`/`col`
 * query parameters.
 *
 * Node rejects a malformed UNC target (a UNC path escaped twice by its author,
 * e.g. `\\\wsl.localhost\…`) with `ERR_INVALID_ARG_VALUE: Empty UNC servername`.
 * A stored session keeps whatever a tool call recorded, so a transcript must
 * render such a path without a link rather than throw while it rebuilds.
 */
export function resolveFileLink(link: FileLink, terminalId?: TerminalId): string | undefined {
	const at = link.kind === "dir" ? undefined : link;
	try {
		if (link.local) return url.pathToFileURL(link.path).href;
		const mapped = mappedLinkUri(link.path);
		if (terminalId === "vscode") {
			if (mapped?.startsWith("file:///")) {
				return `vscode://file/${mapped.slice("file:///".length)}${pathPosition(at)}`;
			}
			if (mapped === undefined && !fileLinkTarget) {
				// vscode:// takes a filesystem path with forward slashes. Encode each
				// segment independently so separators and a Windows drive colon stay
				// structural while reserved bytes in file names cannot become URI syntax.
				const asPath = link.path.replace(/\\/gu, "/");
				const encodedPath = asPath
					.split("/")
					.map((segment, index) =>
						index === 0 && /^[a-z]:$/iu.test(segment) ? segment : encodeURIComponent(segment),
					)
					.join("/");
				return `vscode://file${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}${pathPosition(at)}`;
			}
		}
		if (mapped !== undefined) return withPosition(mapped, at);
		const fileUrl = url.pathToFileURL(link.path);
		if (!fileLinkTarget) return fileUrl.href;
		// Preserve UNC servers so the handler can reconstruct the network path.
		const targetPath = fileUrl.host ? `//${fileUrl.host}${fileUrl.pathname}` : fileUrl.pathname;
		return `${fileLinkTarget.scheme}://${fileLinkTarget.host}${targetPath}${positionQuery(at)}`;
	} catch {
		// A model-authored path can carry a lone surrogate (`encodeURIComponent` throws
		// URIError) or a malformed UNC server; the row keeps its text and loses the link.
		return undefined;
	}
}

function positionQuery(at?: LinkPosition): string {
	const position = new URLSearchParams();
	if (at?.line !== undefined) position.set("line", String(at.line));
	if (at?.col !== undefined) position.set("col", String(at.col));
	return position.size ? `?${position}` : "";
}

/** `:line` or `:line:col` after a path, the position form VS Code's URL handler reads, or `""`. */
function pathPosition(at?: LinkPosition): string {
	if (at?.line === undefined) return "";
	return at.col === undefined ? `:${at.line}` : `:${at.line}:${at.col}`;
}

/**
 * A `tui.linkMap` target with the position `at` in the form its scheme takes: none for `file:` and `http(s):`,
 * a `:line:col` suffix for `vscode:` and `vscode-insiders:`, and the `line`/`col` query of `PI_LINK_SCHEME`
 * for any other scheme. A directory passes no `at` and keeps the bare target.
 *
 * VS Code opens a `vscode-remote` path as a folder unless it ends in `:<line>`, so a file link without a line
 * gets `:1` there.
 */
function withPosition(target: string, at: LinkPosition | undefined): string {
	if (!at || /^(?:file|https?):/i.test(target)) return target;
	if (/^vscode(?:-insiders)?:/i.test(target)) {
		const remoteFile = at.line === undefined && /^[a-z-]+:\/\/vscode-remote\//i.test(target);
		return target + (remoteFile ? ":1" : pathPosition(at));
	}
	return target + positionQuery(at);
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
 * A native link span to an HTTP(S) URL (`www.` inputs become `https://`).
 * Unlike the OSC 8 wrappers this ignores terminal capability detection — a
 * TSP terminal always handles `href` — but honours an explicit `off` policy.
 * Non-HTTP(S) or unparsable URLs yield a plain span.
 */
export function urlLinkSpan(target: string, displayText: string, s = "link"): TspSpan {
	if (hyperlinkMode === "off") return span(displayText, s);
	const normalized = target.match(/^www\./i) ? `https://${target}` : target;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return span(displayText, s);
		const href = safeHyperlinkUri(parsed.href);
		return href ? span(displayText, s, { href }) : span(displayText, s);
	} catch {
		return span(displayText, s);
	}
}

/** Whether native link spans and nodes may carry an `href`: everything but an explicit `off` policy. */
export function isNativeLinkEnabled(): boolean {
	return hyperlinkMode !== "off";
}

/**
 * A native link span to a filesystem path using the configured file-link
 * target. Honours an explicit `off` policy.
 */
export function fileLinkSpan(link: FileLink, displayText: string, s = "path"): TspSpan {
	if (hyperlinkMode === "off") return span(displayText, s);
	const uri = resolveFileLink(link);
	const href = uri === undefined ? undefined : safeHyperlinkUri(uri);
	return href ? span(displayText, s, { href }) : span(displayText, s);
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at a filesystem path.
 *
 * Returns `displayText` unchanged when hyperlinks are disabled or when
 * the text already contains an OSC 8 sequence (prevents double-wrapping).
 * Relative paths resolve against the current working directory before URI
 * encoding so the OSC 8 target is always a valid `file://` URL. A path Node
 * cannot encode renders as `displayText` with no link.
 *
 * @param link - Filesystem path, its kind, and an optional line/col position (custom handlers use query
 *   params; VS Code uses a path suffix)
 * @param displayText - Text to render as the hyperlink anchor (may contain ANSI codes)
 */
export function fileHyperlink(link: FileLink, displayText: string): string {
	const uri = resolveFileLink(link, TERMINAL.id);
	return uri ? wrapHyperlink(uri, displayText) : displayText;
}
