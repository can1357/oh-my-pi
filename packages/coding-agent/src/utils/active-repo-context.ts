import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { type GitRepository, repo } from "./git";

export interface ActiveRepoContext {
	cwd: string;
	repoRoot: string;
	relativeRepoRoot: string;
	source: "single-direct-child-repo";
}

function compareEntryNames(left: fs.Dirent, right: fs.Dirent): number {
	if (left.name < right.name) return -1;
	if (left.name > right.name) return 1;
	return 0;
}

function buildContext(cwd: string, repoRoot: string): ActiveRepoContext {
	const resolvedCwd = path.resolve(cwd);
	const resolvedRepoRoot = path.resolve(repoRoot);
	return {
		cwd: resolvedCwd,
		repoRoot: resolvedRepoRoot,
		relativeRepoRoot: path.relative(resolvedCwd, resolvedRepoRoot),
		source: "single-direct-child-repo",
	};
}

async function resolveRepository(cwd: string): Promise<GitRepository | null> {
	try {
		return await repo.resolve(cwd);
	} catch {
		return null;
	}
}

function resolveRepositorySync(cwd: string): GitRepository | null {
	try {
		return repo.resolveSync(cwd);
	} catch {
		return null;
	}
}

async function readDirectChildren(cwd: string): Promise<fs.Dirent[]> {
	try {
		const entries = await fsPromises.readdir(cwd, { withFileTypes: true });
		entries.sort(compareEntryNames);
		return entries;
	} catch {
		return [];
	}
}

function readDirectChildrenSync(cwd: string): fs.Dirent[] {
	try {
		const entries = fs.readdirSync(cwd, { withFileTypes: true });
		entries.sort(compareEntryNames);
		return entries;
	} catch {
		return [];
	}
}

async function resolveDirectChildDirectory(cwd: string, entry: fs.Dirent): Promise<string | null> {
	const childPath = path.join(cwd, entry.name);
	if (entry.isDirectory()) return childPath;
	if (!entry.isSymbolicLink()) return null;
	try {
		const stat = await fsPromises.stat(childPath);
		return stat.isDirectory() ? childPath : null;
	} catch {
		return null;
	}
}

function resolveDirectChildDirectorySync(cwd: string, entry: fs.Dirent): string | null {
	const childPath = path.join(cwd, entry.name);
	if (entry.isDirectory()) return childPath;
	if (!entry.isSymbolicLink()) return null;
	try {
		const stat = fs.statSync(childPath);
		return stat.isDirectory() ? childPath : null;
	} catch {
		return null;
	}
}

async function hasGitMarker(childPath: string): Promise<boolean> {
	try {
		const stat = await fsPromises.stat(path.join(childPath, ".git"));
		return stat.isDirectory() || stat.isFile();
	} catch {
		return false;
	}
}

function hasGitMarkerSync(childPath: string): boolean {
	try {
		const stat = fs.statSync(path.join(childPath, ".git"));
		return stat.isDirectory() || stat.isFile();
	} catch {
		return false;
	}
}

async function findSingleDirectChildRepo(cwd: string): Promise<ActiveRepoContext | null> {
	let context: ActiveRepoContext | null = null;
	for (const entry of await readDirectChildren(cwd)) {
		const childPath = await resolveDirectChildDirectory(cwd, entry);
		if (!childPath) continue;
		if (!(await hasGitMarker(childPath))) continue;
		if (context) return null;
		context = buildContext(cwd, childPath);
	}
	return context;
}

function findSingleDirectChildRepoSync(cwd: string): ActiveRepoContext | null {
	let context: ActiveRepoContext | null = null;
	for (const entry of readDirectChildrenSync(cwd)) {
		const childPath = resolveDirectChildDirectorySync(cwd, entry);
		if (!childPath) continue;
		if (!hasGitMarkerSync(childPath)) continue;
		if (context) return null;
		context = buildContext(cwd, childPath);
	}
	return context;
}

export async function resolveActiveRepoContext(cwd: string): Promise<ActiveRepoContext | null> {
	const resolvedCwd = path.resolve(cwd);
	if (await resolveRepository(resolvedCwd)) return null;
	return findSingleDirectChildRepo(resolvedCwd);
}

export function resolveActiveRepoContextSync(cwd: string): ActiveRepoContext | null {
	const resolvedCwd = path.resolve(cwd);
	if (resolveRepositorySync(resolvedCwd)) return null;
	return findSingleDirectChildRepoSync(resolvedCwd);
}
