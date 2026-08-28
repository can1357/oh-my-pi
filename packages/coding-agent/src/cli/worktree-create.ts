import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getWorktreeDir, hashPath, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { generateTaskName } from "../task/name-generator";
import { getRepoRoot } from "../task/worktree";
import { withRepoLock } from "../utils/repo-lock";

/** Stored in Git's linked-worktree admin dir, never in the user's checkout. */
export const MAIN_SESSION_WORKTREE_MARKER = ".omp-main-session";

export interface CreatedWorktree {
	name: string;
	workspacePath: string;
	branch: string;
	reused: boolean;
}

interface MainSessionWorktreeMarker {
	name: string;
	branch: string;
}

export function slugifyWorktreeName(input: string): string {
	return input
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function isPullRequestRef(value: string): boolean {
	return value.startsWith("#") || /\bgithub\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(value);
}

function reportCreatedWorktree(created: CreatedWorktree): void {
	process.stderr.write(
		`${chalk.green(created.reused ? "Reused managed workspace" : "Managed workspace")} ${chalk.bold(created.name)} ${chalk.dim(`(${created.branch})`)}\n`,
	);
	process.stderr.write(chalk.dim(`  ${created.workspacePath}\n`));
	process.stderr.write(chalk.dim("  Inspect managed workspaces with: omp wt list\n"));
}

const PROJECT_CONFIGURATION_PATHS = [
	".agents",
	".claude",
	".claude.json",
	".codex",
	".gemini",
	".mcp.json",
	".omp",
	".pi",
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
] as const;

function isMainSessionWorktreeMarker(value: unknown): value is MainSessionWorktreeMarker {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		"branch" in value &&
		typeof value.branch === "string"
	);
}

async function copyMissingProjectConfigurationFiles(sourceRoot: string, workspacePath: string): Promise<void> {
	async function copyMissing(source: string, destination: string): Promise<void> {
		const sourceEntry = await fs.lstat(source).catch(error => {
			if (isEnoent(error)) return null;
			throw error;
		});
		if (!sourceEntry || sourceEntry.isSymbolicLink()) return;
		const destinationEntry = await fs.lstat(destination).catch(error => {
			if (isEnoent(error)) return null;
			throw error;
		});
		if (sourceEntry.isDirectory()) {
			if (!destinationEntry) {
				await fs.mkdir(destination, { recursive: true, mode: sourceEntry.mode });
			}
			if (!destinationEntry || destinationEntry.isDirectory()) {
				for (const child of await fs.readdir(source)) {
					await copyMissing(path.join(source, child), path.join(destination, child));
				}
			}
			return;
		}
		if (sourceEntry.isFile() && !destinationEntry) {
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.copyFile(source, destination);
			await fs.chmod(destination, sourceEntry.mode);
		}
	}

	for (const relativePath of PROJECT_CONFIGURATION_PATHS) {
		await copyMissing(path.join(sourceRoot, relativePath), path.join(workspacePath, relativePath));
	}
}

async function reuseManagedWorkspace(
	repository: VcsGitRepo,
	workspacePath: string,
	name: string,
	branch: string,
): Promise<CreatedWorktree> {
	const workspaceRepository = vcs.git(workspacePath);
	if (
		!workspaceRepository ||
		path.resolve(workspaceRepository.primaryRoot()) !== path.resolve(repository.primaryRoot())
	) {
		throw new Error(`The existing path ${workspacePath} is not a managed workspace for this repository.`);
	}
	let marker: unknown;
	try {
		marker = JSON.parse(
			await Bun.file(path.join(workspaceRepository.info().gitDir, MAIN_SESSION_WORKTREE_MARKER)).text(),
		);
	} catch {
		throw new Error(`The existing path ${workspacePath} is not a persistent OMP-managed workspace.`);
	}
	if (!isMainSessionWorktreeMarker(marker) || marker.name !== name || marker.branch !== branch) {
		throw new Error(`The existing path ${workspacePath} has an invalid managed-workspace marker.`);
	}
	if ((await workspaceRepository.currentBranch()) !== branch) {
		throw new Error(`The managed workspace ${workspacePath} is no longer on branch ${branch}.`);
	}
	return { name, workspacePath, branch, reused: true };
}

export async function createWorktree(cwd: string, value: string | true): Promise<CreatedWorktree> {
	let repoRoot: string;
	try {
		repoRoot = await getRepoRoot(cwd);
	} catch (error) {
		if (error instanceof Error && error.message.includes("pure Jujutsu")) throw error;
		throw new Error("--worktree requires a Git repository. Run omp from inside a repository.");
	}

	if (value !== true && isPullRequestRef(value.trim())) {
		throw new Error(`--worktree does not check out pull requests. Use \`omp gh pr_checkout ${value.trim()}\`.`);
	}

	const requested = value === true ? "" : slugifyWorktreeName(value);
	const name = requested || slugifyWorktreeName(generateTaskName());
	if (!name) throw new Error("--worktree requires a name containing letters or numbers.");
	const branch = `omp/${name}`;
	const workspacePath = getWorktreeDir(`main-${hashPath(repoRoot)}-${name}`);

	return withRepoLock(repoRoot, async () => {
		const repository = vcs.requireGit(repoRoot);
		try {
			await fs.stat(workspacePath);
			const reused = await reuseManagedWorkspace(repository, workspacePath, name, branch);
			reportCreatedWorktree(reused);
			return reused;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		if (await repository.refExists(`refs/heads/${branch}`)) {
			throw new Error(
				`The managed branch "${branch}" already exists. Choose another workspace name or open its existing checkout directly.`,
			);
		}

		try {
			await repository.createBranch(branch, "HEAD", false);
			await repository.worktreeAdd(workspacePath, branch, false);
			const workspaceRepository = vcs.requireGit(workspacePath);
			await copyMissingProjectConfigurationFiles(repoRoot, workspacePath);
			await Bun.write(
				path.join(workspaceRepository.info().gitDir, MAIN_SESSION_WORKTREE_MARKER),
				`${JSON.stringify({ name, branch, createdAt: new Date().toISOString() })}\n`,
			);
		} catch (error) {
			await repository.worktreeRemove(workspacePath, true).catch(() => {});
			await repository.deleteBranch(branch, true).catch(() => {});
			throw new Error(
				`Failed to create the managed worktree: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const created: CreatedWorktree = {
			name,
			workspacePath,
			branch,
			reused: false,
		};
		reportCreatedWorktree(created);
		return created;
	});
}

/** Remove only a workspace freshly created by this invocation before startup fails. */
export async function cleanupCreatedWorktree(cwd: string, created: CreatedWorktree): Promise<void> {
	if (created.reused) return;
	const repoRoot = await getRepoRoot(cwd);
	await withRepoLock(repoRoot, async () => {
		const repository = vcs.requireGit(repoRoot);
		await repository.worktreeRemove(created.workspacePath, true).catch(() => {});
		await repository.deleteBranch(created.branch, true).catch(() => {});
	});
}
