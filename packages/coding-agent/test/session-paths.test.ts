import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeDefaultSessionDir,
	resolveReadOnlySessionDirCandidates,
} from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const cleanup: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function legacySessionDir(sessionsRoot: string, cwd: string): string {
	const name = `--${path
		.resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return path.join(sessionsRoot, name);
}

afterEach(() => {
	for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("legacy session directory migration", () => {
	test("keeps a colliding live legacy session reachable through its path", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const source = path.join(legacyDir, "active.jsonl");
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(source, "live-before\n");
		fs.writeFileSync(destination, "stale\n");
		const fd = fs.openSync(source, "a");

		computeDefaultSessionDir(cwd, storage, sessionsRoot);
		fs.writeSync(fd, "live-after\n");
		fs.closeSync(fd);

		expect(fs.readFileSync(source, "utf8")).toBe("live-before\nlive-after\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("stale\n");
	});

	test("preserves writes when an older process recreates its cached legacy directory", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.writeFileSync(destination, "canonical\n");

		fs.mkdirSync(legacyDir, { recursive: true });
		const recreated = path.join(legacyDir, "active.jsonl");
		fs.writeFileSync(recreated, "older-process-write\n");
		computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(fs.readFileSync(recreated, "utf8")).toBe("older-process-write\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("canonical\n");
	});
});

describe("read-only session discovery", () => {
	test("resolves canonical and legacy candidates without materializing the sessions root", () => {
		const parent = makeTempDir("omp-session-parent-");
		const sessionsRoot = path.join(parent, "sessions");
		const cwd = makeTempDir("omp-session-cwd-");

		const candidates = resolveReadOnlySessionDirCandidates(cwd, sessionsRoot);

		expect(fs.existsSync(sessionsRoot)).toBe(false);
		expect(candidates).toContain(legacySessionDir(sessionsRoot, cwd));
		expect(candidates[0]).toBe(
			path.join(
				sessionsRoot,
				path.basename(computeDefaultSessionDir(cwd, new FileSessionStorage(), makeTempDir("omp-session-root-"))),
			),
		);
	});

	test("includes the legacy home candidate without scanning or migrating it", () => {
		const sessionsRoot = path.join(makeTempDir("omp-session-parent-"), "sessions");
		const home = os.homedir();
		const legacyHomeName = `--${home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

		const candidates = resolveReadOnlySessionDirCandidates(home, sessionsRoot);

		expect(candidates).toContain(path.join(sessionsRoot, legacyHomeName));
		expect(fs.existsSync(sessionsRoot)).toBe(false);
	});

	test("lists canonical and legacy sessions without recovering orphaned backups", async () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const [canonicalDir, legacyDir, hashedDir] = resolveReadOnlySessionDirCandidates(cwd, sessionsRoot);
		expect(legacyDir).toBe(legacySessionDir(sessionsRoot, cwd));
		const backupPath = path.join(canonicalDir, "orphan.jsonl.1.bak");
		fs.mkdirSync(canonicalDir, { recursive: true });
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(
			path.join(canonicalDir, "canonical.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "canonical", cwd, timestamp: "2026-09-06T10:00:00.000Z" })}\n`,
		);
		fs.writeFileSync(
			path.join(legacyDir, "legacy.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "legacy", cwd, timestamp: "2026-09-06T11:00:00.000Z" })}\n`,
		);
		fs.mkdirSync(hashedDir, { recursive: true });
		fs.writeFileSync(
			path.join(hashedDir, "hashed.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "hashed", cwd, timestamp: "2026-09-06T10:30:00.000Z" })}\n`,
		);
		fs.writeFileSync(
			backupPath,
			`${JSON.stringify({ type: "session", version: 3, id: "orphan", cwd, timestamp: "2026-09-06T12:00:00.000Z" })}\n`,
		);

		const sessions = await SessionManager.listReadOnly(cwd, { sessionsRoot, storage });

		expect(new Set(sessions.map(session => session.id))).toEqual(new Set(["legacy", "hashed", "canonical"]));
		expect(fs.existsSync(backupPath)).toBe(true);
		expect(fs.existsSync(path.join(canonicalDir, "orphan.jsonl"))).toBe(false);
	});
});
