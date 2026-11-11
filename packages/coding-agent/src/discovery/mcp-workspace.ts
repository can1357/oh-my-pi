import * as path from "node:path";
import {
	getAgentDir,
	getConfigDirName,
	getPluginsDir,
	isRecord,
	normalizePathForComparison,
	pathIsWithin,
} from "@oh-my-pi/pi-utils";
import { boundSettings } from "../capability";
import type { LoadContext } from "../capability/types";
import { cfgMcpWorkspaceRoots } from "../mcp/settings";
import { realpathIfExists, resolveContainedPath } from "./contained-path";
import { getProjectDiscoveryCeilings, isUserConfigRoot } from "./helpers";

interface MCPWorkspace {
	root: string;
	cwd: string;
}

const workspaces = new WeakMap<LoadContext, Promise<MCPWorkspace | null>>();

/** Only the owning active-profile user layer can grant workspace inheritance. */
async function resolveWorkspace(ctx: LoadContext): Promise<MCPWorkspace | null> {
	let settings = ctx.settings === undefined ? boundSettings() : ctx.settings;
	if (!settings) return null;
	while (settings.overlayParent()) settings = settings.overlayParent()!;
	let roots: unknown = settings.getGlobalSettings();
	for (const segment of cfgMcpWorkspaceRoots.segments) roots = isRecord(roots) ? roots[segment] : undefined;
	if (!Array.isArray(roots) || roots.length === 0) return null;

	const cwd = await realpathIfExists(ctx.cwd);
	if (!cwd) return null;
	const ceilings = new Set(getProjectDiscoveryCeilings());
	ceilings.add(normalizePathForComparison(ctx.home));
	for (const ceiling of [...ceilings]) {
		const real = await realpathIfExists(ceiling);
		if (real) ceilings.add(normalizePathForComparison(real));
	}
	const userDirs = [
		path.join(ctx.home, getConfigDirName()),
		path.dirname(getPluginsDir()),
		getAgentDir(),
		settings.getAgentDir(),
	];
	if (ctx.agentDir) userDirs.push(ctx.agentDir);
	for (const dir of [...userDirs]) {
		const real = await realpathIfExists(dir);
		if (real) userDirs.push(real);
	}
	if (userDirs.some(dir => pathIsWithin(dir, cwd))) return null;
	const ceilingPaths = [...ceilings];

	let selected: MCPWorkspace | null = null;
	for (const configured of roots) {
		if (typeof configured !== "string") continue;
		// Never turn a relative grant (including bare ~ or ~other) into cwd authority.
		const expanded = configured.startsWith("~/") ? path.join(ctx.home, configured.slice(2)) : configured;
		if (!path.isAbsolute(expanded)) continue;
		const root = await realpathIfExists(expanded);
		if (!root || !pathIsWithin(root, cwd)) continue;
		if (normalizePathForComparison(root) === normalizePathForComparison(path.parse(root).root)) continue;
		if (ceilingPaths.some(ceiling => pathIsWithin(root, ceiling))) continue;
		if (isUserConfigRoot(root) || userDirs.some(dir => pathIsWithin(dir, root))) continue;
		if (!selected || pathIsWithin(selected.root, root)) selected = { root, cwd };
	}
	return selected;
}

/**
 * Native and standalone MCP files, closest directory first and mcp.json before
 * .mcp.json. No trusted workspace retains the literal-cwd discovery baseline.
 * Only access paths are canonicalized; server commands, args and cwd are untouched.
 */
export async function getMCPProjectConfigPaths(
	ctx: LoadContext,
	configDir?: string,
): Promise<Array<{ path: string; readPath: string }>> {
	let workspace = workspaces.get(ctx);
	if (!workspace) {
		workspace = resolveWorkspace(ctx);
		workspaces.set(ctx, workspace);
	}
	const selected = await workspace;
	const paths: Array<{ path: string; readPath: string }> = [];
	let dir = selected?.cwd ?? ctx.cwd;
	while (true) {
		const configPath = configDir ? path.join(dir, configDir) : dir;
		const containedDir = selected ? await resolveContainedPath(selected.root, configPath) : null;
		for (const filename of ["mcp.json", ".mcp.json"]) {
			if (containedDir && containedDir.status !== "ok") continue;
			const file = configDir ? path.join(dir, configDir, filename) : path.join(dir, filename);
			if (!selected) {
				paths.push({ path: file, readPath: file });
				continue;
			}
			const resolved = await resolveContainedPath(selected.root, file);
			if (resolved.status === "ok") paths.push({ path: file, readPath: resolved.realPath });
		}
		if (!selected || normalizePathForComparison(dir) === normalizePathForComparison(selected.root)) break;
		dir = path.dirname(dir);
	}
	return paths;
}
