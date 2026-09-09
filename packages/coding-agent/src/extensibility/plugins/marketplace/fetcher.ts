/**
 * Marketplace catalog fetcher.
 *
 * Classifies a source string, resolves it, and loads the catalog.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

import { isValidNameSegment, type MarketplaceCatalog, type MarketplaceSourceType } from "./types";

const GIT_CLONE_TIMEOUT_MS = 30 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────

export interface FetchResult {
	catalog: MarketplaceCatalog;
	/** For git sources: path to the cloned marketplace directory. */
	clonePath?: string;
}

// ── classifySource ────────────────────────────────────────────────────

/**
 * Detects Windows-style absolute paths cross-platform:
 *   C:\path, C:/path  → drive-letter + colon + separator
 *   \\server\share    → UNC path
 *
 * Needed because path.isAbsolute("C:\...") returns false on POSIX.
 */
const WIN_ABS_RE = /^[A-Za-z]:[/\\]|^\\\\/;

/**
 * GitHub owner/repo shorthand: lowercase alphanumeric + hyphens/dots, one slash.
 * Must NOT start with a protocol — that is ruled out by earlier checks.
 */
const GITHUB_SHORTHAND_RE = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

/**
 * Classify a marketplace source string into one of the four source types.
 *
 * Rules are ordered; the first match wins. Protocol/pattern checks (rules 1-3)
 * run before any path.isAbsolute() check so that SCP-style git@ URLs are
 * never misclassified as local paths on Windows.
 *
 * @throws if the source format is unrecognized.
 */
export function classifySource(source: string): MarketplaceSourceType {
	// Rule 1: HTTP(S) URLs — .json suffix → url, everything else → git
	if (source.startsWith("https://") || source.startsWith("http://")) {
		try {
			const { pathname } = new URL(source);
			return pathname.endsWith(".json") ? "url" : "git";
		} catch {
			// Malformed URL — treat as git
			return "git";
		}
	}

	// Rule 2: SCP-style SSH git URLs
	if (source.startsWith("git@") || source.startsWith("ssh://")) {
		return "git";
	}

	// Rule 3: GitHub owner/repo shorthand (no protocol, no leading slash)
	if (GITHUB_SHORTHAND_RE.test(source)) {
		return "github";
	}

	// Rule 4: Explicit relative or home-relative paths
	if (source.startsWith("./") || source.startsWith("~/")) {
		return "local";
	}

	// Rule 5: Absolute paths — POSIX via path.isAbsolute, Windows via regex
	if (path.isAbsolute(source) || WIN_ABS_RE.test(source)) {
		return "local";
	}

	throw new Error(`Unrecognized source format. Did you mean './${source}' (local) or 'owner/repo' (GitHub)?`);
}

// ── parseMarketplaceCatalog ───────────────────────────────────────────

function assertField(condition: boolean, field: string, filePath: string): void {
	if (!condition) {
		throw new Error(`Missing or invalid field "${field}" in catalog: ${filePath}`);
	}
}

/**
 * Parse and validate a marketplace.json catalog from raw JSON content.
 *
 * Required fields: name (valid name segment), owner.name, plugins array.
 * Each plugin entry requires name (string) and source (string or object
 * with a "source" field). Extra fields are preserved via spread.
 *
 * @throws on JSON parse failure or missing/invalid required fields.
 */
export function parseMarketplaceCatalog(content: string, filePath: string): MarketplaceCatalog {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to parse marketplace catalog at ${filePath}: ${(err as Error).message}`);
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Marketplace catalog at ${filePath} must be a JSON object`);
	}

	const obj = raw as Record<string, unknown>;

	// name: required, must be a valid name segment
	assertField(typeof obj.name === "string" && isValidNameSegment(obj.name), "name", filePath);

	// owner: required object with name string
	assertField(typeof obj.owner === "object" && obj.owner !== null && !Array.isArray(obj.owner), "owner", filePath);
	const owner = obj.owner as Record<string, unknown>;
	assertField(typeof owner.name === "string", "owner.name", filePath);

	// plugins: required array
	assertField(Array.isArray(obj.plugins), "plugins", filePath);

	const plugins = obj.plugins as unknown[];
	const validPlugins: unknown[] = [];
	for (let i = 0; i < plugins.length; i++) {
		try {
			const entry = plugins[i];
			assertField(typeof entry === "object" && entry !== null && !Array.isArray(entry), `plugins[${i}]`, filePath);
			const p = entry as Record<string, unknown>;
			assertField(typeof p.name === "string" && isValidNameSegment(p.name), `plugins[${i}].name`, filePath);
			// source can be a string path or a typed object (github/url/git-subdir/npm)
			// all typed objects carry a "source" discriminant string field
			assertField(
				typeof p.source === "string" ||
					(typeof p.source === "object" &&
						p.source !== null &&
						!Array.isArray(p.source) &&
						typeof (p.source as Record<string, unknown>).source === "string"),
				`plugins[${i}].source`,
				filePath,
			);
			// String sources must be relative paths starting with "./"
			if (typeof p.source === "string") {
				assertField((p.source as string).startsWith("./"), `plugins[${i}].source (must start with "./")`, filePath);
			}
			// Validate required fields for typed source variants
			if (typeof p.source === "object" && p.source !== null) {
				const src = p.source as Record<string, unknown>;
				const variant = src.source as string;
				if (variant === "github") {
					assertField(typeof src.repo === "string" && src.repo.length > 0, `plugins[${i}].source.repo`, filePath);
				} else if (variant === "url" || variant === "git-subdir") {
					assertField(typeof src.url === "string" && src.url.length > 0, `plugins[${i}].source.url`, filePath);
					if (variant === "git-subdir") {
						assertField(
							typeof src.path === "string" && src.path.length > 0,
							`plugins[${i}].source.path`,
							filePath,
						);
					}
				} else if (variant === "npm") {
					assertField(
						typeof src.package === "string" && src.package.length > 0,
						`plugins[${i}].source.package`,
						filePath,
					);
				} else {
					assertField(false, `plugins[${i}].source.source (unknown variant: "${variant}")`, filePath);
				}
			}
			validPlugins.push(entry);
		} catch (err) {
			// Warn and skip invalid plugin entries instead of failing the entire catalog.
			// This lets the rest of the marketplace load even if one entry has a bad name/source.
			const name =
				typeof plugins[i] === "object" && plugins[i] !== null
					? ((plugins[i] as Record<string, unknown>).name ?? `[${i}]`)
					: `[${i}]`;
			logger.warn(`Skipping invalid plugin ${name}: ${(err as Error).message}`);
		}
	}
	// Replace the plugins array with only valid entries
	obj.plugins = validPlugins;

	// Extra fields are preserved — cast through unknown for type safety
	return obj as unknown as MarketplaceCatalog;
}

