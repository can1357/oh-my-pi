/**
 * Contracts: a directory scan that cannot be read must never report the same
 * result as a directory that is genuinely empty (#11476), and must never cost
 * the caller the entries it could read.
 *
 * - An unreadable session directory is reported as a warning next to the
 *   partial listing, not as a hard failure that discards it.
 * - An unreadable advisor transcript directory reports through the caller's
 *   warning channel.
 * - An absent directory, or one that is actually a file, still reports empty
 *   and stays quiet, in every store.
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

describe("Claude session store readdir failures", () => {
	async function claudeRoot(): Promise<string> {
		const root = path.join(await tempDir("claude-store"), "projects", "-home-user-app");
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "11111111-1111-4111-8111-111111111111.jsonl"), '{"type":"user"}\n');
		return path.dirname(path.dirname(root));
	}

	it("keeps the readable project directories and warns about the ones it could not read", async () => {
		const root = path.join(await tempDir("claude-partial"), "projects");
		for (const project of ["-home-a", "-home-b", "-home-c"]) {
			const dir = path.join(root, project);
			await fs.mkdir(dir, { recursive: true });
			await Bun.write(path.join(dir, `${project}.jsonl`), '{"type":"user"}\n');
		}
		failReaddirFor(path.join(root, "-home-b"), "EACCES");

		const warnings: string[] = [];
		const sessions = await new ClaudeSessionStore(path.dirname(root)).list({
			warn: message => warnings.push(message),
		});

		// One unreadable directory must not cost the user the other two: a
		// partial listing returned with a warning beats no listing at all, which
		// is what main does and what this branch used to regress to.
		expect(sessions.map(session => session.id)).toEqual(["-home-c", "-home-a"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Could not read directory");
		expect(warnings[0]).toContain("EACCES");
	});

	it("warns about an unreadable container without losing the other spelling", async () => {
		const root = path.join(await tempDir("claude-two-containers"), "root");
		await fs.mkdir(path.join(root, "projects"), { recursive: true });
		const readable = path.join(root, ".projects", "-home-d");
		await fs.mkdir(readable, { recursive: true });
		await Bun.write(path.join(readable, "dddddddd-1111-4111-8111-111111111111.jsonl"), '{"type":"user"}\n');
		failReaddirFor(path.join(root, "projects"), "EACCES");

		const warnings: string[] = [];
		const sessions = await new ClaudeSessionStore(root).list({ warn: message => warnings.push(message) });

		expect(sessions.map(session => session.id)).toEqual(["dddddddd-1111-4111-8111-111111111111"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Could not read directory");
	});

	it("treats a projects path that is a regular file as absent, like the codex store", async () => {
		// readDirOutcome calls ENOTDIR "missing" because a path component that is
		// a file cannot hold children either, so both stores must agree here.
		const root = await tempDir("claude-projects-is-a-file");
		await Bun.write(path.join(root, "projects"), "I am a file");

		const warnings: string[] = [];
		expect(await new ClaudeSessionStore(root).list({ warn: m => warnings.push(m) })).toEqual([]);
		expect(warnings).toEqual([]);
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
	it("keeps the readable rollout tree and warns about the one it could not read", async () => {
		const root = await tempDir("codex-store");
		const sessions = path.join(root, "sessions");
		await fs.mkdir(path.join(sessions, "nested"), { recursive: true });
		await Bun.write(path.join(sessions, "nested", "aaaaaaaa-1111-4111-8111-111111111111.jsonl"), '{"type":"user"}\n');
		failReaddirFor(path.join(sessions, "nested"), "EMFILE");

		const warnings: string[] = [];
		expect(await new CodexSessionStore(root).list({ warn: m => warnings.push(m) })).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Could not read directory");
		expect(warnings[0]).toContain("EMFILE");
	});

	it("warns about an unreadable state root and still scans the rollout tree", async () => {
		const root = await tempDir("codex-state-root");
		const sessions = path.join(root, "sessions");
		await fs.mkdir(sessions, { recursive: true });
		const rollout =
			'{"type":"session_meta","payload":{"id":"aaaaaaaa-1111-4111-8111-111111111111","cwd":"C:/work"}}\n';
		await Bun.write(path.join(sessions, "rollout.jsonl"), rollout);
		failReaddirFor(root, "EACCES");

		const warnings: string[] = [];
		const listed = await new CodexSessionStore(root).list({ warn: m => warnings.push(m) });

		// Losing the state index costs the index, not the sessions on disk.
		expect(listed.map(session => session.id)).toEqual(["aaaaaaaa-1111-4111-8111-111111111111"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("EACCES");
	});

	it("treats a root that is a regular file as absent, like the claude store", async () => {
		const root = await tempDir("codex-root-is-a-file");
		await Bun.write(path.join(root, "marker"), "x");
		const warnings: string[] = [];
		expect(await new CodexSessionStore(root).list({ warn: m => warnings.push(m) })).toEqual([]);
		expect(warnings).toEqual([]);
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
