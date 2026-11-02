import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as nativeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveSessionRecovery } from "@oh-my-pi/pi-coding-agent/session/session-recovery";

type RepositoryMetadata = {
	sessionWorktreeRoot: string;
	primaryWorktreeRoot: string;
};

type RecoverySessionInfo = SessionInfo & {
	repository?: RepositoryMetadata;
};

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-recovery-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function directory(name: string): Promise<string> {
	const result = path.join(root, name);
	await fs.mkdir(result, { recursive: true });
	return result;
}

function missingDirectory(name: string): string {
	return path.join(root, name);
}

function session(cwd: string, options: { path?: string; repository?: RepositoryMetadata } = {}): RecoverySessionInfo {
	return {
		path: options.path ?? path.join(root, "session.jsonl"),
		id: "019e84ed-b4cc-7000-9c87-5afe6df992c1",
		cwd,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		size: 0,
		firstMessage: "",
		allMessagesText: "",
		repository: options.repository,
	};
}

async function removedWorktreeFixture(): Promise<{
	repo: string;
	missingCwd: string;
	sessionDir: string;
	sessionPath: string;
}> {
	const repo = await directory("repo");
	await $`git init -q`.cwd(repo).quiet();
	await $`git -c user.name=Test -c user.email=test@example.com commit --allow-empty -qm init`.cwd(repo).quiet();

	const linked = path.join(root, "linked");
	await $`git worktree add -q -b recovery ${linked}`.cwd(repo).quiet();
	const sessionDir = SessionManager.getDefaultSessionDir(repo, root);
	const linkedSessionDir = SessionManager.getDefaultSessionDir(linked, root);
	await fs.rm(linked, { recursive: true, force: true });

	return {
		repo,
		missingCwd: linked,
		sessionDir,
		sessionPath: path.join(linkedSessionDir, "legacy.jsonl"),
	};
}

