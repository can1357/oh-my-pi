import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { removeWithRetries, TempDir } from "@pk-nerdsaver-ai/pi-utils";

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
		const header = JSON.parse(lines[0]) as Record<string, unknown>;
		header.cwd = "";
		lines[0] = JSON.stringify(header);
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

	it("falls back to the launch cwd when opening a session whose project directory is gone", async () => {
		const launch = makeTempDir("@pi-cwd-launch-");
		const store = makeTempDir("@pi-cwd-store-");
		const goneProject = makeTempDir("@pi-cwd-gone-");
		const file = await writeSession(goneProject, store);
		await removeWithRetries(goneProject);

		const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: launch });

		expect(manager.getCwd()).toBe(path.resolve(launch));
		// /new and /branch anchor to the launch cwd, not the deleted project's store.
		expect(manager.getSessionDir()).toBe(SessionManager.getDefaultSessionDir(launch));
		expect(manager.getSessionDir()).not.toBe(path.resolve(store));
	});
});
