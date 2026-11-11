/**
 * `tui.linkMap`: where file links under a path prefix point.
 *
 * Each entry maps a path prefix (an absolute path, `~` or `~/...`) to a URI prefix in any scheme. A path below
 * the prefix is appended to the URI prefix one percent-encoded segment at a time, and the longest matching
 * prefix wins. `~` covers both the home directory and its realpath; `<user>` in a key stands for the login
 * name. The map is not applied when omp itself runs on Windows.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/** URI scheme syntax (RFC 3986 §3.1), matched after lowercasing. */
export const LINK_SCHEME = /^[a-z][a-z0-9+.-]*$/;

interface LinkMapEntry {
	/** The key as written in the setting. */
	key: string;
	/** URI prefix ending in `/`. */
	target: string;
}

interface CompiledPrefix extends LinkMapEntry {
	segments: readonly string[];
}

/** Valid entries of the pushed map, in setting order. */
let entries: readonly LinkMapEntry[] = [];
/**
 * Entry prefixes as path segments for one home directory; the home's realpath and the login name follow it.
 * Compiled when the map is pushed.
 */
let compiled: { home: string; prefixes: readonly CompiledPrefix[] } | undefined;

/**
 * Parse a map value into a URI prefix ending in `/`. Any scheme of two or more characters is accepted (a
 * one-letter "scheme" is a Windows drive such as `Z:`); a value with a query or a fragment is not. A `file:`
 * value may be written Windows-style: backslashes become slashes, and `file://Z:/p` or `file:\\Z:\p` become
 * `file:///Z:/p`, with the drive letter uppercased. Anything else yields `undefined`.
 */
export function parseLinkTarget(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let text = value.trim();
	if (/^file:/i.test(text)) {
		const rest = text.slice("file:".length).replaceAll("\\", "/");
		const slashes = /^\/*/.exec(rest)?.[0].length ?? 0;
		const tail = rest.slice(slashes);
		text = `file:${/^[A-Za-z]:(?:\/|$)/.test(tail) ? "///" : "/".repeat(slashes)}${tail}`;
	}
	const scheme = /^([^:/?#]+):/.exec(text)?.[1];
	if (!scheme || scheme.length < 2 || !LINK_SCHEME.test(scheme.toLowerCase())) return undefined;
	if (text.includes("?") || text.includes("#")) return undefined;
	let href: string;
	try {
		href = new URL(text).href;
	} catch {
		return undefined;
	}
	href = href.replace(/^file:\/\/\/([a-z]):/, (_, letter: string) => `file:///${letter.toUpperCase()}:`);
	return href.endsWith("/") ? href : `${href}/`;
}

/** An absolute path, `~` or `~/...`, with no `.` or `..` segment: a key is compared as written, never resolved. */
export function isLinkMapKey(key: string): boolean {
	if (key !== "~" && !key.startsWith("~/") && !key.startsWith("/")) return false;
	return !key.split("/").some(segment => segment === "." || segment === "..");
}

/**
 * Push `tui.linkMap`, such as `{ "/mnt/projects": "file:///Z:/", "/srv/handbook":
 * "https://git.contoso.example/handbook/blob/main" }`. Entries whose key fails {@link isLinkMapKey} or whose value
 * fails {@link parseLinkTarget} are ignored with a warning; an empty value is ignored silently. Anything but a
 * plain object clears the map.
 */
export function applyLinkMapSetting(value?: unknown): void {
	const next: LinkMapEntry[] = [];
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		for (const [key, raw] of Object.entries(value)) {
			if (raw === "") continue;
			const target = parseLinkTarget(raw);
			if (target && isLinkMapKey(key)) next.push({ key, target });
			else logger.warn("Ignoring invalid tui.linkMap entry", { key, target: raw });
		}
	}
	entries = next;
	// Resolve the home realpath and the login name here, when the setting changes, so drawing a link does not
	// touch the filesystem or the user database. `matchLinkEntry` recompiles only if the home directory moves.
	compiled = next.length > 0 ? compileFor(os.homedir()) : undefined;
}

function compileFor(home: string): { home: string; prefixes: readonly CompiledPrefix[] } {
	return { home, prefixes: compilePrefixes(home) };
}

function compilePrefixes(home: string): readonly CompiledPrefix[] {
	const split = (p: string) => p.split("/").filter(Boolean);
	let realHome: string | undefined;
	if (entries.some(entry => entry.key === "~" || entry.key.startsWith("~/"))) {
		try {
			realHome = fs.realpathSync(home);
		} catch {
			realHome = undefined;
		}
	}
	let user: string | undefined;
	if (entries.some(entry => entry.key.includes("<user>"))) {
		try {
			user = os.userInfo().username || undefined;
		} catch {
			// No passwd entry for this uid: `<user>` keys stay unmatched.
		}
	}
	const prefixes: CompiledPrefix[] = [];
	for (const entry of entries) {
		let { key } = entry;
		if (key.includes("<user>")) {
			if (!user) continue;
			key = key.replaceAll("<user>", user);
		}
		if (key === "~" || key.startsWith("~/")) {
			const homes = realHome && realHome !== home ? [home, realHome] : [home];
			for (const base of homes) prefixes.push({ ...entry, segments: split(base + key.slice(1)) });
		} else {
			prefixes.push({ ...entry, segments: split(key) });
		}
	}
	return prefixes;
}

function startsWithSegments(segments: readonly string[], prefix: readonly string[]): boolean {
	return prefix.length <= segments.length && prefix.every((segment, i) => segment === segments[i]);
}

/**
 * The map entry covering `filePath` (its key as written) and the link target it yields, or `undefined` when no
 * entry covers it. Relative paths resolve against the working directory first, as file links do. Matching is
 * segment-wise and case-sensitive, so `/data` covers `/data/x` but not `/data-x`.
 *
 * @throws URIError when a path segment cannot be percent-encoded (a lone surrogate).
 */
export function matchLinkEntry(filePath: string): { key: string; uri: string } | undefined {
	if (entries.length === 0 || process.platform === "win32") return undefined;
	const home = os.homedir();
	if (compiled?.home !== home) compiled = compileFor(home);
	const segments = path.resolve(filePath).split("/").filter(Boolean);
	let best: CompiledPrefix | undefined;
	for (const prefix of compiled.prefixes) {
		if (best && prefix.segments.length <= best.segments.length) continue;
		if (startsWithSegments(segments, prefix.segments)) best = prefix;
	}
	if (!best) return undefined;
	return { key: best.key, uri: best.target + segments.slice(best.segments.length).map(encodeURIComponent).join("/") };
}

/**
 * The `tui.linkMap` target for `filePath`, such as `file:///Z:/q3/report.csv`, or `undefined` when no entry
 * covers it.
 *
 * @throws URIError when a path segment cannot be percent-encoded (a lone surrogate).
 */
export function mappedLinkUri(filePath: string): string | undefined {
	return matchLinkEntry(filePath)?.uri;
}