describe("resolveSessionRecovery", () => {
	it("keeps the recorded cwd when it still exists", async () => {
		const recordedCwd = await directory("recorded");
		const savedPrimary = await directory("primary");
		const launchCwd = await directory("launch");

		expect(
			await resolveSessionRecovery(
				session(recordedCwd, {
					repository: { sessionWorktreeRoot: recordedCwd, primaryWorktreeRoot: savedPrimary },
				}),
				launchCwd,
			),
		).toEqual({ kind: "unchanged" });
	});

	it("keeps the launch-directory fallback for a session with no recorded cwd", async () => {
		const launchCwd = await directory("launch");

		expect(await resolveSessionRecovery(session(""), launchCwd)).toEqual({ kind: "unchanged" });
	});

	it("relocates a missing cwd to the usable saved primary worktree", async () => {
		const savedPrimary = await directory("primary");
		const launchCwd = await directory("unrelated");
		const missingCwd = missingDirectory("missing");

		expect(
			await resolveSessionRecovery(
				session(missingCwd, {
					repository: { sessionWorktreeRoot: missingCwd, primaryWorktreeRoot: savedPrimary },
				}),
				launchCwd,
			),
		).toEqual({ kind: "relocate", directory: savedPrimary });
	});

	it("relocates a missing nested cwd to the primary root itself", async () => {
		const sessionWorktree = await directory("session-worktree");
		const savedPrimary = await directory("primary");
		const launchCwd = await directory("unrelated");
		const missingNestedCwd = path.join(sessionWorktree, "packages", "nested");

		expect(
			await resolveSessionRecovery(
				session(missingNestedCwd, {
					repository: { sessionWorktreeRoot: sessionWorktree, primaryWorktreeRoot: savedPrimary },
				}),
				launchCwd,
			),
		).toEqual({ kind: "relocate", directory: savedPrimary });
	});

	it("asks for a directory when the saved primary worktree is missing", async () => {
		const launchCwd = await directory("unrelated");
		const missingCwd = missingDirectory("missing-cwd");
		const missingPrimary = missingDirectory("missing-primary");

		expect(
			await resolveSessionRecovery(
				session(missingCwd, {
					repository: { sessionWorktreeRoot: missingCwd, primaryWorktreeRoot: missingPrimary },
				}),
				launchCwd,
			),
		).toEqual({ kind: "choose-directory" });
	});

	it("asks for a directory when the saved primary path is a regular file", async () => {
		const launchCwd = await directory("unrelated");
		const missingCwd = missingDirectory("missing-cwd");
		const primaryFile = path.join(root, "primary-file");
		await fs.writeFile(primaryFile, "not a directory");

		expect(
			await resolveSessionRecovery(
				session(missingCwd, {
					repository: { sessionWorktreeRoot: missingCwd, primaryWorktreeRoot: primaryFile },
				}),
				launchCwd,
			),
		).toEqual({ kind: "choose-directory" });
	});

	it("omits malformed repository metadata from bounded picker listings", async () => {
		const launchCwd = await directory("unrelated");
		const sessionDir = await directory("sessions");
		const rows = [
			{
				id: "incomplete",
				repository: { sessionWorktreeRoot: launchCwd },
			},
			{
				id: "relative",
				repository: { sessionWorktreeRoot: "relative/session", primaryWorktreeRoot: launchCwd },
			},
			{
				id: "non-string",
				repository: { sessionWorktreeRoot: launchCwd, primaryWorktreeRoot: 42 },
			},
		] as const;

		for (const row of rows) {
			await fs.writeFile(
				path.join(sessionDir, `${row.id}.jsonl`),
				`${JSON.stringify({
					type: "session",
					version: 4,
					id: row.id,
					timestamp: new Date(0).toISOString(),
					cwd: missingDirectory(`${row.id}-cwd`),
					title: row.id,
					repository: row.repository,
				})}\n`,
			);
		}

		const listed = await SessionManager.listForPicker(launchCwd, sessionDir);
		const decisions = await Promise.all(listed.map(info => resolveSessionRecovery(info, launchCwd)));
		expect(
			listed
				.map((info, index) => ({ id: info.id, repository: info.repository, decision: decisions[index] }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		).toEqual(
			rows
				.map(row => ({ id: row.id, repository: undefined, decision: { kind: "choose-directory" as const } }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		);
	});

	it("preserves repository metadata when later header fields exceed the listing prefix", async () => {
		const launchCwd = await directory("unrelated");
		const primary = await directory("primary");
		const missingCwd = missingDirectory("missing-cwd");
		const repository = { sessionWorktreeRoot: missingCwd, primaryWorktreeRoot: primary };
		const additionalDirectories = Array.from({ length: 200 }, (_, index) =>
			path.join(root, `additional-${index}-${"x".repeat(32)}`),
		);
		const line = JSON.stringify({
			type: "session",
			version: 4,
			id: "oversized",
			timestamp: new Date(0).toISOString(),
			cwd: missingCwd,
			title: "oversized",
			repository,
			additionalDirectories,
		});
		expect(Buffer.byteLength(line)).toBeGreaterThan(4096);
		const sessionDir = await directory("sessions");
		await fs.writeFile(path.join(sessionDir, "oversized.jsonl"), `${line}\n`);

		const listed = await SessionManager.listForPicker(launchCwd, sessionDir);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.repository).toEqual(repository);
		expect(await resolveSessionRecovery(listed[0]!, launchCwd)).toEqual({
			kind: "relocate",
			directory: primary,
		});
	});

	it("reads repository metadata after large preceding header fields", async () => {
		const launchCwd = await directory("unrelated");
		const primary = await directory("primary");
		const missingCwd = missingDirectory("missing-cwd");
		const repository = { sessionWorktreeRoot: missingCwd, primaryWorktreeRoot: primary };
		const additionalDirectories = Array.from({ length: 200 }, (_, index) =>
			path.join(root, `additional-${index}-${"x".repeat(32)}`),
		);
		const line = JSON.stringify({
			type: "session",
			version: 4,
			id: "repository-after-padding",
			timestamp: new Date(0).toISOString(),
			cwd: missingCwd,
			title: "repository-after-padding",
			additionalDirectories,
			repository,
		});
		expect(Buffer.byteLength(line)).toBeGreaterThan(4096);
		const sessionDir = await directory("sessions");
		await fs.writeFile(path.join(sessionDir, "repository-after-padding.jsonl"), `${line}\n`);

		const listed = await SessionManager.listForPicker(launchCwd, sessionDir);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.repository).toEqual(repository);
		expect(await resolveSessionRecovery(listed[0]!, launchCwd)).toEqual({
			kind: "relocate",
			directory: primary,
		});
	});

	it("reads repository metadata after a title slot and large preceding fields", async () => {
		const launchCwd = await directory("unrelated");
		const primary = await directory("primary");
		const missingCwd = missingDirectory("missing-cwd");
		const repository = { sessionWorktreeRoot: missingCwd, primaryWorktreeRoot: primary };
		const additionalDirectories = Array.from({ length: 200 }, (_, index) =>
			path.join(root, `additional-${index}-${"x".repeat(32)}`),
		);
		const titleSlot = JSON.stringify({ type: "title", v: 1, title: "saved title" });
		const header = JSON.stringify({
			type: "session",
			version: 4,
			id: "title-slot-repository",
			timestamp: new Date(0).toISOString(),
			cwd: missingCwd,
			title: "header title",
			additionalDirectories,
			repository,
		});
		expect(Buffer.byteLength(header)).toBeGreaterThan(4096);
		const sessionDir = await directory("sessions");
		await fs.writeFile(path.join(sessionDir, "title-slot-repository.jsonl"), `${titleSlot}\n${header}\n`);

		const listed = await SessionManager.listForPicker(launchCwd, sessionDir);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.repository).toEqual(repository);
		expect(await resolveSessionRecovery(listed[0]!, launchCwd)).toEqual({
			kind: "relocate",
			directory: primary,
		});
	});

	it("reads repository metadata when the prefix cuts through its object", async () => {
		const launchCwd = await directory("unrelated");
		const primary = await directory("primary");
		const missingCwd = missingDirectory("missing-cwd");
		const repository = { sessionWorktreeRoot: missingCwd, primaryWorktreeRoot: primary };
		const baseLine = JSON.stringify({
			type: "session",
			version: 4,
			id: "repository-split",
			timestamp: new Date(0).toISOString(),
			cwd: missingCwd,
			title: "repository-split",
			additionalDirectories: [""],
			repository,
		});
		const repositoryValueIndex = baseLine.indexOf('{"sessionWorktreeRoot"');
		const additionalDirectoryPrefix = path.join(root, "additional-");
		const additionalDirectoryLength = 4080 - repositoryValueIndex - additionalDirectoryPrefix.length;
		expect(additionalDirectoryLength).toBeGreaterThan(0);
		const additionalDirectories = [`${additionalDirectoryPrefix}${"x".repeat(additionalDirectoryLength)}`];
		const line = JSON.stringify({
			type: "session",
			version: 4,
			id: "repository-split",
			timestamp: new Date(0).toISOString(),
			cwd: missingCwd,
			title: "repository-split",
			additionalDirectories,
			repository,
		});
		const actualRepositoryValueIndex = line.indexOf('{"sessionWorktreeRoot"');
		expect(actualRepositoryValueIndex).toBe(4080);
		expect(line.indexOf("}", actualRepositoryValueIndex)).toBeGreaterThan(4096);
		const sessionDir = await directory("sessions");
		await fs.writeFile(path.join(sessionDir, "repository-split.jsonl"), `${line}\n`);

		const listed = await SessionManager.listForPicker(launchCwd, sessionDir);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.repository).toEqual(repository);
		expect(await resolveSessionRecovery(listed[0]!, launchCwd)).toEqual({
			kind: "relocate",
			directory: primary,
		});
	});

	it("relocates a legacy removed-worktree session to the current repository", async () => {
		const fixture = await removedWorktreeFixture();

		expect(
			await resolveSessionRecovery(
				session(fixture.missingCwd, { path: fixture.sessionPath }),
				fixture.repo,
				fixture.sessionDir,
			),
		).toEqual({ kind: "relocate", directory: fixture.repo });
	});

	it("asks for a directory when a legacy missing cwd is not a removed worktree", async () => {
		const launchCwd = await directory("unrelated");
		const missingCwd = missingDirectory("missing-cwd");

		expect(await resolveSessionRecovery(session(missingCwd), launchCwd)).toEqual({ kind: "choose-directory" });
	});

	it("surfaces access errors for an existing recorded cwd", async () => {
		const recordedCwd = await directory("recorded");
		const launchCwd = await directory("launch");
		const accessError = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const probe = spyOn(nativeFs.promises, "stat").mockImplementation((async (
			_target: nativeFs.PathLike,
			_options?: nativeFs.StatOptions,
		) => {
			throw accessError;
		}) as typeof nativeFs.promises.stat);

		try {
			await expect(resolveSessionRecovery(session(recordedCwd), launchCwd)).rejects.toBe(accessError);
		} finally {
			probe.mockRestore();
		}
	});
});
