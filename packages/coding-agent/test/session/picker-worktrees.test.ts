import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { makeAssistantMessage } from "../session-manager/helpers";

/** Host git config (signing, hooks) must not leak into the fixture repo; worktrees stay under the temp root. */
const TEST_ENV_KEYS = [
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"OMP_WORKTREE_DIR",
] as const;

/**
 * `/wt` moves a session into a linked worktree's session directory. The
 * resume picker must keep that session reachable from the checkout it left
 * (and the reverse), without widening a subfolder's scope to the repo root,
 * and a session whose worktree was removed must resume from the checkout.
 */
describe.skipIf(process.platform === "win32")("resume picker across git worktrees", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalEnv = Object.fromEntries(TEST_ENV_KEYS.map(key => [key, process.env[key]]));
	let root: string;
	let repo: string;

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-picker-wt-")));
		Object.assign(process.env, {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
			OMP_WORKTREE_DIR: path.join(root, "wt-base"),
		});
		setAgentDir(path.join(root, "agent"));
		repo = path.join(root, "repo");
		fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
		await $`git init -q && git commit -q --allow-empty -m init`.cwd(repo).quiet();
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		for (const key of TEST_ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		removeSyncWithRetries(root);
	});

	async function answeredSession(cwd: string): Promise<SessionManager> {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: `work in ${cwd}`, timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		return session;
	}

	/** Runs `/wt`'s worktree creation and session move for a fresh session in `repo`. */
	async function sessionMovedByWt(branch: string): Promise<{ id: string; worktree: string }> {
		const session = await answeredSession(repo);
		const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), branch);
		await session.moveTo(worktree);
		await session.close();
		return { id: session.getSessionId(), worktree };
	}

	it("lists a session moved into a worktree from the original checkout, and vice versa", async () => {
		const moved = await sessionMovedByWt("wt/live");
		const stayed = await answeredSession(repo);
		await stayed.close();
		const nested = await answeredSession(path.join(repo, "pkg"));
		await nested.close();

		const ids = async (cwd: string) => (await SessionManager.listForPicker(cwd)).map(s => s.id).sort();
		const rootIds = [moved.id, stayed.getSessionId()].sort();
		expect(await ids(repo)).toEqual(rootIds);
		expect(await ids(moved.worktree)).toEqual(rootIds);
		expect(await ids(path.join(repo, "pkg"))).toEqual([nested.getSessionId()]);

		// A live worktree is not removed: its session resumes in place.
		const listed = (await SessionManager.listForPicker(repo)).find(s => s.id === moved.id)!;
		expect(await SessionManager.isFromRemovedWorktree(listed, repo)).toBe(false);
	});

	it("keeps a removed worktree's session listed and relocates it into the checkout on resume", async () => {
		const moved = await sessionMovedByWt("wt/gone");
		// `omp worktree clear` removes and prunes: git no longer knows the worktree.
		await $`git worktree remove --force ${moved.worktree} && git worktree prune`.cwd(repo).quiet();

		const listed = (await SessionManager.listForPicker(repo)).find(s => s.id === moved.id);
		expect(listed?.cwd).toBe(moved.worktree);
		expect(await SessionManager.isFromRemovedWorktree(listed!, repo)).toBe(true);

		const relocated = await SessionManager.openRelocated(listed!.path, listed!.cwd, repo);
		await relocated.close();
		const own = await SessionManager.list(repo);
		expect(own.map(s => [s.id, s.cwd])).toEqual([[moved.id, repo]]);
		expect(fs.existsSync(listed!.path)).toBe(false);
	});
});
