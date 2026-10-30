import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as piUtils from "@oh-my-pi/pi-utils";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPiProfile = process.env.PI_PROFILE;
const originalOmpProfile = process.env.OMP_PROFILE;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

beforeEach(() => {
	setAgentDir(path.join(makeTempDir("@pi-cwd-agent-dir-"), "agent"));
});

afterEach(async () => {
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("PI_PROFILE", originalPiProfile);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	__resetDirsFromEnvForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/**
 * Persist a single-message session under `cwd`/`sessionDir` and return its file path.
 * The on-disk header records `cwd`, which is what resume adoption keys off of.
 */
async function writeSession(cwd: string, sessionDir: string): Promise<string> {
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	await manager.rewriteEntries();
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a persisted session file");
	return file;
}

/** Counts whole-file reads, the I/O a resume spends on a session below the streaming threshold. */
class CountingFileSessionStorage extends FileSessionStorage {
	fullReads = 0;

	override readText(filePath: string): Promise<string> {
		this.fullReads++;
		return super.readText(filePath);
	}
}

describe("SessionManager cwd adoption on resume", () => {
	it("adopts the resumed session's own cwd and session directory", async () => {
		const projectA = makeTempDir("@pi-cwd-a-");
		const projectB = makeTempDir("@pi-cwd-b-");
		const sessionsB = path.join(projectB, "sessions");
		const fileB = await writeSession(projectB, sessionsB);

		// A manager started in project A loads a session that lives in project B.
		const manager = SessionManager.create(projectA, path.join(projectA, "sessions"));
		expect(manager.getCwd()).toBe(path.resolve(projectA));

		await manager.setSessionFile(fileB);

		expect(manager.getCwd()).toBe(path.resolve(projectB));
		expect(manager.getSessionDir()).toBe(path.resolve(sessionsB));
		// New session/fork targets must follow the adopted directory, not the launch one.
		expect(manager.getHeader()?.cwd).toBe(path.resolve(projectB));
	});

	it("leaves cwd untouched when the resumed session has no recorded cwd", async () => {
		const projectA = makeTempDir("@pi-cwd-a-");
		const projectB = makeTempDir("@pi-cwd-b-");
		const sessionsB = path.join(projectB, "sessions");
		const fileB = await writeSession(projectB, sessionsB);

		// Simulate a legacy session whose header predates the cwd field.
		const raw = await Bun.file(fileB).text();
		const lines = raw.split("\n").filter(Boolean);
		// The fixed-width title slot is line 0 now; edit the session header itself.
		const headerIndex = lines.findIndex(line => {
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				return parsed.type === "session";
			} catch {
				return false;
			}
		});
		const header = JSON.parse(lines[headerIndex]) as Record<string, unknown>;
		header.cwd = "";
		lines[headerIndex] = JSON.stringify(header);
		await Bun.write(fileB, `${lines.join("\n")}\n`);

		const launchDir = path.join(projectA, "sessions");
		const manager = SessionManager.create(projectA, launchDir);
		await manager.setSessionFile(fileB);

		expect(manager.getCwd()).toBe(path.resolve(projectA));
		expect(manager.getSessionDir()).toBe(path.resolve(launchDir));
	});

	it("restores cwd and session directory when a switch is rolled back", async () => {
		const projectA = makeTempDir("@pi-cwd-a-");
		const projectB = makeTempDir("@pi-cwd-b-");
		const sessionsA = path.join(projectA, "sessions");
		const sessionsB = path.join(projectB, "sessions");
		const fileB = await writeSession(projectB, sessionsB);

		const manager = SessionManager.create(projectA, sessionsA);
		const snapshot = manager.captureState();

		await manager.setSessionFile(fileB);
		expect(manager.getCwd()).toBe(path.resolve(projectB));

		manager.restoreState(snapshot);
		expect(manager.getCwd()).toBe(path.resolve(projectA));
		expect(manager.getSessionDir()).toBe(path.resolve(sessionsA));
	});
	it("clears fallback persistence after adopting an accessible session", async () => {
		const launch = makeTempDir("@pi-cwd-fallback-launch-");
		const deniedProject = makeTempDir("@pi-cwd-fallback-denied-");
		const store = makeTempDir("@pi-cwd-fallback-store-");
		const launchSessions = path.join(launch, "sessions");
		const deniedFile = await writeSession(deniedProject, store);
		const accessibleFile = await writeSession(launch, launchSessions);
		await removeWithRetries(deniedProject);

		const manager = await SessionManager.open(deniedFile, undefined, undefined, { initialCwd: launch });
		await manager.setSessionFile(accessibleFile);
		await manager.addWorkspaceDirectory(path.join(launch, "extra"));
		await manager.flush();
		await manager.close();

		const reopened = await SessionManager.open(accessibleFile);
		try {
			expect(reopened.getAdditionalDirectories()).toContain(path.join(launch, "extra"));
		} finally {
			await reopened.close();
		}
	});

	it("keeps the current cwd when the resumed session's project directory is gone", async () => {
		const launch = makeTempDir("@pi-cwd-launch-");
		const store = makeTempDir("@pi-cwd-store-");
		const goneProject = makeTempDir("@pi-cwd-gone-");
		// The session file survives in `store` (like ~/.omp), but its header cwd
		// points at a project directory that we then delete.
		const file = await writeSession(goneProject, store);
		await removeWithRetries(goneProject);

		const launchSessions = path.join(launch, "sessions");
		const manager = SessionManager.create(launch, launchSessions);
		await manager.setSessionFile(file);

		// Adopting the missing cwd would make the follow-up `setProjectDir` chdir
		// throw, so resume stays put instead.
		expect(manager.getCwd()).toBe(path.resolve(launch));
		expect(manager.getSessionDir()).toBe(path.resolve(launchSessions));
	});

	it("falls back to the launch cwd with one full read when the recorded project directory is gone", async () => {
		const launch = makeTempDir("@pi-cwd-launch-");
		const store = makeTempDir("@pi-cwd-store-");
		const goneProject = makeTempDir("@pi-cwd-gone-");
		const file = await writeSession(goneProject, store);
		await removeWithRetries(goneProject);
		const storage = new CountingFileSessionStorage();

		const manager = await SessionManager.open(file, undefined, storage, { initialCwd: launch });

		expect(manager.getCwd()).toBe(path.resolve(launch));
		// /new and /branch anchor to the launch cwd, not the deleted project's store.
		expect(manager.getSessionDir()).toBe(SessionManager.getDefaultSessionDir(launch));
		expect(manager.getSessionDir()).not.toBe(path.resolve(store));
		expect(storage.fullReads).toBe(1);
	});
	it("reads an unchanged fail-closed session once to parse and once to confirm it is unchanged", async () => {
		const project = makeTempDir("@pi-cwd-fail-closed-");
		const sessionDir = path.join(project, "sessions");
		const file = await writeSession(project, sessionDir);
		const storage = new CountingFileSessionStorage();

		const manager = await SessionManager.open(file, undefined, storage, { throwIfMissing: true });

		expect(manager.getSessionFile()).toBe(path.resolve(file));
		// A second parse of the unchanged file would read it a third time.
		expect(storage.fullReads).toBe(2);
		await manager.close();
	});

	it("adopts a same-length in-place rewrite made during the cwd probe that kept size, mtime, and inode", async () => {
		const project = makeTempDir("@pi-cwd-in-place-");
		const file = await writeSession(project, path.join(project, "sessions"));
		// Whole-millisecond timestamps survive utimes exactly, so the rewrite below
		// leaves size, mtime, and inode all equal to what open() first parsed.
		const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
		fs.utimesSync(file, stamp, stamp);
		const inode = fs.statSync(file).ino;
		const probe = spyOn(piUtils, "directoryIsEnterable").mockImplementationOnce(async () => {
			const original = fs.readFileSync(file, "utf8");
			fs.writeFileSync(file, original.replace('"content":"hello"', '"content":"HELLO"'));
			fs.utimesSync(file, stamp, stamp);
			return true;
		});
		try {
			const manager = await SessionManager.open(file, undefined, new FileSessionStorage(), { throwIfMissing: true });
			expect(probe).toHaveBeenCalledTimes(1);
			expect(fs.statSync(file).ino).toBe(inode);
			const turns = manager
				.getEntries()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
				);
			expect(turns).toEqual(["HELLO"]);
			await manager.close();
		} finally {
			probe.mockRestore();
		}
	});
});
