import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { GitSource } from "./git-url";

interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function runCommand(command: string[], cwd: string): Promise<CommandResult> {
	const proc = Bun.spawn(command, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function normalizeRepositoryUrl(repository: string): string {
	const withoutFragment = repository.replace(/^git\+/i, "").replace(/#.*$/, "");
	const scpLike = withoutFragment.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
	if (scpLike && !withoutFragment.includes("://")) {
		const host = scpLike[1]?.toLowerCase() ?? "";
		const repoPath = (scpLike[2] ?? "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
		return `ssh://${host}/${repoPath}`;
	}

	try {
		const parsed = new URL(withoutFragment);
		const repoPath = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
		return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}/${repoPath}`;
	} catch {
		return withoutFragment.replace(/\/+$/g, "").replace(/\.git$/i, "");
	}
}

/** Fetches current heads and tags into Bun's matching cached bare clone before a plugin update. */
export async function refreshBunGitCache(source: GitSource, cwd: string): Promise<void> {
	const cacheResult = await runCommand(["bun", "pm", "cache"], cwd);
	if (cacheResult.exitCode !== 0) {
		throw new Error(`bun pm cache failed: ${cacheResult.stderr}`);
	}
	const cacheDir = cacheResult.stdout.trim();
	if (!cacheDir) {
		throw new Error("bun pm cache returned an empty cache path");
	}

	let entries: Dirent[];
	try {
		entries = await fs.readdir(cacheDir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}

	const repositoryUrl = normalizeRepositoryUrl(source.repo);
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.endsWith(".git")) continue;
		const repositoryDir = path.join(cacheDir, entry.name);
		const originResult = await runCommand(["git", "-C", repositoryDir, "config", "--get", "remote.origin.url"], cwd);
		if (originResult.exitCode !== 0 || normalizeRepositoryUrl(originResult.stdout.trim()) !== repositoryUrl) continue;

		const fetchResult = await runCommand(
			[
				"git",
				"-C",
				repositoryDir,
				"fetch",
				"--force",
				"--prune",
				"origin",
				"+refs/heads/*:refs/heads/*",
				"+refs/tags/*:refs/tags/*",
			],
			cwd,
		);
		if (fetchResult.exitCode !== 0) {
			throw new Error(`Failed to refresh Bun's git cache for ${source.host}/${source.path}: ${fetchResult.stderr}`);
		}
	}
}
