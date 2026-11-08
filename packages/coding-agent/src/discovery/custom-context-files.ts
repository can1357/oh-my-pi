/**
 * User-configured extra context filenames (`contextFiles.extra`).
 *
 * Built-in providers only discover fixed names and keep one file per scope.
 * These names are additive: AGENTS.local.md loads beside AGENTS.md instead of
 * taking its slot. A linked worktree also reads each name from the primary
 * checkout, which the normal walk never reaches.
 */
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { boundSettings, registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import type { LoadContext, LoadResult } from "../capability/types";
import { cfgContextFilesExtra } from "../session/context-settings";
import { calculateDepth, createSourceMeta, loadStandaloneContextFiles } from "./helpers";

const PROVIDER_ID = "custom-context";
const DISPLAY_NAME = "Custom context files";

interface ConfiguredNames {
	names: string[];
	/**
	 * Whether names may be read from the user agent directory. Not when a project
	 * config supplied the list: a repository must not pull files such as
	 * `config.yml` from `~/.omp/agent` into the prompt.
	 */
	includeAgentDir: boolean;
}

/** Trimmed, de-duplicated names; `cfgContextFilesExtra.validate` already rejected paths and built-in names. */
function configuredNames(): ConfiguredNames {
	const settings = boundSettings();
	if (!settings) return { names: [], includeAgentDir: false };
	const names = [...new Set(cfgContextFilesExtra.get(settings).map(entry => entry.trim()))];
	return { names, includeAgentDir: cfgContextFilesExtra.provenance(settings) !== "project" };
}

function pushFile(items: ContextFile[], seen: Set<string>, file: ContextFile): void {
	const resolved = path.resolve(file.path);
	if (seen.has(resolved)) return;
	seen.add(resolved);
	file.additive = true;
	items.push(file);
}

/** Depth used only to order a non-ancestor primary checkout behind the worktree's own files. */
function primaryDepth(ctx: LoadContext, primary: string): number {
	const cwd = path.resolve(ctx.cwd);
	const dir = path.resolve(primary);
	const relative = path.relative(dir, cwd);
	if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
		return calculateDepth(cwd, dir, path.sep);
	}
	const walkRoot = ctx.repoRoot ? path.resolve(ctx.repoRoot) : cwd;
	return calculateDepth(cwd, walkRoot, path.sep) + 1;
}

export async function loadCustomContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const { names, includeAgentDir } = configuredNames();
	if (names.length === 0) return { items: [], warnings: [] };

	const items: ContextFile[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();

	for (const name of names) {
		const loaded = await loadStandaloneContextFiles(ctx, PROVIDER_ID, name);
		if (loaded.warnings) warnings.push(...loaded.warnings);
		for (const item of loaded.items) pushFile(items, seen, item);
	}

	const linked = vcs.git(ctx.cwd)?.linkedWorktree();
	const primary = linked ? path.resolve(linked.primaryRoot) : undefined;
	const walkRoot = ctx.repoRoot ? path.resolve(ctx.repoRoot) : undefined;
	if (primary !== undefined && primary !== walkRoot) {
		const depth = primaryDepth(ctx, primary);
		for (const name of names) {
			const candidate = path.join(primary, name);
			const content = await readFile(candidate);
			if (!content) continue;
			pushFile(items, seen, {
				path: candidate,
				content,
				level: "project",
				depth,
				additive: true,
				_source: createSourceMeta(PROVIDER_ID, candidate, "project"),
			});
		}
	}

	if (includeAgentDir) {
		const agentDir = ctx.agentDir ?? getAgentDir();
		for (const name of names) {
			const candidate = path.join(agentDir, name);
			const content = await readFile(candidate);
			if (!content) continue;
			pushFile(items, seen, {
				path: candidate,
				content,
				level: "user",
				additive: true,
				_source: createSourceMeta(PROVIDER_ID, candidate, "user"),
			});
		}
	}

	return { items, warnings };
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Extra context filenames from contextFiles.extra (additive; does not replace AGENTS.md)",
	priority: 9,
	load: loadCustomContextFiles,
});
