/**
 * Unified mention source for workspace files and directories.
 *
 * Preserves every smart behavior from `CombinedAutocompleteProvider`:
 * - Fast native Rust `fuzzyFind` with shared scan cache, 1.5s deadline, and `AbortSignal`.
 * - Instant immediate-directory listing for paths outside cwd (`@../`, `@~/`, `@/`).
 * - Quoted path support (`@"path with spaces"`), directory drill-down (`appendSpace: false`),
 *   and preserved `:line[-end]` suffixes.
 * - Tier 0 sync paint using cached directory entries + git-dirty & session-recent file boosts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fuzzyFind } from "@oh-my-pi/pi-natives";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { subsequenceMatch } from "../../tokens";
import {
	MATCH_TIER,
	type MatchTier,
	type MentionItem,
	type MentionQuery,
	type MentionSource,
	type MentionSourceResult,
} from "../types";

const DIR_CACHE_TTL_MS = 2_000;
const DIR_CACHE_MAX = 100;
const FUZZY_TIMEOUT_MS = 1_500;
const PARTIAL_DELAY_MS = 120;
const MAX_FILE_ITEMS = 25;

export interface FilesMentionHost {
	readonly getBasePath: () => string;
	readonly dirtyFiles?: () => ReadonlySet<string>;
	readonly recentFiles?: () => readonly string[];
}

function expandHomePath(filePath: string): string {
	if (filePath.startsWith("~/")) {
		const expanded = path.join(os.homedir(), filePath.slice(2));
		return filePath.endsWith("/") && !expanded.endsWith("/") ? `${expanded}/` : expanded;
	}
	return filePath === "~" ? os.homedir() : filePath;
}

function formatFileInsertText(
	relativePath: string,
	options: { isDirectory: boolean; quoted: boolean; lineSuffix?: string },
): string {
	const withLine = !options.isDirectory && options.lineSuffix ? `${relativePath}${options.lineSuffix}` : relativePath;
	const needsQuotes = options.quoted || withLine.includes(" ");
	if (!needsQuotes) return `@${withLine}`;
	return options.isDirectory ? `@"${withLine}` : `@"${withLine}"`;
}

function classifyFileTier(query: string, displayPath: string, baseName: string): MatchTier {
	const trimmed = query.trim();
	if (!trimmed) return MATCH_TIER.Medium;
	const q = trimmed.toLowerCase();
	const name = baseName.toLowerCase();
	const full = displayPath.toLowerCase();
	const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;

	if (name === q || stem === q || full === q) return MATCH_TIER.Exact;
	if (
		name.startsWith(q) ||
		full.startsWith(q) ||
		name.includes(`-${q}`) ||
		name.includes(`_${q}`) ||
		name.includes(`.${q}`)
	) {
		return MATCH_TIER.Strong;
	}
	if (name.includes(q) || full.includes(q)) return MATCH_TIER.Medium;
	return MATCH_TIER.Weak;
}

function buildFileItem(
	displayPath: string,
	options: {
		isDirectory: boolean;
		quoted: boolean;
		tier: MatchTier;
		dirty?: boolean;
		recent?: boolean;
		lineSuffix?: string;
	},
): MentionItem {
	const cleanPath = displayPath.endsWith("/") ? displayPath.slice(0, -1) : displayPath;
	const baseName = path.posix.basename(cleanPath) || cleanPath;
	const parentDir = path.posix.dirname(cleanPath);
	const completionPath = options.isDirectory ? `${cleanPath}/` : cleanPath;
	const insertText = formatFileInsertText(completionPath, {
		isDirectory: options.isDirectory,
		quoted: options.quoted,
		lineSuffix: options.lineSuffix,
	});
	const label = `${baseName}${options.isDirectory ? "/" : ""}${!options.isDirectory && options.lineSuffix ? options.lineSuffix : ""}`;
	const detail = parentDir === "." ? "" : parentDir;
	const facts: Record<string, string> = {};
	if (options.dirty) facts.right = "dirty";
	else if (options.recent) facts.right = "recent";
	else if (options.isDirectory) facts.right = "dir";

	return {
		category: "files",
		tier: options.tier,
		value: insertText,
		insertText,
		appendSpace: !options.isDirectory,
		isDirectory: options.isDirectory,
		label,
		description: cleanPath,
		nativeDetail: detail,
		state: options.dirty ? "dirty" : options.recent ? "recent" : undefined,
		icon: currentTheme().symbols.symbol(options.isDirectory ? "mention.folder" : "mention.file"),
		iconName: options.isDirectory ? "folder" : "file",
		pickerItem: {
			id: `file:${completionPath}`,
			label,
			...(detail ? { detail } : {}),
			icon: options.isDirectory ? "folder" : "file",
			mono: true,
			...(options.dirty ? { dot: "warning" as const } : {}),
			...(facts.right ? { facts } : {}),
		},
	};
}

interface DirCacheEntry {
	readonly entries: readonly { readonly name: string; readonly isDirectory: boolean }[];
	readonly at: number;
}

/** Files & directories mention source with cached dir fast-path and native Rust fuzzyFind. */
export class FilesMentionSource implements MentionSource {
	readonly id = "files" as const;
	readonly label = "Files";

