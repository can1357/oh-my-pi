import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeDefaultSessionDir,
	hasPositiveMovedProjectEvidence,
	readCwdIdentity,
	writeTerminalBreadcrumb,
} from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import {
	getAgentDir,
	getCustomSessionFilesDir,
	getSessionsDir,
	getTerminalSessionsDir,
	hashPath,
	setAgentDir,
} from "@oh-my-pi/pi-utils";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";

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
	test.each([false, true])(
		"recovers hashed home-scoped sessions when the temp root is inside home (collision: %s)",
		withCollision => {
			const root = makeTempDir("omp-shadowed-home-");
			const home = path.join(root, "home");
			const tempRoot = path.join(home, "tmp");
			const cwd = path.join(tempRoot, "project");
			const sessionsRoot = path.join(root, "sessions");
			fs.mkdirSync(cwd, { recursive: true });
			const canonical = resolveEquivalentPath(path.resolve(cwd));
			const digest = Bun.SHA256.hash(canonical.replaceAll("\\", "/"), "hex");
			const oldDir = path.join(sessionsRoot, `home-project-${digest}`);
			const canonicalDir = path.join(sessionsRoot, "-tmp-project");
			const transcript = Buffer.from('{"type":"session","id":"saved","note":"你好"}\r\n');
			fs.mkdirSync(oldDir, { recursive: true });
			fs.writeFileSync(path.join(oldDir, "saved.jsonl"), transcript);
			if (withCollision) {
				fs.mkdirSync(canonicalDir);
				fs.writeFileSync(path.join(oldDir, "active.jsonl"), "legacy\n");
				fs.writeFileSync(path.join(canonicalDir, "active.jsonl"), "canonical\n");
			}
			const homeMock = vi.spyOn(os, "homedir").mockReturnValue(home);
			try {
				const tempMock = vi.spyOn(os, "tmpdir").mockReturnValue(tempRoot);
				try {
					const destination = computeDefaultSessionDir(cwd, new FileSessionStorage(), sessionsRoot);
					expect(destination).toBe(canonicalDir);
					expect(fs.readFileSync(path.join(destination, "saved.jsonl"))).toEqual(transcript);
					if (withCollision) {
						expect(fs.readFileSync(path.join(oldDir, "active.jsonl"), "utf8")).toBe("legacy\n");
						expect(fs.readFileSync(path.join(destination, "active.jsonl"), "utf8")).toBe("canonical\n");
					} else {
						expect(fs.existsSync(oldDir)).toBe(false);
					}
				} finally {
					tempMock.mockRestore();
				}
			} finally {
				homeMock.mockRestore();
			}
		},
	);

	test("keeps normal home and temp session directory names", () => {
		const root = makeTempDir("omp-session-scopes-");
		const home = path.join(root, "home");
		const tempRoot = path.join(root, "tmp");
		const sessionsRoot = path.join(root, "sessions");
		const homeCwd = path.join(home, "project");
		const tempCwd = path.join(tempRoot, "project");
		fs.mkdirSync(homeCwd, { recursive: true });
		fs.mkdirSync(tempCwd, { recursive: true });
		const homeMock = vi.spyOn(os, "homedir").mockReturnValue(home);
		try {
			const tempMock = vi.spyOn(os, "tmpdir").mockReturnValue(tempRoot);
			try {
				const storage = new FileSessionStorage();
				expect(computeDefaultSessionDir(homeCwd, storage, sessionsRoot)).toBe(path.join(sessionsRoot, "-project"));
				expect(computeDefaultSessionDir(tempCwd, storage, sessionsRoot)).toBe(
					path.join(sessionsRoot, "-tmp-project"),
				);
			} finally {
				tempMock.mockRestore();
			}
		} finally {
			homeMock.mockRestore();
		}
	});

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

describe("hasPositiveMovedProjectEvidence", () => {
	test("is true only when the continue cwd is the same directory inode", () => {
		const from = makeTempDir("omp-cwd-from-");
		const sibling = makeTempDir("omp-cwd-unrelated-");
		const identity = readCwdIdentity(from);
		expect(identity).toBeDefined();
		expect(hasPositiveMovedProjectEvidence(identity, sibling)).toBe(false);

		const to = path.join(path.dirname(from), `${path.basename(from)}-renamed`);
		fs.renameSync(from, to);
		cleanup.push(to);
		expect(hasPositiveMovedProjectEvidence(identity, to)).toBe(true);
		expect(hasPositiveMovedProjectEvidence(undefined, to)).toBe(false);
	});
});