// ── fetchMarketplace ──────────────────────────────────────────────────

/**
 * Catalog paths tried in priority order: omp-namespaced override first, then
 * the Claude Code-compatible fallback so existing marketplaces keep loading.
 */
const CATALOG_RELATIVE_PATHS: readonly string[] = [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"];

async function readMarketplaceCatalog(
	root: string,
	options: { relativeDisplayPaths?: boolean } = {},
): Promise<{ catalogPath: string; displayPath: string; content: string }> {
	const tried: string[] = [];
	for (const rel of CATALOG_RELATIVE_PATHS) {
		const catalogPath = path.join(root, ...rel.split("/"));
		const displayPath = options.relativeDisplayPaths ? rel : catalogPath;
		tried.push(displayPath);
		try {
			const content = await Bun.file(catalogPath).text();
			return { catalogPath, displayPath, content };
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
	}
	throw new Error(
		`Marketplace catalog not found at ${tried.map(p => `"${p}"`).join(" or ")}. ` +
			`Ensure the directory exists and contains one of: ${CATALOG_RELATIVE_PATHS.join(", ")}.`,
	);
}

/**
 * Expand a `~/...` path to an absolute path using os.homedir().
 * Other paths are returned unchanged.
 */
function expandHome(p: string): string {
	if (p.startsWith("~/")) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

/**
 * Fetch a marketplace catalog from a source.
 *
 * Dispatches on the source type: local filesystem paths are read directly;
 * GitHub/git sources are cloned with `git`; URL sources are fetched over HTTP.
 *
 * @param source   Source identifier: path, GitHub shorthand, git URL, or HTTP URL.
 * @param cacheDir Cache directory root for non-local sources.
 */
export async function fetchMarketplace(source: string, cacheDir: string): Promise<FetchResult> {
	const type = classifySource(source);

	if (type === "local") {
		const resolved = path.resolve(expandHome(source));
		const { catalogPath, content } = await readMarketplaceCatalog(resolved);
		const catalog = parseMarketplaceCatalog(content, catalogPath);
		return { catalog };
	}

	if (type === "github") {
		const url = `https://github.com/${source}.git`;
		return cloneAndReadCatalog(url, source, cacheDir);
	}

	if (type === "git") {
		return cloneAndReadCatalog(source, source, cacheDir);
	}

	// type === "url"
	const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) {
		throw new Error(
			`Failed to fetch marketplace catalog from ${source}: HTTP ${response.status} ${response.statusText}`,
		);
	}
	const text = await response.text();
	const catalog = parseMarketplaceCatalog(text, source);

	const catalogDir = path.join(cacheDir, catalog.name);
	await Bun.write(path.join(catalogDir, "marketplace.json"), text);

	return { catalog };
}

// ── cloneAndReadCatalog ───────────────────────────────────────────────

/**
 * Clone a git repository and read its marketplace catalog.
 *
 * Clones to a temporary directory and reads the catalog. The caller is
 * responsible for promoting the clone to its final cache location via
 * `promoteCloneToCache` after any duplicate/drift checks pass.
 */
async function cloneAndReadCatalog(url: string, source: string, cacheDir: string): Promise<FetchResult> {
	const tmpDir = path.join(cacheDir, `.tmp-clone-${Date.now()}`);
	await fs.mkdir(cacheDir, { recursive: true });

	logger.debug(`[marketplace] cloning ${url} → ${tmpDir}`);
	await vcs.clone(url, tmpDir, { timeoutMs: GIT_CLONE_TIMEOUT_MS });

	try {
		const { displayPath, content } = await readMarketplaceCatalog(tmpDir, { relativeDisplayPaths: true });
		const catalog = parseMarketplaceCatalog(content, displayPath);
		return { catalog, clonePath: tmpDir };
	} catch (err) {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		throw new Error(`Cloned repository ${url}: ${(err as Error).message} (source: ${source})`, { cause: err });
	}
}

/**
 * Promote a temporary clone directory to its final cache location.
 *
 * Callers should invoke this only after duplicate/drift checks pass.
 * Removes any existing directory at the target path before renaming.
 */
export async function promoteCloneToCache(tmpDir: string, cacheDir: string, name: string): Promise<string> {
	const finalDir = path.join(cacheDir, name);
	await fs.rm(finalDir, { recursive: true, force: true });
	await fs.rename(tmpDir, finalDir);
	return finalDir;
}
