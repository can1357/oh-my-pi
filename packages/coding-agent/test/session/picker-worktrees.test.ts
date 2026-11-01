import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager, SessionMoveRefusedError } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveSessionRecovery } from "@oh-my-pi/pi-coding-agent/session/session-recovery";
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

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");

async function startLiveWriter(script: string, sessionPath: string): Promise<{ close(): Promise<void> }> {
	await Bun.write(
		script,
		[
			`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
			"const manager = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
			'manager.appendMessage({ role: "user", content: "live writer marker", timestamp: Date.now() });',
			"await manager.flush();",
			'process.stdout.write("ready\\n");',
			'for await (const line of console) if (line === "close") break;',
			"await manager.close();",
		].join("\n"),
	);
	const child = Bun.spawn([process.execPath, script, sessionPath], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const reader = child.stdout.getReader();
	let buffered = "";
	const nextLine = async (): Promise<string> => {
		let newline = buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await reader.read();
			if (done) throw new Error(`live writer exited early: ${await new Response(child.stderr).text()}`);
			buffered += new TextDecoder().decode(value);
			newline = buffered.indexOf("\n");
		}
		const line = buffered.slice(0, newline);
		buffered = buffered.slice(newline + 1);
		return line;
	};
	try {
		if ((await nextLine()) !== "ready") throw new Error("live writer did not become ready");
	} catch (error) {
		child.kill();
		await child.exited;
		throw error;
	}
	let closed = false;
	return {
		async close() {
			if (closed) return;
			closed = true;
			child.stdin.write("close\n");
			child.stdin.end();
			await child.exited;
		},
	};
}

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

	it("can keep the current-folder picker isolated while all-projects still reaches other worktrees", async () => {
		const moved = await sessionMovedByWt("wt/scoped");
		const stayed = await answeredSession(repo);
		await stayed.close();

		const directoryIds = async (cwd: string) =>
			(await SessionManager.listForPicker(cwd, undefined, undefined, "directory")).map(session => session.id);
		expect(await directoryIds(repo)).toEqual([stayed.getSessionId()]);
		expect(await directoryIds(moved.worktree)).toEqual([moved.id]);
		expect((await SessionManager.listAllForPicker()).map(session => session.id).sort()).toEqual(
			[moved.id, stayed.getSessionId()].sort(),
		);
		// Choosing a narrower listing never changes relocation of a deleted worktree session.
		await $`git worktree remove --force ${moved.worktree} && git worktree prune`.cwd(repo).quiet();
		const listed = (await SessionManager.listAllForPicker()).find(session => session.id === moved.id)!;
		expect(await SessionManager.isFromRemovedWorktree(listed, repo)).toBe(true);
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

	it("fails closed when a selected transcript is deleted before relocation opens it", async () => {
		const moved = await sessionMovedByWt("wt/deleted-before-open");
		await $`git worktree remove --force ${moved.worktree} && git worktree prune`.cwd(repo).quiet();

		const listed = (await SessionManager.listForPicker(repo)).find(session => session.id === moved.id);
		if (!listed) throw new Error("expected removed worktree session in picker");
		fs.unlinkSync(listed.path);

		await expect(SessionManager.openRelocated(listed.path, listed.cwd, repo)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(fs.existsSync(listed.path)).toBe(false);
		expect(await SessionManager.list(repo)).toHaveLength(0);
	});
	it("persists primary, linked, and nested creation roots through listing and relocation", async () => {
		const worktree = (await createSessionWorktree(repo, Settings.isolated(), "wt/roots")).path;
		const nestedWorktreeDir = path.join(worktree, "pkg");
		fs.mkdirSync(nestedWorktreeDir, { recursive: true });

		const primary = await answeredSession(repo);
		const linked = await answeredSession(worktree);
		const nested = await answeredSession(nestedWorktreeDir);
		const primaryId = primary.getSessionId();
		const linkedId = linked.getSessionId();
		const nestedId = nested.getSessionId();
		const sessionFile = (session: SessionManager): string => {
			const file = session.getSessionFile();
			if (!file) throw new Error("expected persisted session file");
			return file;
		};
		const roots = (sessionWorktreeRoot: string) => ({
			sessionWorktreeRoot: path.resolve(sessionWorktreeRoot),
			primaryWorktreeRoot: path.resolve(repo),
		});

		const primaryFile = sessionFile(primary);
		const linkedFile = sessionFile(linked);
		const nestedFile = sessionFile(nested);
		await primary.close();
		await linked.close();
		await nested.close();

		for (const [file, expected] of [
			[primaryFile, roots(repo)],
			[linkedFile, roots(worktree)],
			[nestedFile, roots(worktree)],
		] as const) {
			const reopened = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
			expect(reopened.getHeader()?.repository).toEqual(expected);
			await reopened.close();
		}

		const listedBeforeRemoval = await SessionManager.listForPicker(repo);
		expect(listedBeforeRemoval.find(session => session.id === primaryId)).toMatchObject({
			cwd: repo,
			repository: roots(repo),
		});
		expect(listedBeforeRemoval.find(session => session.id === linkedId)).toMatchObject({
			cwd: worktree,
			repository: roots(worktree),
		});
		expect(
			(await SessionManager.listForPicker(path.join(repo, "pkg"))).find(session => session.id === nestedId),
		).toMatchObject({
			cwd: nestedWorktreeDir,
			repository: roots(worktree),
		});

		await $`git worktree remove --force ${worktree} && git worktree prune`.cwd(repo).quiet();

		const listedAfterRemoval = await SessionManager.listForPicker(repo);
		const linkedInfo = listedAfterRemoval.find(session => session.id === linkedId);
		expect(linkedInfo).toMatchObject({
			cwd: worktree,
			repository: roots(worktree),
		});
		const nestedInfo = (await SessionManager.listForPicker(path.join(repo, "pkg"))).find(
			session => session.id === nestedId,
		);
		expect(nestedInfo).toMatchObject({
			cwd: nestedWorktreeDir,
			repository: roots(worktree),
		});

		if (!linkedInfo) throw new Error("expected linked session in picker");
		const relocated = await SessionManager.openRelocated(linkedInfo.path, linkedInfo.cwd, repo);
		expect(relocated.getHeader()?.repository).toEqual(roots(worktree));
		await relocated.close();
		const relocatedInfo = (await SessionManager.list(repo)).find(session => session.id === linkedId);
		expect(relocatedInfo).toMatchObject({
			cwd: repo,
			repository: roots(worktree),
		});
	});
	it("preserves session data while recovering a removed linked worktree", async () => {
		const worktree = (await createSessionWorktree(repo, Settings.isolated(), "wt/recover")).path;
		const savedMessage = "recover this exact saved turn";
		const savedArtifact = "artifact survives linked worktree removal";
		const session = SessionManager.create(worktree);
		session.appendMessage({ role: "user", content: savedMessage, timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		const artifactId = await session.saveArtifact(savedArtifact, "read");
		const sessionPath = session.getSessionFile();
		if (!artifactId || !sessionPath) throw new Error("expected persisted session and artifact");
		const sessionId = session.getSessionId();
		const repository = {
			sessionWorktreeRoot: path.resolve(worktree),
			primaryWorktreeRoot: path.resolve(repo),
		};
		await session.flush();
		await session.close();

		await $`git worktree remove --force ${worktree} && git worktree prune`.cwd(repo).quiet();
		expect(fs.existsSync(worktree)).toBe(false);

		const listed = (await SessionManager.listForPicker(repo)).find(info => info.id === sessionId);
		if (!listed) throw new Error("expected removed worktree session in picker");
		const recovery = await resolveSessionRecovery(listed, repo);
		expect(recovery).toEqual({ kind: "relocate", directory: repo });
		if (recovery.kind !== "relocate") throw new Error("expected primary worktree recovery");

		const writer = await startLiveWriter(path.join(root, "live-writer.ts"), sessionPath);
		try {
			await expect(SessionManager.openRelocated(listed.path, listed.cwd, recovery.directory)).rejects.toBeInstanceOf(
				SessionMoveRefusedError,
			);
		} finally {
			await writer.close();
		}

		const original = await SessionManager.open(sessionPath, undefined, undefined, { suppressBreadcrumb: true });
		try {
			expect(original.getSessionId()).toBe(sessionId);
			expect(original.getHeader()?.repository).toEqual(repository);
			expect(
				original
					.getEntries()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.content === savedMessage,
					),
			).toBe(true);
			const originalArtifact = await original.getArtifactPath(artifactId);
			if (!originalArtifact) throw new Error("expected original artifact after writer closes");
			expect(fs.readFileSync(originalArtifact, "utf8")).toBe(savedArtifact);
		} finally {
			await original.close();
		}

		const relocated = await SessionManager.openRelocated(listed.path, listed.cwd, recovery.directory);
		const relocatedPath = relocated.getSessionFile();
		if (!relocatedPath) {
			await relocated.close();
			throw new Error("expected relocated session path");
		}
		try {
			expect(relocated.getSessionId()).toBe(sessionId);
			expect(relocated.getCwd()).toBe(repo);
			expect(relocated.getHeader()?.repository).toEqual(repository);
			expect(
				relocated
					.getEntries()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.content === savedMessage,
					),
			).toBe(true);
			const relocatedArtifact = await relocated.getArtifactPath(artifactId);
			if (!relocatedArtifact) throw new Error("expected relocated artifact");
			expect(fs.readFileSync(relocatedArtifact, "utf8")).toBe(savedArtifact);
		} finally {
			await relocated.close();
		}

		const reopened = await SessionManager.open(relocatedPath, undefined, undefined, { suppressBreadcrumb: true });
		try {
			expect(reopened.getSessionId()).toBe(sessionId);
			expect(reopened.getCwd()).toBe(repo);
			expect(reopened.getHeader()?.repository).toEqual(repository);
			expect(
				reopened
					.getEntries()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							entry.message.content === savedMessage,
					),
			).toBe(true);
			const reopenedArtifact = await reopened.getArtifactPath(artifactId);
			if (!reopenedArtifact) throw new Error("expected readable artifact after reopen");
			expect(fs.readFileSync(reopenedArtifact, "utf8")).toBe(savedArtifact);
		} finally {
			await reopened.close();
		}
	});
});
