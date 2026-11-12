/**
 * Live reload of custom tools and skills.
 *
 * {@link CustomToolsRefreshSummary} is what one custom-tool refresh changed and
 * {@link describeCustomToolsRefresh} is its user-visible report. {@link createToolsHotReloadSubsystem}
 * and {@link createSkillsHotReloadSubsystem} register custom tools and skills on a
 * {@link HotReloadCoordinator}.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { CustomToolsRefreshOptions } from "../extensibility/custom-tools/types";
import type { HotReloadSubsystem } from "./hot-reload";

/** Names changed by one custom-tool refresh, plus the modules that could not be loaded. */
export interface CustomToolsRefreshSummary {
	added: string[];
	replaced: string[];
	removed: string[];
	errors: Array<{ path: string; error: string }>;
}

/** Re-reads the custom tool sources and applies the difference to the live session. */
export type CustomToolsRefresher = (options?: CustomToolsRefreshOptions) => Promise<CustomToolsRefreshSummary>;

export interface CustomToolsRefreshNotice {
	level: "info" | "warning";
	message: string;
}

/**
 * The status line for a refresh, e.g. `tools reloaded: +2 ~1 -0`, followed by one line per
 * failed module. `undefined` when nothing changed and nothing failed.
 */
export function describeCustomToolsRefresh(summary: CustomToolsRefreshSummary): CustomToolsRefreshNotice | undefined {
	const changed = summary.added.length + summary.replaced.length + summary.removed.length > 0;
	if (!changed && summary.errors.length === 0) return undefined;
	const counts = `+${summary.added.length} ~${summary.replaced.length} -${summary.removed.length}`;
	const failures = summary.errors.length > 0 ? `, ${summary.errors.length} failed` : "";
	const lines = [`tools ${changed ? "reloaded" : "unchanged"}: ${counts}${failures}`];
	for (const { path: modulePath, error } of summary.errors) lines.push(`  ${path.basename(modulePath)}: ${error}`);
	return {
		level: summary.errors.length > 0 ? "warning" : "info",
		message: lines.join("\n"),
	};
}

const SIGNATURE_MAX_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

/** Appends `relative:mtime:size` for `entryPath` and, when it is a directory, everything under it. */
async function collectSignature(root: string, entryPath: string, depth: number, into: string[]): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.stat(entryPath);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	into.push(`${path.relative(root, entryPath)}:${stat.mtimeMs}:${stat.size}`);
	if (!stat.isDirectory() || depth >= SIGNATURE_MAX_DEPTH) return;
	const names = await fs.readdir(entryPath);
	for (const name of names.sort()) {
		if (SKIPPED_DIRECTORIES.has(name)) continue;
		await collectSignature(root, path.join(entryPath, name), depth + 1, into);
	}
}

/**
 * A fingerprint of everything under `roots` (files, or directories down to a few levels) that
 * changes when any of it is added, edited, or removed. A missing or unreadable root counts as empty.
 */
export async function sourceSignature(roots: readonly string[]): Promise<string> {
	const parts: string[] = [];
	for (const root of roots) {
		parts.push(`@${root}`);
		try {
			await collectSignature(root, root, 0, parts);
		} catch {
			// Unreadable now; the signature changes when it becomes readable.
		}
	}
	return parts.join("\n");
}

const TOOLS_AND_SKILLS_DEFERRAL_GROUP = "tools-and-skills";
const TOOLS_AND_SKILLS_DEFERRED_MESSAGE = "tool or skill files changed; reload deferred until the current turn ends";

export function createToolsHotReloadSubsystem(options: {
	roots: () => readonly string[];
	enabled?: () => boolean;
	reload: () => Promise<void>;
}): HotReloadSubsystem {
	return {
		id: "tools",
		source: "tools",
		deferralGroup: TOOLS_AND_SKILLS_DEFERRAL_GROUP,
		enabled: options.enabled,
		signature: () => sourceSignature(options.roots()),
		reload: options.reload,
		deferredMessage: TOOLS_AND_SKILLS_DEFERRED_MESSAGE,
		errorPrefix: "tools hot reload failed",
	};
}

export function createSkillsHotReloadSubsystem(options: {
	roots: () => readonly string[];
	enabled?: () => boolean;
	reload: () => Promise<void>;
}): HotReloadSubsystem {
	return {
		id: "skills",
		source: "tools",
		deferralGroup: TOOLS_AND_SKILLS_DEFERRAL_GROUP,
		enabled: options.enabled,
		signature: () => sourceSignature(options.roots()),
		reload: options.reload,
		deferredMessage: TOOLS_AND_SKILLS_DEFERRED_MESSAGE,
		errorPrefix: "skills hot reload failed",
	};
}