describe("custom session-file registry", () => {
	test("records an exact relocated session file and skips managed JSONL files", () => {
		const agentDir = makeTempDir("omp-agent-");
		const cwd = makeTempDir("omp-cwd-");
		const originalAgentDir = getAgentDir();
		setAgentDir(agentDir);
		try {
			// A relative extensionless --session path resolves against cwd and
			// lands in the registry as the exact file, not its parent directory.
			writeTerminalBreadcrumb(cwd, path.join(".omp-sessions", "work"));
			const expectedFile = path.join(cwd, ".omp-sessions", "work");
			const marker = path.join(getCustomSessionFilesDir(agentDir), hashPath(expectedFile));
			expect(fs.readFileSync(marker, "utf8")).toBe(expectedFile);

			// A JSONL transcript under the managed sessions root is covered by
			// the root glob scan and never registered individually.
			const managedFile = path.join(getSessionsDir(agentDir), "project", "s.jsonl");
			writeTerminalBreadcrumb(cwd, managedFile);
			const managedMarker = path.join(getCustomSessionFilesDir(agentDir), hashPath(managedFile));
			expect(fs.existsSync(managedMarker)).toBe(false);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});

	test("leaves identical breadcrumb and marker files unwritten when the same session is recorded again", () => {
		const agentDir = makeTempDir("omp-agent-");
		const cwd = makeTempDir("omp-cwd-");
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		process.env.TMUX_PANE = "%pointer-write-test";
		setAgentDir(agentDir);
		try {
			const terminalId = getTerminalId();
			if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
			const sessionFile = path.join(cwd, "custom.jsonl");
			writeTerminalBreadcrumb(cwd, sessionFile);
			const crumb = path.join(getTerminalSessionsDir(agentDir), terminalId);
			const marker = path.join(getCustomSessionFilesDir(agentDir), hashPath(sessionFile));
			const written = new Date(Date.now() - 60_000);
			fs.utimesSync(crumb, written, written);
			fs.utimesSync(marker, written, written);

			// Resume/re-adopt re-records the same pointer: no disk write.
			writeTerminalBreadcrumb(cwd, sessionFile);
			expect(fs.statSync(crumb).mtimeMs).toBe(written.getTime());
			expect(fs.statSync(marker).mtimeMs).toBe(written.getTime());

			// A changed pointer (fresh lazy boundary) still lands.
			writeTerminalBreadcrumb(cwd, sessionFile, true);
			expect(fs.readFileSync(crumb, "utf8").split("\n")).toContain("fresh");
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
		}
	});

	test("records no marker for a session on a non-filesystem storage backend", async () => {
		const globalAgentDir = makeTempDir("omp-agent-global-");
		const cwd = makeTempDir("omp-cwd-");
		const originalAgentDir = getAgentDir();
		setAgentDir(globalAgentDir);
		try {
			// A marker naming the backend's virtual path could only ever dangle:
			// gc reads markers' targets from disk.
			const remote = SessionManager.create(cwd, path.join(cwd, "virtual"), new MemorySessionStorage());
			await remote.close();
			const registry = getCustomSessionFilesDir(globalAgentDir);
			expect(fs.existsSync(registry) ? fs.readdirSync(registry) : []).toEqual([]);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});
});

describe("relative session directory", () => {
	test("stores the session file under an absolute path", async () => {
		const cwd = makeTempDir("omp-cwd-");
		// `--session-dir ./sess` arrives relative to the process cwd.
		const relativeDir = path.relative(process.cwd(), path.join(cwd, "sess"));
		const manager = SessionManager.create(cwd, relativeDir, new MemorySessionStorage());
		try {
			expect(manager.getSessionDir()).toBe(path.join(cwd, "sess"));
			const file = manager.getSessionFile();
			expect(file && path.isAbsolute(file)).toBe(true);
			expect(path.dirname(file!)).toBe(path.join(cwd, "sess"));
		} finally {
			await manager.close();
		}
	});
});
