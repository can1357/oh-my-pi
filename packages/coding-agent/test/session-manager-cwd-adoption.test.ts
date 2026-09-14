import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
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
		class CountingFileSessionStorage extends FileSessionStorage {
			fullReads = 0;

			override readText(filePath: string): Promise<string> {
				this.fullReads++;
				return super.readText(filePath);
			}
		}
		const storage = new CountingFileSessionStorage();

		const manager = await SessionManager.open(file, undefined, storage, { initialCwd: launch });

		expect(manager.getCwd()).toBe(path.resolve(launch));
		// /new and /branch anchor to the launch cwd, not the deleted project's store.
		expect(manager.getSessionDir()).toBe(SessionManager.getDefaultSessionDir(launch));
		expect(manager.getSessionDir()).not.toBe(path.resolve(store));
		expect(storage.fullReads).toBe(1);
	});

	it("clears settings ownership when a root is removed on the fallback path", async () => {
		const launch = makeTempDir("@pi-cwd-fallback-own-launch-");
		const store = makeTempDir("@pi-cwd-fallback-own-store-");
		const goneProject = makeTempDir("@pi-cwd-fallback-own-gone-");
		const extra = makeTempDir("@pi-cwd-fallback-own-extra-");

		// Seed a session whose header records `extra` as a SETTINGS-OWNED root.
		const seed = SessionManager.create(goneProject, store);
		seed.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await seed.addWorkspaceDirectory(extra);
		await seed.setSettingsOwnedDirectories([path.resolve(extra)]);
		await seed.rewriteEntries();
		const file = seed.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		await seed.close();

		// The recorded project directory is gone, so resume keeps the launch cwd
		// and marks the session fallback-runtime-only.
		await removeWithRetries(goneProject);
		const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: launch });
		expect(manager.getSettingsOwnedDirectories()).toContain(path.resolve(extra));

		// Remove the settings-owned root, then manually re-add it — both on the
		// fallback path. Pre-fix `removeWorkspaceDirectory` returned early before
		// the ownership cleanup, so `extra` stayed settings-owned and a later
		// settings refresh that dropped the configured root would revoke the
		// independently re-added one.
		await manager.removeWorkspaceDirectory(extra);
		await manager.addWorkspaceDirectory(extra);

		try {
			expect(manager.getAdditionalDirectories()).toContain(path.resolve(extra));
			expect(manager.getSettingsOwnedDirectories()).not.toContain(path.resolve(extra));
		} finally {
			await manager.close();
		}
	});
});
