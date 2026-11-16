/**
 * `tui.linkMap`: where file links under a path prefix point.
 *
 * Each entry replaces a path prefix with a URI prefix in any scheme: the rest of the path is appended to the URI
 * prefix one percent-encoded segment at a time. Keys are cleaned up once, when the map is pushed: a leading `~`
 * becomes the home directory, and also its real path when the home is a symlink; `{user}` becomes the login name;
 * the result is normalised with `path.posix.normalize` and loses a trailing slash. Keys that come out as the same
 * prefix are one entry, and the later one is ignored with a warning. The longest prefix wins, by whole segments.
 * The map is not applied when omp itself runs on Windows.
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
	/** What the key stands for, from {@link linkMapPrefixes}. */
	prefix: string;
	/** `prefix` ending in `/`: what a path under the directory starts with. */
	dir: string;
	/** URI prefix ending in `/`. */
	target: string;
}

/** Valid entries of the pushed map, most specific first. */
let entries: readonly LinkMapEntry[] = [];

const MATCH_CACHE_LIMIT = 512;
const matchCache = new Map<string, { key: string; uri: string } | null>();

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

/** An absolute path, `~` or `~/...`. */
export function isLinkMapKey(key: string): boolean {
	return key === "~" || key.startsWith("~/") || key.startsWith("/");
}

/**
 * The normalised prefixes a key stands for, including a symlinked home's real path; none for an invalid key or
 * unknown login name.
 */
export function linkMapPrefixes(key: string): string[] {
	if (!isLinkMapKey(key)) return [];
	let text = key;
	if (key.includes("{user}")) {
		let user: string;
		try {
			user = os.userInfo().username;
		} catch {
			// No passwd entry for this uid.
			return [];
		}
		if (!user) return [];
		text = key.replaceAll("{user}", user);
	}
	const candidates: string[] = [];
	if (key.startsWith("~")) {
		const home = os.homedir();
		candidates.push(home + text.slice(1));
		try {
			const real = fs.realpathSync(home);
			if (real !== home) candidates.push(real + text.slice(1));
		} catch {
			// The home directory's real path is optional.
		}
	} else {
		candidates.push(text);
	}
	const prefixes: string[] = [];
	for (const candidate of candidates) {
		const normalised = path.posix.normalize(candidate);
		const prefix = normalised === "/" ? normalised : normalised.replace(/\/$/, "");
		if (!prefixes.includes(prefix)) prefixes.push(prefix);
	}
	return prefixes;
}

/**
 * Push `tui.linkMap`, such as `{ "/mnt/projects": "file:///Z:/", "/srv/handbook":
 * "https://git.contoso.example/handbook/blob/main" }`. Entries whose key fails {@link isLinkMapKey} or whose value
 * fails {@link parseLinkTarget} are ignored with a warning, as is an entry whose key stands for the prefix of an
 * earlier one; an empty value is ignored silently. Anything but a plain object clears the map.
 */
export function applyLinkMapSetting(value?: unknown): void {
	// Keys are evaluated here, when the setting changes, so drawing a link does not touch the user database.
	const next = new Map<string, LinkMapEntry>();
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		for (const [key, raw] of Object.entries(value)) {
			if (raw === "") continue;
			const target = parseLinkTarget(raw);
			if (!target || !isLinkMapKey(key)) {
				logger.warn("Ignoring invalid tui.linkMap entry", { key, target: raw });
				continue;
			}
			const prefixes = linkMapPrefixes(key);
			// `{user}` without a login name: the key stays unmatched.
			if (prefixes.length === 0) continue;
			let first: LinkMapEntry | undefined;
			for (const prefix of prefixes) {
				first = next.get(prefix);
				if (first) break;
			}
			if (first) {
				logger.warn("Ignoring duplicate tui.linkMap entry", { key, sameAs: first.key });
				continue;
			}
			for (const prefix of prefixes) {
				next.set(prefix, { key, prefix, dir: prefix === "/" ? "/" : `${prefix}/`, target });
			}
		}
	}
	entries = [...next.values()].sort((a, b) => b.prefix.length - a.prefix.length);
	matchCache.clear();
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
	const resolved = path.resolve(filePath);
	const cached = matchCache.get(resolved);
	if (cached !== undefined) return cached ?? undefined;
	const entry = entries.find(({ prefix, dir }) => resolved === prefix || resolved.startsWith(dir));
	let match: { key: string; uri: string } | null = null;
	if (entry) {
		const rest = resolved.slice(entry.dir.length).split("/");
		match = { key: entry.key, uri: entry.target + rest.map(encodeURIComponent).join("/") };
	}
	if (matchCache.size >= MATCH_CACHE_LIMIT) matchCache.clear();
	matchCache.set(resolved, match);
	return match ?? undefined;
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
