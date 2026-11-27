/**
 * Source resolver for marketplace plugin entries.
 *
 * Resolves plugin sources to absolute local directory paths:
 *   - Relative string "./plugins/foo" → path within marketplace clone
 *   - Bare name "foo" → `metadata.pluginRoot`/foo within marketplace clone
 *   - { source: "url", url: "https://...git" } → git clone
 *   - { source: "github", repo: "owner/repo" } → git clone from GitHub
 *   - { source: "git-subdir", url: "...", path: "sub/dir" } → git clone + subdir
 *   - { source: "npm", ... } → not yet supported
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { directoryExists, directoryIsMissing, pathIsWithin } from "@oh-my-pi/pi-utils";

import {
	isBarePluginSourceName,
	type MarketplaceCatalogMetadata,
	type MarketplacePluginEntry,
	type PluginSource,
} from "./types";

const GIT_CLONE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ResolveContext {
	/** Absolute path to the cloned/local marketplace directory. Required for relative sources. */
	marketplaceClonePath?: string;
	catalogMetadata?: MarketplaceCatalogMetadata;
	/** Scratch directory for sources that require cloning or extraction. */
	tmpDir: string;
}

/**
 * Resolve a plugin source to an absolute local directory path.
 *
 * The resolved path is verified to exist on disk.
 */
export async function resolvePluginSource(
	entry: MarketplacePluginEntry,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	const { source } = entry;

	if (typeof source === "string") {
		return { dir: await resolveRelativeSourceDir(source, context) };
	}

	return resolveObjectSource(source, context);
}

/**
 * Validate source constraints that can be checked without cloning or mutating files.
 */
export async function validatePluginSource(
	entry: MarketplacePluginEntry,
	context: Pick<ResolveContext, "marketplaceClonePath" | "catalogMetadata">,
): Promise<string | undefined> {
	const { source } = entry;
	if (typeof source === "string") {
		return resolveRelativeSourceDir(source, context);
	}

	switch (source.source) {
		case "url":
		case "github":
			return undefined;
		case "git-subdir": {
			const syntheticRoot = path.join(path.parse(process.cwd()).root, "omp-marketplace-validation");
			const resolved = path.resolve(syntheticRoot, source.path);
			if (!pathIsWithin(syntheticRoot, resolved)) {
				throw new Error(`git-subdir path "${source.path}" escapes the cloned repository`);
			}
			return undefined;
		}
		case "npm":
			throw new Error("npm plugin sources are not yet supported. Use git-based sources instead.");
		default: {
			const unknownSource: unknown = source;
			if (
				unknownSource &&
				typeof unknownSource === "object" &&
				"source" in unknownSource &&
				typeof unknownSource.source === "string"
			) {
				throw new Error(`Unknown plugin source type: "${unknownSource.source}"`);
			}
			throw new Error("Unknown plugin source type");
		}
	}
}

// ── String sources ─────────────────────────────────────────────────

function resolveRelativeSourcePath(
	source: string,
	context: Pick<ResolveContext, "marketplaceClonePath" | "catalogMetadata">,
): string {
	const pluginRoot = context.catalogMetadata?.pluginRoot;
	let relativePath: string;
	if (source.startsWith("./")) {
		relativePath = source;
	} else if (pluginRoot && isBarePluginSourceName(source)) {
		relativePath = path.join(pluginRoot, source);
	} else {
		throw new Error(
			`Relative plugin source paths must start with "./", or be a bare name under metadata.pluginRoot — got: "${source}"`,
		);
	}
	return resolveInsideMarketplace(relativePath, source, context);
}

function resolveInsideMarketplace(
	relativePath: string,
	source: string,
	context: Pick<ResolveContext, "marketplaceClonePath">,
): string {
	if (!context.marketplaceClonePath) {
		throw new Error(`Cannot resolve relative source "${source}": marketplaceClonePath is required`);
	}

	const resolved = path.resolve(context.marketplaceClonePath, relativePath);
	// The path may not exist yet, and the marketplace root may sit behind a symlink.
	if (!pathIsWithin(context.marketplaceClonePath, resolved, { throughMissing: true })) {
		throw new Error(
			`Plugin source "${source}" resolves outside marketplace root ("${context.marketplaceClonePath}")`,
		);
	}
	return resolved;
}

async function resolveRelativeSourceDir(
	source: string,
	context: Pick<ResolveContext, "marketplaceClonePath" | "catalogMetadata">,
): Promise<string> {
	const resolved = resolveRelativeSourcePath(source, context);
	if (await directoryExists(resolved, { strict: true })) return resolved;
	// Catalogs written for omp's earlier rule (`./foo` meaning `<pluginRoot>/foo`) keep installing.
	const pluginRoot = context.catalogMetadata?.pluginRoot;
	if (pluginRoot && source.startsWith("./")) {
		const legacy = resolveInsideMarketplace(path.join(pluginRoot, source), source, context);
		if (await directoryExists(legacy, { strict: true })) return legacy;
	}
	throw new Error(`Plugin source directory does not exist: "${resolved}"`);
}

// ── Object source variants ──────────────────────────────────────────

async function resolveObjectSource(
	source: Exclude<PluginSource, string>,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	switch (source.source) {
		case "url": {
			// { source: "url", url: "https://github.com/owner/repo.git" }
			// Despite the name, this is typically a git clone URL
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await vcs.clone(source.url, targetDir, {
				refName: source.ref,
				sha: source.sha,
				timeoutMs: GIT_CLONE_TIMEOUT_MS,
			});
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "github": {
			// { source: "github", repo: "owner/repo" }
			const url = `https://github.com/${source.repo}.git`;
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await vcs.clone(url, targetDir, {
				refName: source.ref,
				sha: source.sha,
				timeoutMs: GIT_CLONE_TIMEOUT_MS,
			});
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "git-subdir": {
			// { source: "git-subdir", url: "owner/repo" | "https://...", path: "plugins/foo" }
			const url =
				source.url.includes("://") || source.url.startsWith("git@")
					? source.url
					: `https://github.com/${source.url}.git`;
			const cloneDir = path.join(context.tmpDir, `plugin-repo-${crypto.randomUUID()}`);
			await vcs.clone(url, cloneDir, {
				refName: source.ref,
				sha: source.sha,
				timeoutMs: GIT_CLONE_TIMEOUT_MS,
			});

			const subdirPath = path.resolve(cloneDir, source.path);
			if (!pathIsWithin(cloneDir, subdirPath, { throughMissing: true })) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw new Error(`git-subdir path "${source.path}" escapes the cloned repository`);
			}
			try {
				if (await directoryIsMissing(subdirPath, { strict: true })) {
					throw new Error(`git-subdir path "${source.path}" does not exist in cloned repository`);
				}
			} catch (err) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw err;
			}
			return { dir: subdirPath, tempCloneRoot: cloneDir };
		}

		case "npm":
			throw new Error("npm plugin sources are not yet supported. Use git-based sources instead.");

		default:
			throw new Error(`Unknown plugin source type: "${(source as { source: string }).source}"`);
	}
}
