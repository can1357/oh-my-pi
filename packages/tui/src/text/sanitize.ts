/**
 * Making untrusted text safe for a terminal row: control characters,
 * carriage returns, tabs, line breaks and home-directory paths.
 */
import * as os from "node:os";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { tokens } from "./ansi";
import { replaceTabs } from "./width";

/** C0/C1 controls and DEL, except tab and line feed. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * `text` without control characters (tab and line feed stay). Escape
 * sequences go too, unless `keepEscapes` keeps the complete ones (styled
 * text a renderer produced).
 */
export function stripControl(text: string, keepEscapes = false): string {
	if (!keepEscapes) return sanitizeText(text);
	if (!text.includes("\x1b")) return text.replace(CONTROL, "");
	let out = "";
	for (const token of tokens(text)) out += token.escape ? token.text : token.text.replace(CONTROL, "");
	return out;
}

/**
 * Raw output (a subprocess, a web page) as display lines: CRLF and LF split
 * lines, a `\r` progress overwrite keeps only what was written last, controls
 * and escapes are dropped and tabs expanded.
 */
export function displayLines(text: string): string[] {
	return text.split(/\r?\n/).map(line => {
		const overwrite = line.lastIndexOf("\r");
		return replaceTabs(sanitizeText(overwrite < 0 ? line : line.slice(overwrite + 1)));
	});
}

/** CRLF becomes LF and stray carriage-return runs become one space (prose a lone `\r` would shred). */
export function normalizeLineEndings(text: string): string {
	return text.includes("\r") ? text.replaceAll("\r\n", "\n").replace(/\r+/g, " ") : text;
}

/** Tabs expanded and line breaks collapsed to spaces, for text confined to one row. */
export function singleLine(text: string): string {
	return replaceTabs(text).replace(/[\r\n]+/g, " ");
}

/** Every whitespace run (line breaks and tabs included) collapsed to one space, trimmed. */
export function flattenLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

// ─── Home-directory paths ───────────────────────────────────────────────────

function isWindowsHome(home: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(home) || home.startsWith("\\\\");
}

function trimSeparators(home: string): string {
	return home.length > 1 ? home.replace(/[\\/]+$/, "") : home;
}

/** `path` with a leading home directory as `~` (Windows separators after it become `/`). */
export function shortenHome(path: string, home: string = os.homedir()): string {
	const root = trimSeparators(home);
	if (root.length <= 1) return path;
	const windows = isWindowsHome(root);
	const head = path.slice(0, root.length);
	if (windows ? head.toLowerCase() !== root.toLowerCase() : head !== root) return path;
	const rest = path.slice(root.length);
	if (rest !== "" && rest[0] !== "/" && rest[0] !== "\\") return path;
	return `~${rest.replaceAll("\\", "/")}`;
}

const homePatterns = new Map<string, RegExp>();

/**
 * Matches URLs (kept) or the home directory after a word boundary, with the
 * path that follows it, ending at whitespace, a quote, punctuation or the end.
 */
function homePattern(root: string): RegExp {
	let pattern = homePatterns.get(root);
	if (pattern === undefined) {
		const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		pattern = new RegExp(
			`[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s"'<>]+` +
				`|(^|[\\s"'\`([{=,:<>&|*_])${escaped}([\\\\/][^\\s"'\`<>]*)?(?=$|[\\s.,;:!?)\\]}"'\`*_<>])`,
			isWindowsHome(root) ? "gi" : "g",
		);
		if (homePatterns.size >= 16) homePatterns.clear();
		homePatterns.set(root, pattern);
	}
	return pattern;
}

/** Home-directory paths inside `text` shortened to `~` (URLs untouched). */
export function shortenHomeIn(text: string, home: string = os.homedir()): string {
	const root = trimSeparators(home);
	if (root.length <= 1) return text;
	const windows = isWindowsHome(root);
	return text.replace(homePattern(root), (match, boundary: string | undefined, tail: string | undefined) => {
		if (boundary === undefined) return match;
		return `${boundary}~${windows && tail !== undefined ? tail.replaceAll("\\", "/") : (tail ?? "")}`;
	});
}
