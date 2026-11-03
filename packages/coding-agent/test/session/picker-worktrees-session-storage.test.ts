/**
 * The resume picker's repository scope includes the session buckets of the
 * repository's agent-managed worktrees, matched by bucket name, so a session
 * whose worktree was removed stays reachable from the checkout. Under
 * `session.storage: sql` a bucket is a key prefix in the database and has no
 * directory on disk, so the bucket names must come from the session storage.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
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

const backends: Array<[string, (clients: SQL[]) => Promise<SessionStorage>]> = [
	["file", async () => new FileSessionStorage()],
	[
		"sql",
		async clients => {
			const client = new SQL("sqlite::memory:");
			clients.push(client);
			return SqlSessionStorage.create({ client });
		},
	],
];

describe.skipIf(process.platform === "win32")("resume picker repo scope over the session storage", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalEnv = Object.fromEntries(TEST_ENV_KEYS.map(key => [key, process.env[key]]));
	const previous = defaultSessionStorage();
	const clients: SQL[] = [];
	let root: string;
	let repo: string;

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-picker-wt-storage-")));
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
		fs.mkdirSync(repo, { recursive: true });
		await $`git init -q && git commit -q --allow-empty -m init`.cwd(repo).quiet();
	});

	afterEach(async () => {
		setDefaultSessionStorage(previous);
		for (const client of clients.splice(0)) await client.end();
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

	it.each(backends)("lists a removed worktree's session that only the %s storage holds", async (_name, open) => {
		setDefaultSessionStorage(await open(clients));
		const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), "wt/gone");
		const session = SessionManager.create(worktree);
		session.appendMessage({ role: "user", content: "work in the worktree", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		await session.close();
		// `omp worktree clear` removes and prunes: git no longer knows the worktree.
		await $`git worktree remove --force ${worktree} && git worktree prune`.cwd(repo).quiet();

		const listing = await SessionManager.listForPicker(repo);
		const listed = (await listing.complete).find(s => s.id === session.getSessionId());

		expect(listed?.cwd).toBe(worktree);
		expect(await SessionManager.isFromRemovedWorktree(listed!, repo)).toBe(true);
	});
});
