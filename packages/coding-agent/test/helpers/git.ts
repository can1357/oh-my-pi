import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

/** Initialize a fixture through central VCS APIs, with local identity and empty hooks. */
export async function initGitFixture(cwd: string): Promise<VcsGitRepo> {
	const repo = vcs.initGit(cwd);
	const hooks = path.join(repo.info().gitDir, "fixture-hooks");
	await fs.mkdir(hooks, { recursive: true });
	// Configure before the first object/index access opens the lazy Git handle.
	await repo.configSet("user.name", "t");
	await repo.configSet("user.email", "t@example.com");
	await repo.configSet("core.hooksPath", hooks);
	return repo;
}
