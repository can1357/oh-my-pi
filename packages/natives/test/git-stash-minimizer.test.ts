import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell, type ShellRunResult } from "../native/index.js";

// Long names so `git status` / `git stash pop` exceed the minimizer's
// 1,000-character gate, while the whole listing still fits in the 40-path
// preview. Shorter output is left unchanged, so it cannot show the false count.
const FILE_COUNT = 20;
const NOTICE_FILE = "no changes added.md";
const DROP_FILE = "Dropped stash@{0}";

function padName(index: number): string {
	return `file-${String(index).padStart(2, "0")}-${"x".repeat(40)}.txt`;
}

async function run(
	cwd: string,
	command: string,
	sessionEnv: Record<string, string>,
): Promise<{ exitCode: number | undefined; raw: string; minimized: string | undefined }> {
	let raw = "";
	const result: ShellRunResult = await executeShell(
		{ command, cwd, minimizer: { enabled: true }, sessionEnv, timeoutMs: 30_000 },
		(_error, chunk) => {
			raw += chunk;
		},
	);
	return { exitCode: result.exitCode, raw, minimized: result.minimized?.text };
}

async function gitOk(
	cwd: string,
	command: string,
	sessionEnv: Record<string, string>,
): Promise<{ raw: string; minimized: string | undefined }> {
	const result = await run(cwd, command, sessionEnv);
	expect(result.exitCode, result.raw).toBe(0);
	return result;
}

function minimizedOrFail(result: { raw: string; minimized: string | undefined }): string {
	expect(result.minimized, `minimizer left ${result.raw.length} chars unchanged:\n${result.raw}`).toBeString();
	return result.minimized ?? "";
}

function assertUntracked(text: string, count: number): void {
	const match = text.match(/^staged \d+, unstaged \d+, untracked (\d+)$/m);
	expect(match?.[1], text).toBe(String(count));
	expect(text, text).toContain(`?? ${NOTICE_FILE}`);
	expect(text, text).toContain(`?? ${DROP_FILE}`);
	expect(text, text).not.toContain("?? no changes added to commit");
	expect(text, text).not.toContain("?? nothing added to commit");
	expect(text, text).toContain("?? file-00-");
}

async function initRepo(sessionEnv: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stash-min-"));
	await gitOk(dir, "git init -q -b main", sessionEnv);
	await gitOk(dir, "git config user.email test@example.com", sessionEnv);
	await gitOk(dir, "git config user.name test", sessionEnv);
	await gitOk(dir, "git config advice.statusHints true", sessionEnv);
	await gitOk(dir, "git config color.ui false", sessionEnv);
	await Bun.write(path.join(dir, "tracked.txt"), "a\n");
	await gitOk(dir, "git add tracked.txt", sessionEnv);
	await gitOk(dir, "git commit -qm init", sessionEnv);
	return dir;
}

async function writeUntracked(dir: string): Promise<void> {
	await Promise.all([
		...Array.from({ length: FILE_COUNT }, (_, index) => Bun.write(path.join(dir, padName(index)), "x\n")),
		Bun.write(path.join(dir, NOTICE_FILE), "x\n"),
		Bun.write(path.join(dir, DROP_FILE), "x\n"),
	]);
}

test("stash pop and status do not count closing lines as untracked files", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "stash-min-home-"));
	const sessionEnv = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: "0",
		LANG: "C",
		LC_ALL: "C",
	};
	const untracked = FILE_COUNT + 2;
	try {
		const dirty = await initRepo(sessionEnv);
		try {
			await Bun.write(path.join(dirty, "tracked.txt"), "b\n");
			await writeUntracked(dirty);
			await gitOk(dirty, "git stash push -u -q", sessionEnv);
			const popped = await gitOk(dirty, "git stash pop", sessionEnv);
			const text = minimizedOrFail(popped);
			assertUntracked(text, untracked);
			expect(text, text).toContain("unstaged 1");
			expect(text, text).toMatch(/^Dropped refs\/stash@\{0\} \([0-9a-f]+\)$/m);
		} finally {
			await fs.rm(dirty, { recursive: true, force: true });
		}

		const named = await initRepo(sessionEnv);
		try {
			await writeUntracked(named);
			await gitOk(named, "git stash push -u -q", sessionEnv);
			// Quoting keeps bash from brace-expanding. Git then prints
			// `Dropped stash@{0} (hash)`, not `Dropped refs/stash@{0}`.
			const popped = await gitOk(named, "git stash pop 'stash@{0}'", sessionEnv);
			const text = minimizedOrFail(popped);
			assertUntracked(text, untracked);
			expect(text, text).toMatch(/^Dropped stash@\{0\} \([0-9a-f]+\)$/m);
			expect(text, text).not.toContain("refs/stash");
		} finally {
			await fs.rm(named, { recursive: true, force: true });
		}

		const statusDir = await initRepo(sessionEnv);
		try {
			await writeUntracked(statusDir);
			const status = await gitOk(statusDir, "git status", sessionEnv);
			const text = minimizedOrFail(status);
			assertUntracked(text, untracked);
			expect(text, text).not.toContain("nothing added to commit");
		} finally {
			await fs.rm(statusDir, { recursive: true, force: true });
		}
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
}, 60_000);