	readonly #host: FilesMentionHost;
	readonly #dirCache = new Map<string, DirCacheEntry>();
	readonly #topDirCache = new Map<string, { readonly isDir: boolean; readonly at: number }>();
	/** Rolling pool of recently matched relative paths so keystroke refinements never flash empty. */
	readonly #recentFuzzyPool = new Map<string, { readonly displayPath: string; readonly isDirectory: boolean }>();

	constructor(host: FilesMentionHost) {
		this.#host = host;
	}

	/** Warm the root workspace directory listing in the background so bare `@` is instant. */
	warm(): void {
		void this.#readDirCached(this.#host.getBasePath());
	}

	/**
	 * Synchronous check whether `head` is an existing top-level directory in the workspace.
	 * Used by `parseMentionQuery` to disambiguate `src/foo` (Files) from `anthropic/opus` (Models).
	 */
	isKnownDirSync(head: string): boolean {
		if (!head || head.includes("\0")) return false;
		const base = this.#host.getBasePath();
		const cachedDir = this.#dirCache.get(base);
		const now = Date.now();
		if (cachedDir && now - cachedDir.at < DIR_CACHE_TTL_MS) {
			const lower = head.toLowerCase();
			return cachedDir.entries.some(e => e.isDirectory && e.name.toLowerCase() === lower);
		}
		const cacheKey = `${base}\0${head}`;
		const memo = this.#topDirCache.get(cacheKey);
		if (memo && now - memo.at < DIR_CACHE_TTL_MS) return memo.isDir;
		let isDir = false;
		try {
			isDir = fs.statSync(path.join(base, head), { throwIfNoEntry: false })?.isDirectory() ?? false;
		} catch {
			isDir = false;
		}
		this.#topDirCache.set(cacheKey, { isDir, at: now });
		if (this.#topDirCache.size > DIR_CACHE_MAX) {
			const oldest = this.#topDirCache.keys().next().value;
			if (oldest !== undefined) this.#topDirCache.delete(oldest);
		}
		return isDir;
	}

