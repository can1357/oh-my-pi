import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listOfflineSessions } from "@oh-my-pi/pi-coding-agent/messaging/mailbox";
import { listLocalSessionsWithRegisteredFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
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
	vi.restoreAllMocks();
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
	test("a custom marker whose transcript parent became a file does not hide a valid managed offline session", async () => {
		const agentDir = makeTempDir("omp-agent-");
		const parent = path.join(agentDir, "custom");
		const staleFile = path.join(parent, "stopped.jsonl");
		await Bun.write(staleFile, "{}\n");
		await Bun.write(path.join(getCustomSessionFilesDir(agentDir), hashPath(staleFile)), staleFile);
		await fs.promises.rm(parent, { recursive: true });
		await Bun.write(parent, "now a regular file");
		if (process.platform === "win32") {
			// Windows reports ENOENT here; expose POSIX ENOTDIR at the same
			// filesystem boundary while keeping the managed inventory real.
			const stat = fs.promises.stat;
			const statSpy = spyOn(fs.promises, "stat") as unknown as {
				mockImplementation(implementation: (file: fs.PathLike) => Promise<fs.Stats>): void;
			};
			statSpy.mockImplementation(async file => {
				if (file === staleFile) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
				return stat(file);
			});
		}
		const managedFile = path.join(getSessionsDir(agentDir), "project", "valid.jsonl");
		await Bun.write(
			managedFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "valid-managed-session",
				cwd: agentDir,
				timestamp: new Date().toISOString(),
				title: "offline recipient",
				titleSource: "user",
			})}\n`,
		);
		const sessions = await listOfflineSessions({
			sessions: () => listLocalSessionsWithRegisteredFiles({ agentDir }),
		});
		expect(sessions.map(session => ({ id: session.sessionId, path: session.path, name: session.name }))).toEqual([
			{ id: "valid-managed-session", path: managedFile, name: "offline recipient" },
		]);
	});

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
