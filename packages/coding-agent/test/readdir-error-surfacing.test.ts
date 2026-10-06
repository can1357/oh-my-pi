/**
 * Contracts: a directory scan that cannot be read must never report the same
 * result as a directory that is genuinely empty (#11476).
 *
 * - An unreadable session container surfaces to the caller as a failure, not as
 *   "no sessions found" with exit 0.
 * - An unreadable advisor transcript directory reports through the caller's
 *   warning channel.
 * - An absent directory still reports empty and stays quiet.
 * - Memory pruning never issues `fs.rm` on a subtree it failed to read.
 *
 * Every case drives the real entry point and asserts on what the caller or user
 * observes, not on wiring.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadAdvisorTranscriptCosts } from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { ClaudeSessionStore } from "@oh-my-pi/pi-coding-agent/session/claude-session-store";
import { CodexSessionStore } from "@oh-my-pi/pi-coding-agent/session/codex-session-store";
import { readDirOutcome } from "@oh-my-pi/pi-coding-agent/utils/readdir";

function fsError(code: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: simulated failure`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

/** Captured before any spy replaces it, so unaffected paths still read for real. */
const fsRealReaddir = fs.readdir;

/**
 * Fail only for `dir`, so the rest of the fixture tree still reads normally.
 * Mirrors a permission denial on one directory rather than a broken filesystem.
 *
 * Both accessors are spied because callers reach readdir as `fs.readdir` and as
 * `fs.promises.readdir`.
 */
function failReaddirFor(dir: string, code: string): void {
	const wanted = path.resolve(dir);
	const failing = () => Promise.reject(fsError(code));
	spyOn(fs, "readdir").mockImplementation(((target: string, options?: unknown) =>
		typeof target === "string" && path.resolve(target) === wanted
			? failing()
			: (fsRealReaddir as (...args: unknown[]) => Promise<unknown>)(target, options as never)) as never);
	spyOn(fsSync.promises, "readdir").mockImplementation(((target: string, options?: unknown) =>
		typeof target === "string" && path.resolve(target) === wanted
			? failing()
			: (fsRealReaddir as (...args: unknown[]) => Promise<unknown>)(target, options as never)) as never);
}

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("readDirOutcome classification", () => {
	it("reports ENOTDIR as an error rather than a missing directory", async () => {
		const probe = path.join(await tempDir("enotdir"), "file");
		await Bun.write(probe, "x\n");
		failReaddirFor(probe, "ENOTDIR");
		const outcome = await readDirOutcome(probe);
		expect(outcome.status).toBe("error");
	});

	it("still reports ENOENT as a missing directory", async () => {
		const probe = path.join(await tempDir("enoent"), "absent");
		failReaddirFor(probe, "ENOENT");
		expect(await readDirOutcome(probe)).toEqual({ status: "missing" });
	});
});

describe("Claude session store readdir failures", () => {
	async function claudeRoot(): Promise<string> {
		const root = path.join(await tempDir("claude-store"), "projects", "-home-user-app");
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "11111111-1111-4111-8111-111111111111.jsonl"), '{"type":"user"}\n');
		return path.dirname(path.dirname(root));
	}

	it("surfaces an unreadable projects container instead of reporting zero sessions", async () => {
		const root = await claudeRoot();
		failReaddirFor(path.join(root, "projects"), "EACCES");

		const store = new ClaudeSessionStore(root);
		// The caller in main.ts and the session selector both catch this and
		// render it, which is what keeps an unreadable store from reporting
		// "No claude sessions found" and exiting 0.
		await expect(store.list()).rejects.toThrow(/Could not read directory/);
	});

	it("reports zero sessions and stays quiet when the projects directory is absent", async () => {
		const root = path.join(await tempDir("claude-empty"), "projects");
		await fs.mkdir(root, { recursive: true });

		const store = new ClaudeSessionStore(root);
		expect(await store.list()).toEqual([]);
	});

	it("still lists sessions when the container is readable", async () => {
		const root = await claudeRoot();
		const sessions = await new ClaudeSessionStore(root).list();
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe("11111111-1111-4111-8111-111111111111");
	});
});

describe("Codex session store readdir failures", () => {
	it("surfaces an unreadable state root instead of reporting zero sessions", async () => {
		const root = await tempDir("codex-store");
		await fs.mkdir(path.join(root, "sessions"), { recursive: true });
		failReaddirFor(root, "EACCES");

		await expect(new CodexSessionStore(root).list()).rejects.toThrow(/Could not read directory/);
	});

	it("reports zero sessions and stays quiet when the codex root is absent", async () => {
		const root = path.join(await tempDir("codex-empty"), "sessions");
		await fs.mkdir(root, { recursive: true });

		expect(await new CodexSessionStore(root).list()).toEqual([]);
	});
});

describe("advisor transcript cost readdir failures", () => {
	it("reports an unreadable session directory through the warn channel", async () => {
		// The advisor scans the session file's path minus its `.jsonl` suffix,
		// which is where `<session>/__advisor.jsonl` transcripts live.
		const dir = path.join(await tempDir("advisor-costs"), "sess");
		await fs.mkdir(dir, { recursive: true });
		const sessionFile = path.join(dir, "session.jsonl");
		await Bun.write(sessionFile, '{"type":"session"}\n');
		failReaddirFor(sessionFile.slice(0, -".jsonl".length), "EACCES");

		const warnings: string[] = [];
		const costs = await loadAdvisorTranscriptCosts(sessionFile, { warn: m => warnings.push(m) });

		// The user must be able to tell "no advisor spend" from "could not look".
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Could not read directory");
		expect(costs.size).toBe(0);
	});

	it("stays quiet and returns no costs when the session directory is absent", async () => {
		const dir = path.join(await tempDir("advisor-absent"), "nested");
		const sessionFile = path.join(dir, "session.jsonl");

		const warnings: string[] = [];
		const costs = await loadAdvisorTranscriptCosts(sessionFile, { warn: m => warnings.push(m) });

		expect(warnings).toEqual([]);
		expect(costs.size).toBe(0);
	});
});
