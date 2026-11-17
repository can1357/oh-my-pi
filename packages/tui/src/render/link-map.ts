/** Path-prefix URI mappings: normalized once, matched by whole segments with the longest prefix winning. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/** URI scheme syntax (RFC 3986 §3.1), matched after lowercasing. */
export const LINK_SCHEME = /^[a-z][a-z0-9+.-]*$/;

interface LinkMapEntry {
	key: string;
	prefix: string;
	dir: string;
	target: string;
}

export type LinkMapWarn = (message: string, details: Record<string, unknown>) => void;

/** Valid entries of the pushed map, most specific first. */
let entries: readonly LinkMapEntry[] = [];

const MATCH_CACHE_LIMIT = 512;
const matchCache = new Map<string, { key: string; uri: string } | null>();

/** Canonical URI prefix without query/fragment; accepts Windows-style file URIs but not drive-letter schemes. */
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

/** Expand a key, including symlinked home paths; an unknown login has no prefixes. */
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

/** Clean configured maps on reads; reject invalid or colliding entries on writes. */
export function parseLinkMap(
	value: unknown,
	mode: "read" | "write" = "read",
	warn?: LinkMapWarn,
): Record<string, string> {
	return compileLinkMap(value, mode, warn).value;
}

function compileLinkMap(
	value: unknown,
	mode: "read" | "write",
	warn?: LinkMapWarn,
): { value: Record<string, string>; entries: LinkMapEntry[] } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		if (mode === "write") throw new Error("tui.linkMap must be an object mapping path prefixes to URI prefixes");
		if (value !== undefined && value !== null) warn?.("Ignoring invalid tui.linkMap value", { value });
		return { value: {}, entries: [] };
	}
	const owners = new Map<string, string>();
	const clean: Record<string, string> = {};
	const compiled: LinkMapEntry[] = [];
	for (const [key, raw] of Object.entries(value)) {
		if (raw === "") {
			if (!isLinkMapKey(key)) {
				if (mode === "write") throw new Error("Start with / or ~, for example /mnt/projects or ~/src");
				continue;
			}
			clean[key] = "";
			continue;
		}
		const target = parseLinkTarget(raw);
		if (target === undefined || !isLinkMapKey(key)) {
			if (mode === "write") {
				throw new Error(
					target === undefined
						? "Use a URI with a scheme and no query or fragment, such as file:///Z:/"
						: "Start with / or ~, for example /mnt/projects or ~/src",
				);
			}
			warn?.("Ignoring invalid tui.linkMap entry", { key, target: raw });
			continue;
		}
		const prefixes = linkMapPrefixes(key);
		if (prefixes.length === 0) {
			clean[key] = target;
			continue;
		}
		let owner: string | undefined;
		for (const prefix of prefixes) {
			owner = owners.get(prefix);
			if (owner !== undefined) break;
		}
		if (owner !== undefined) {
			if (mode === "write") throw new Error(`${owner} is already the entry for that prefix.`);
			warn?.("Ignoring duplicate tui.linkMap entry", { key, sameAs: owner });
			continue;
		}
		for (const prefix of prefixes) {
			owners.set(prefix, key);
			compiled.push({ key, prefix, dir: prefix === "/" ? "/" : `${prefix}/`, target });
		}
		clean[key] = target;
	}
	return { value: clean, entries: compiled };
}

/** Push clean mappings to the renderer, warning about ignored entries. */
export function applyLinkMapSetting(value?: unknown): void {
	const next = compileLinkMap(value, "read", (message, details) => logger.warn(message, details));
	entries = next.entries.sort((a, b) => b.prefix.length - a.prefix.length);
	matchCache.clear();
}

/** Match whole path segments. Relative paths resolve against cwd; encoding can throw URIError. */
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

/** Return a mapped URI, if any. Path encoding can throw URIError. */
export function mappedLinkUri(filePath: string): string | undefined {
	return matchLinkEntry(filePath)?.uri;
}
