/**
 * Source resolver for marketplace plugin entries.
 *
 * Resolves plugin sources to absolute local directory paths:
 *   - Relative string "./plugins/foo" → path within marketplace clone
 *   - { source: "url", url: "https://...git" } → git clone
 *   - { source: "github", repo: "owner/repo" } → git clone from GitHub
 *   - { source: "git-subdir", url: "...", path: "sub/dir" } → git clone + subdir
 *   - { source: "npm", ... } → not yet supported
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, pathIsWithin } from "@oh-my-pi/pi-utils";

import type { MarketplaceCatalogMetadata, MarketplacePluginEntry, PluginSource } from "./types";

const GIT_CLONE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ResolveContext {
	/** Absolute path to the cloned/local marketplace directory. Required for relative sources. */
	marketplaceClonePath?: string;
	/** Catalog metadata — used for `pluginRoot` prepend. */
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
		return resolveRelativeSource(source, context);
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
		const resolved = resolveRelativeSourcePath(source, context);
		await verifyDirExists(resolved, `Plugin source directory does not exist: "${resolved}"`);
		return resolved;
	}

	switch (source.source) {
		case "url":
		case "github":
			return undefined;
		case "git-subdir": {
			const syntheticRoot = path.join(path.parse(process.cwd()).root, "omp-marketplace-validation");
			const resolved = path.resolve(syntheticRoot, source.path);
			if (!pathIsWithin(syntheticRoot, resolved)) {
				throw new Error(__ompTranslate('git-subdir path "{0}" escapes the cloned repository', `${source.path}`));
			}
			return undefined;
		}
		case "npm":
			throw new Error(__ompTranslate("npm plugin sources are not yet supported. Use git-based sources instead."));
		default: {
			const unknownSource: unknown = source;
			if (
				unknownSource &&
				typeof unknownSource === "object" &&
				"source" in unknownSource &&
				typeof unknownSource.source === "string"
			) {
				throw new Error(__ompTranslate('Unknown plugin source type: "{0}"', `${unknownSource.source}`));
			}
			throw new Error(__ompTranslate("Unknown plugin source type"));
		}
	}
}

// ── Relative string source ("./plugins/foo") ────────────────────────

function resolveRelativeSourcePath(
	source: string,
	context: Pick<ResolveContext, "marketplaceClonePath" | "catalogMetadata">,
): string {
	if (!source.startsWith("./")) {
		throw new Error(__ompTranslate('Relative plugin source paths must start with "./" — got: "{0}"', `${source}`));
	}
	if (!context.marketplaceClonePath) {
		throw new Error(
			__ompTranslate('Cannot resolve relative source "{0}": marketplaceClonePath is required', `${source}`),
		);
	}

	const pluginRoot = context.catalogMetadata?.pluginRoot;
	const relativePath = pluginRoot ? `./${path.join(pluginRoot, source.slice(2))}` : source;
	const resolved = path.resolve(context.marketplaceClonePath, relativePath);
	if (!pathIsWithin(context.marketplaceClonePath, resolved)) {
		throw new Error(
			`Plugin source "${source}" resolves outside marketplace root ("${context.marketplaceClonePath}")`,
		);
	}
	return resolved;
}

async function resolveRelativeSource(
	source: string,
	context: ResolveContext,
): Promise<{ dir: string; tempCloneRoot?: string }> {
	const resolved = resolveRelativeSourcePath(source, context);
	await verifyDirExists(resolved, `Plugin source directory does not exist: "${resolved}"`);
	return { dir: resolved };
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
			if (!pathIsWithin(cloneDir, subdirPath)) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw new Error(__ompTranslate('git-subdir path "{0}" escapes the cloned repository', `${source.path}`));
			}
			try {
				await verifyDirExists(
					subdirPath,
					__ompTranslate('git-subdir path "{0}" does not exist in cloned repository', `${source.path}`),
				);
			} catch (err) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw err;
			}
			return { dir: subdirPath, tempCloneRoot: cloneDir };
		}

		case "npm":
			throw new Error(__ompTranslate("npm plugin sources are not yet supported. Use git-based sources instead."));

		default:
			throw new Error(
				__ompTranslate('Unknown plugin source type: "{0}"', `${(source as { source: string }).source}`),
			);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

async function verifyDirExists(dirPath: string, errorMessage: string): Promise<void> {
	try {
		const stat = await fs.stat(dirPath);
		if (!stat.isDirectory()) {
			throw new Error(errorMessage);
		}
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(errorMessage);
		}
		throw err;
	}
}