	#isOutsideCwd(rawPrefix: string): boolean {
		if (!rawPrefix) return false;
		const base = this.#host.getBasePath();
		const target = rawPrefix.startsWith("~")
			? expandHomePath(rawPrefix)
			: path.isAbsolute(rawPrefix)
				? rawPrefix
				: path.resolve(base, rawPrefix);
		const rel = path.relative(base, target);
		if (rel === "" || rel === ".") return false;
		if (path.isAbsolute(rel)) return true;
		const firstSep = rel.indexOf(path.sep);
		return (firstSep === -1 ? rel : rel.slice(0, firstSep)) === "..";
	}

	async #readDirCached(
		searchDir: string,
	): Promise<readonly { readonly name: string; readonly isDirectory: boolean }[]> {
		const now = Date.now();
		const cached = this.#dirCache.get(searchDir);
		if (cached && now - cached.at < DIR_CACHE_TTL_MS) return cached.entries;
		try {
			const raw = await fs.promises.readdir(searchDir, { withFileTypes: true });
			const entries: { name: string; isDirectory: boolean }[] = [];
			const symlinks: fs.Dirent[] = [];
			for (const entry of raw) {
				if (entry.name === ".git") continue;
				if (entry.isSymbolicLink()) symlinks.push(entry);
				else entries.push({ name: entry.name, isDirectory: entry.isDirectory() });
			}
			if (symlinks.length > 0) {
				const stats = await Promise.all(
					symlinks.map(entry =>
						fs.promises.stat(path.join(searchDir, entry.name)).then(
							s => s.isDirectory(),
							() => null,
						),
					),
				);
				for (let i = 0; i < symlinks.length; i++) {
					const isDir = stats[i];
					if (typeof isDir === "boolean") entries.push({ name: symlinks[i]!.name, isDirectory: isDir });
				}
			}
			entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
			this.#dirCache.delete(searchDir);
			this.#dirCache.set(searchDir, { entries, at: now });
			if (this.#dirCache.size > DIR_CACHE_MAX) {
				const oldest = this.#dirCache.keys().next().value;
				if (oldest !== undefined) this.#dirCache.delete(oldest);
			}
			return entries;
		} catch {
			return [];
		}
	}

	#resolveDirListingTarget(rawQuery: string): { searchDir: string; searchPrefix: string; displayDir: string } {
		const base = this.#host.getBasePath();
		const normalized = rawQuery.replaceAll("\\", "/");
		const expanded = normalized.startsWith("~") ? expandHomePath(normalized) : normalized;
		const isRootLike =
			normalized === "" ||
			normalized === "./" ||
			normalized === "../" ||
			normalized === "~" ||
			normalized === "~/" ||
			normalized === "/";
		if (isRootLike || normalized.endsWith("/")) {
			const searchDir = expanded.startsWith("~") || path.isAbsolute(expanded) ? expanded : path.join(base, expanded);
			const displayDir = normalized === "~" ? "~/" : normalized;
			return { searchDir, searchPrefix: "", displayDir };
		}
		const slash = normalized.lastIndexOf("/");
		if (slash === -1) {
			return { searchDir: base, searchPrefix: normalized, displayDir: "" };
		}
		const displayDir = normalized.slice(0, slash + 1);
		const searchPrefix = normalized.slice(slash + 1);
		const expandedDir = expanded.slice(0, expanded.lastIndexOf("/") + 1);
		const searchDir =
			expandedDir.startsWith("~") || path.isAbsolute(expandedDir) ? expandedDir : path.join(base, expandedDir);
		return { searchDir, searchPrefix, displayDir };
	}

	#itemsFromDirEntries(
		entries: readonly { readonly name: string; readonly isDirectory: boolean }[],
		displayDir: string,
		searchPrefix: string,
		q: MentionQuery,
		dirty: ReadonlySet<string>,
		recentSet: ReadonlySet<string>,
	): MentionItem[] {
		const lowerPrefix = searchPrefix.toLowerCase();
		const items: MentionItem[] = [];
		for (const entry of entries) {
			if (lowerPrefix && !entry.name.toLowerCase().startsWith(lowerPrefix)) continue;
			const displayPath = `${displayDir}${entry.name}`;
			const tier = classifyFileTier(searchPrefix || q.query, displayPath, entry.name);
			items.push(
				buildFileItem(displayPath, {
					isDirectory: entry.isDirectory,
					quoted: Boolean(q.quoted),
					tier,
					dirty: dirty.has(displayPath),
					recent: recentSet.has(displayPath),
					lineSuffix: q.fileLineSuffix,
				}),
			);
			if (items.length >= MAX_FILE_ITEMS) break;
		}
		return items;
	}

	querySync(q: MentionQuery): MentionSourceResult {
		const base = this.#host.getBasePath();
		const dirty = this.#host.dirtyFiles?.() ?? new Set<string>();
		const recentList = this.#host.recentFiles?.() ?? [];
		const recentSet = new Set(recentList);
		const trimmed = q.query.trim();
		const seen = new Set<string>();
		const items: MentionItem[] = [];

		// Boost git-dirty & recently touched files first (especially valuable on bare `@`).
		if (!this.#isOutsideCwd(trimmed)) {
			const lowerQuery = trimmed.toLowerCase();
			const prioritized = [...dirty, ...recentList];
			for (const relPath of prioritized) {
				const normalized = relPath.replaceAll("\\", "/");
				if (seen.has(normalized)) continue;
				if (lowerQuery && !subsequenceMatch(lowerQuery, normalized.toLowerCase())) continue;
				seen.add(normalized);
				const baseName = path.posix.basename(normalized);
				items.push(
					buildFileItem(normalized, {
						isDirectory: false,
						quoted: Boolean(q.quoted),
						tier: classifyFileTier(trimmed, normalized, baseName),
						dirty: dirty.has(normalized),
						recent: recentSet.has(normalized),
						lineSuffix: q.fileLineSuffix,
					}),
				);
				if (items.length >= MAX_FILE_ITEMS) break;
			}
		}

		// Consult cached directory entries synchronously if warm.
		const target = this.#resolveDirListingTarget(trimmed);
		const cachedDir = this.#dirCache.get(target.searchDir);
		if (cachedDir && Date.now() - cachedDir.at < DIR_CACHE_TTL_MS) {
			const dirItems = this.#itemsFromDirEntries(
				cachedDir.entries,
				target.displayDir,
				target.searchPrefix,
				q,
				dirty,
				recentSet,
			);
			for (const item of dirItems) {
				if (seen.has(item.pickerItem.id)) continue;
				seen.add(item.pickerItem.id);
				items.push(item);
				if (items.length >= MAX_FILE_ITEMS) break;
			}
		} else if (trimmed === "") {
			// Kick off root dir warm so the next frame has full entries.
			void this.#readDirCached(base);
		}

		// Filter rolling fuzzy pool synchronously so refining `@c` -> `@co` -> `@com` (or Backspace)
		// keeps deep workspace files visible immediately on frame 0 without flashing.
		if (trimmed && !this.#isOutsideCwd(trimmed) && this.#recentFuzzyPool.size > 0 && items.length < MAX_FILE_ITEMS) {
			const lowerQuery = trimmed.toLowerCase();
			for (const entry of this.#recentFuzzyPool.values()) {
				const id = `file:${entry.isDirectory ? `${entry.displayPath}/` : entry.displayPath}`;
				if (seen.has(id)) continue;
				if (!subsequenceMatch(lowerQuery, entry.displayPath.toLowerCase())) continue;
				seen.add(id);
				const baseName = path.posix.basename(entry.displayPath);
				items.push(
					buildFileItem(entry.displayPath, {
						isDirectory: entry.isDirectory,
						quoted: Boolean(q.quoted),
						tier: classifyFileTier(trimmed, entry.displayPath, baseName),
						dirty: dirty.has(entry.displayPath),
						recent: recentSet.has(entry.displayPath),
						lineSuffix: q.fileLineSuffix,
					}),
				);
				if (items.length >= MAX_FILE_ITEMS) break;
			}
		}

		items.sort((a, b) => a.tier - b.tier);
		const bestTier = items.reduce<MatchTier>((best, item) => (item.tier < best ? item.tier : best), MATCH_TIER.None);
		const needsAsync = trimmed.length > 0 || cachedDir === undefined || Date.now() - cachedDir.at >= DIR_CACHE_TTL_MS;

		return {
			category: "files",
			items,
			bestTier,
			total: items.length,
			loading: needsAsync,
			available: true,
		};
	}

	async queryAsync(
		q: MentionQuery,
		signal: AbortSignal,
		onPartial: (result: MentionSourceResult) => void,
	): Promise<MentionSourceResult | null> {
		if (signal.aborted) return null;
		const base = this.#host.getBasePath();
		const dirty = this.#host.dirtyFiles?.() ?? new Set<string>();
		const recentSet = new Set(this.#host.recentFiles?.() ?? []);
		const trimmed = q.query.trim();

		// Bare query or outside cwd: instant directory listing (no recursive fuzzy walk).
		if (!trimmed || this.#isOutsideCwd(trimmed)) {
			const target = this.#resolveDirListingTarget(trimmed);
			const entries = await this.#readDirCached(target.searchDir);
			if (signal.aborted) return null;
			const dirItems = this.#itemsFromDirEntries(
				entries,
				target.displayDir,
				target.searchPrefix,
				q,
				dirty,
				recentSet,
			);
			const syncBase = !trimmed ? this.querySync(q).items : [];
			const seen = new Set<string>();
			const merged: MentionItem[] = [];
			for (const item of [...syncBase, ...dirItems]) {
				if (seen.has(item.pickerItem.id)) continue;
				seen.add(item.pickerItem.id);
				merged.push(item);
				if (merged.length >= MAX_FILE_ITEMS) break;
			}
			const bestTier = merged.reduce<MatchTier>(
				(best, item) => (item.tier < best ? item.tier : best),
				MATCH_TIER.None,
			);
			return {
				category: "files",
				items: merged,
				bestTier,
				total: Math.max(merged.length, entries.length),
				loading: false,
				available: true,
			};
		}

		// Scoped fuzzy search when a directory prefix exists (`src/comp`).
		let searchPath = base;
		let fuzzyQuery = trimmed;
		let displayBase = "";
		const lastSlash = trimmed.lastIndexOf("/");
		if (lastSlash > 0) {
			const candidateBase = trimmed.slice(0, lastSlash + 1);
			const candidateDir = path.join(base, candidateBase);
			try {
				if ((await fs.promises.stat(candidateDir)).isDirectory()) {
					searchPath = candidateDir;
					displayBase = candidateBase;
					fuzzyQuery = trimmed.slice(lastSlash + 1);
				}
			} catch {
				// Keep workspace root as searchPath.
			}
		}
		if (signal.aborted) return null;

		const fuzzyPromise = fuzzyFind({
			query: fuzzyQuery,
			path: searchPath,
			maxResults: 60,
			hidden: true,
			gitignore: true,
			cache: true,
			timeoutMs: FUZZY_TIMEOUT_MS,
			signal,
		}).catch(() => ({ matches: [] as Array<{ path: string; isDirectory: boolean }> }));

		// If fuzzyFind takes longer than PARTIAL_DELAY_MS, report immediate directory matches first.
		const settledFast = await Promise.race([
			fuzzyPromise.then(() => true),
			Bun.sleep(PARTIAL_DELAY_MS).then(() => false),
		]);
		if (!settledFast && !signal.aborted) {
			const target = this.#resolveDirListingTarget(trimmed);
			const entries = await this.#readDirCached(target.searchDir);
			if (!signal.aborted && entries.length > 0) {
				const interim = this.#itemsFromDirEntries(
					entries,
					target.displayDir,
					target.searchPrefix,
					q,
					dirty,
					recentSet,
				);
				if (interim.length > 0) {
					onPartial({
						category: "files",
						items: interim,
						bestTier: interim.reduce<MatchTier>((b, i) => (i.tier < b ? i.tier : b), MATCH_TIER.None),
						total: interim.length,
						loading: true,
						available: true,
					});
				}
			}
		}

		const result = await fuzzyPromise;
		if (signal.aborted) return null;

		const lowerFuzzy = fuzzyQuery.toLowerCase();
		const items: MentionItem[] = [];
		const seen = new Set<string>();
		for (const entry of result.matches) {
			const rawPath = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
			const normalized = rawPath.replaceAll("\\", "/");
			if (/(^|\/)\.git(\/|$)/.test(normalized)) continue;
			if (lowerFuzzy && !subsequenceMatch(lowerFuzzy, normalized.toLowerCase())) continue;
			const displayPath = displayBase ? `${displayBase}${normalized}` : normalized;
			if (seen.has(displayPath)) continue;
			seen.add(displayPath);
			this.#recentFuzzyPool.delete(displayPath);
			this.#recentFuzzyPool.set(displayPath, { displayPath, isDirectory: entry.isDirectory });
			if (this.#recentFuzzyPool.size > 120) {
				const oldest = this.#recentFuzzyPool.keys().next().value;
				if (oldest !== undefined) this.#recentFuzzyPool.delete(oldest);
			}
			const baseName = path.posix.basename(displayPath);
			items.push(
				buildFileItem(displayPath, {
					isDirectory: entry.isDirectory,
					quoted: Boolean(q.quoted),
					tier: classifyFileTier(trimmed, displayPath, baseName),
					dirty: dirty.has(displayPath),
					recent: recentSet.has(displayPath),
					lineSuffix: q.fileLineSuffix,
				}),
			);
			if (items.length >= MAX_FILE_ITEMS) break;
		}

		// Fallback to immediate directory listing if fuzzy returned nothing (e.g. dotfile or exact dir).
		if (items.length === 0) {
			const target = this.#resolveDirListingTarget(trimmed);
			const entries = await this.#readDirCached(target.searchDir);
			if (signal.aborted) return null;
			items.push(...this.#itemsFromDirEntries(entries, target.displayDir, target.searchPrefix, q, dirty, recentSet));
		}

		// Re-sort so exact/strong + dirty files stay near the top while keeping fuzzyFind order on ties.
		items.sort((a, b) => {
			if (a.tier !== b.tier) return a.tier - b.tier;
			const aBoost = a.state === "dirty" ? 0 : a.state === "recent" ? 1 : 2;
			const bBoost = b.state === "dirty" ? 0 : b.state === "recent" ? 1 : 2;
			return aBoost - bBoost;
		});

		const bestTier = items.reduce<MatchTier>((best, item) => (item.tier < best ? item.tier : best), MATCH_TIER.None);
		return {
			category: "files",
			items,
			bestTier,
			total: Math.max(items.length, result.matches.length),
			loading: false,
			available: true,
		};
	}
}
