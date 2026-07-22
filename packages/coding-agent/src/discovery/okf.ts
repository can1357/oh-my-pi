/**
 * Open Knowledge Format (OKF) Discovery Provider
 *
 * Loads OKF v0.1 concept documents from the project's `.wiki/` knowledge bundle
 * (the `oh-my-pi` OKF root). The user-level equivalent lives under
 * `~/.ompk/okf/`.
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { OKF_VERSION, type OkfConcept, okfCapability } from "../capability/okf";
import type { LoadContext, LoadResult } from "../capability/types";
import { parseOkfConcept } from "../okf/parser";
import { loadFilesFromDir } from "./helpers";

const PROVIDER_ID = "okf";
const DISPLAY_NAME = "OKF Knowledge Bundle";
const DESCRIPTION = "Load Open Knowledge Format (OKF) v0.1 concept documents from the project's `.wiki/`";
const PRIORITY = 90;

const PROJECT_BUNDLE_DIRNAME = ".wiki";
const USER_BUNDLE_DIRNAME = path.join(".ompk", "okf");

/** User-level bundle root: `~/.ompk/okf`. */
function getUserBundlePath(ctx: LoadContext): string {
	return path.join(ctx.home, USER_BUNDLE_DIRNAME);
}

/**
 * Project-level bundle root: the `.wiki/` directory at the repoRoot, or at cwd
 * when no repoRoot was found. The actual existence check happens in the
 * underlying file loader (it short-circuits when the directory is missing).
 */
function getProjectBundlePath(ctx: LoadContext): string {
	return path.join(ctx.repoRoot ?? ctx.cwd, PROJECT_BUNDLE_DIRNAME);
}

async function loadBundle(
	ctx: LoadContext,
	bundleRoot: string,
	level: "user" | "project",
): Promise<{ items: OkfConcept[]; warnings: string[] }> {
	const items: OkfConcept[] = [];
	const warnings: string[] = [];
	const result = await loadFilesFromDir<OkfConcept>(ctx, bundleRoot, PROVIDER_ID, level, {
		extensions: ["md"],
		recursive: true,
		transform: (name, content, filePath, source) => {
			const relativePath = path.relative(bundleRoot, filePath).split(path.sep).join("/");
			const parsed = parseOkfConcept(content, { bundleRoot, relativePath, source });
			if ("error" in parsed) {
				warnings.push(`[${name}] ${parsed.error}`);
				return null;
			}
			return parsed.concept;
		},
	});
	items.push(...result.items);
	if (result.warnings) warnings.push(...result.warnings);
	return { items, warnings };
}

export async function loadOkfConcepts(ctx: LoadContext): Promise<LoadResult<OkfConcept>> {
	const allItems: OkfConcept[] = [];
	const allWarnings: string[] = [];

	const projectBundle = getProjectBundlePath(ctx);
	const userBundle = getUserBundlePath(ctx);

	const [project, user] = await Promise.all([
		loadBundle(ctx, projectBundle, "project"),
		loadBundle(ctx, userBundle, "user"),
	]);
	allItems.push(...project.items, ...user.items);
	allWarnings.push(...project.warnings, ...user.warnings);

	// Deduplicate by `${bundleRoot}::${id}`. Project wins on id collision within
	// the same bundle root because we iterate project-first.
	const seen = new Map<string, OkfConcept>();
	const deduped: OkfConcept[] = [];
	for (const item of allItems) {
		const key = `${item.bundleRoot}::${item.id}`;
		if (!seen.has(key)) {
			seen.set(key, item);
			deduped.push(item);
		}
	}

	return { items: deduped, warnings: allWarnings };
}

registerProvider<OkfConcept>(okfCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadOkfConcepts,
});

export { getProjectBundlePath, getUserBundlePath, OKF_VERSION };
