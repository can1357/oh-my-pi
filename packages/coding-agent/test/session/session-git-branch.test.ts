import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GIT_BRANCH_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/git-branch";
import type { FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const START_BRANCH = "spike/branch-logging";

/**
 * Branch bookkeeping is real git I/O, but the git plumbing is not itself the
 * contract under test: one baseline repo is built once, and each test only
 * creates sessions and switches branches inside it.
 */
describe("session git branch recording", () => {
	let tempDir: TempDir;
	let previousAgentDir: string;
	let repo: string;
	let sessionDir: string;

	beforeAll(async () => {
		tempDir = await TempDir.create("@omp-session-git-branch-");
		previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		repo = path.join(tempDir.path(), "repo");
		sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(repo, { recursive: true });
		await $`git init --initial-branch=main && git config core.fsmonitor false && git config user.email tester@example.com && git config user.name Tester`
			.cwd(repo)
			.quiet();
		await Bun.write(path.join(repo, "README.md"), "# baseline\n");
		await $`git add -A && git commit -m baseline`.cwd(repo).quiet();
	});

	afterAll(async () => {
		setAgentDir(previousAgentDir);
		await tempDir.remove();
	});

	/** Put the shared checkout on `branch`, creating or resetting it to HEAD. */
	async function checkoutFresh(branch: string): Promise<void> {
		await $`git checkout -q -B ${branch}`.cwd(repo).quiet();
	}

	/** Header of `file` as persisted, or a throw when the file has no header line. */
	async function persistedHeader(file: string): Promise<SessionHeader> {
		const header = (await loadEntriesFromFile(file)).find(
			(entry): entry is SessionHeader => entry.type === "session",
		);
		if (!header) throw new Error(`no session header in ${file}`);
		return header;
	}

	/**
	 * Branch each `git_branch` entry records, in append order. A malformed
	 * payload surfaces as a `!`-prefixed marker so a broken writer fails the
	 * assertion instead of silently dropping the entry.
	 */
	function recordedBranches(entries: readonly FileEntry[]): string[] {
		const branches: string[] = [];
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== GIT_BRANCH_CUSTOM_TYPE) continue;
			const data = entry.data;
			if (typeof data !== "object" || data === null || !("gitBranch" in data)) {
				branches.push("!missing-payload");
				continue;
			}
			const value = data.gitBranch;
			branches.push(typeof value === "string" ? value : value === null ? "!no-branch" : "!malformed-payload");
		}
		return branches;
	}

	it("writes the checked-out branch into a new session's header", async () => {
		await checkoutFresh(START_BRANCH);
		const manager = SessionManager.create(repo, sessionDir);
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		await manager.ensureOnDisk();

		expect((await persistedHeader(file)).gitBranch).toBe(START_BRANCH);
	});

	it("appends a git_branch entry when the branch changes, and stays silent when it does not", async () => {
		await checkoutFresh(START_BRANCH);
		const manager = SessionManager.create(repo, sessionDir);
		await manager.ensureOnDisk();

		// The header already recorded this branch, so a turn on it appends nothing.
		expect(manager.recordGitBranchIfChanged()).toBeNull();
		expect(recordedBranches(manager.getEntries())).toEqual([]);

		const switched = "spike/branch-switched";
		await checkoutFresh(switched);
		expect(manager.recordGitBranchIfChanged()).toBeString();
		await manager.flush();

		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		const persisted = await loadEntriesFromFile(file);
		expect(recordedBranches(persisted)).toEqual([switched]);
		expect(persisted.at(-1)).toMatchObject({
			type: "custom",
			customType: GIT_BRANCH_CUSTOM_TYPE,
			data: { gitBranch: switched },
		});

		// Edge-triggered: a second turn on the same branch appends nothing.
		expect(manager.recordGitBranchIfChanged()).toBeNull();
		expect(recordedBranches(manager.getEntries())).toEqual([switched]);
	});

	it("seeds the tracked branch from the header when a session is resumed", async () => {
		await checkoutFresh(START_BRANCH);
		const manager = SessionManager.create(repo, sessionDir);
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		await manager.ensureOnDisk();
		await manager.flush();
		expect((await persistedHeader(file)).gitBranch).toBe(START_BRANCH);

		const resumed = await SessionManager.open(file, sessionDir, undefined, { suppressBreadcrumb: true });
		// Resumed on the branch the header recorded: nothing to append, which
		// holds only when the header seeded the tracked value.
		expect(resumed.recordGitBranchIfChanged()).toBeNull();

		const switched = "spike/branch-resumed";
		await checkoutFresh(switched);
		expect(resumed.recordGitBranchIfChanged()).toBeString();
		expect(recordedBranches(resumed.getEntries())).toEqual([switched]);
	});

	it("records no branch outside a git checkout", async () => {
		const plain = path.join(tempDir.path(), "plain");
		await fs.mkdir(plain, { recursive: true });
		const manager = SessionManager.create(plain, path.join(tempDir.path(), "plain-sessions"));
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		await manager.ensureOnDisk();

		expect((await persistedHeader(file)).gitBranch).toBeUndefined();
		expect(manager.recordGitBranchIfChanged()).toBeNull();
		expect(recordedBranches(manager.getEntries())).toEqual([]);
	});
});
