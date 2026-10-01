/**
 * Throwaway lesson repositories under `~/.omp/tutorials/<id>-<timestamp>/`.
 *
 * The lesson `fixture/` tree becomes the initial commit; each `history` overlay
 * is written on top and committed with its message. User projects are never
 * touched: everything happens inside the fresh directory.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getConfigRootDir, isEexist } from "@oh-my-pi/pi-utils";
import { readLessonTree } from "./fixtures";
import type { Lesson } from "./lesson";

/** Default parent of every lesson sandbox. */
export function getTutorialSandboxRoot(): string {
	return path.join(getConfigRootDir(), "tutorials");
}

function timestamp(now: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function claimDirectory(root: string, base: string): Promise<string> {
	await fs.mkdir(root, { recursive: true });
	for (let attempt = 1; ; attempt++) {
		const dir = path.join(root, attempt === 1 ? base : `${base}-${attempt}`);
		try {
			await fs.mkdir(dir);
			return dir;
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
	}
}

async function commitTree(repo: VcsGitRepo, dir: string, lessonId: string, tree: string, message: string) {
	const files = await readLessonTree(lessonId, tree);
	await Promise.all(files.map(file => Bun.write(path.join(dir, file.path), file.bytes)));
	await repo.stageFiles(files.map(file => file.path));
	await repo.commitCreate(message, {});
}

/** Create a lesson sandbox repo and return its absolute path. */
export async function createSandbox(lesson: Lesson, options?: { root?: string; now?: Date }): Promise<string> {
	const dir = await claimDirectory(
		options?.root ?? getTutorialSandboxRoot(),
		`${lesson.id}-${timestamp(options?.now ?? new Date())}`,
	);
	await vcs.init(dir);
	const repo = vcs.requireGit(dir);
	// Repo-local identity so commits work without a global git config, and the
	// repo's own (empty) hooks dir so a global `core.hooksPath` cannot veto them.
	await repo.configSet("user.name", "omp tutorial");
	await repo.configSet("user.email", "tutorial@omp.invalid");
	await repo.configSet("core.hooksPath", ".git/hooks");
	await commitTree(repo, dir, lesson.id, "fixture", "initial commit");
	for (const commit of lesson.history) {
		await commitTree(repo, dir, lesson.id, commit.dir, commit.message);
	}
	return dir;
}
