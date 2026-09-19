import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

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
	try {
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await manager.rewriteEntries();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		return file;
	} finally {
		await manager.close();
	}
}

async function readHeaderCwd(sessionFile: string): Promise<string> {
	const header = (await loadEntriesFromFile(sessionFile)).find(entry => entry.type === "session");
	if (!header) throw new Error("expected a persisted session header");
	return header.cwd;
}

describe("SessionManager cwd adoption on resume", () => {
	it("separates execution cwd from persistent home and restores both after relocation", async () => {
		const home = makeTempDir("@pi-cwd-home-");
		const execution = makeTempDir("@pi-cwd-execution-");
		const relocation = makeTempDir("@pi-cwd-relocation-");
		const store = makeTempDir("@pi-cwd-store-");
		const relocationStore = makeTempDir("@pi-cwd-relocation-store-");
		const manager = SessionManager.create(home, store);
		try {
			manager.appendMessage({ role: "user", content: "before fallback", timestamp: 1 });
			await manager.ensureOnDisk();
			const originalFile = manager.getSessionFile();
			if (!originalFile) throw new Error("expected a persisted session file");
			const artifactId = await manager.saveArtifact("home-owned artifact", "read");
			if (!artifactId) throw new Error("expected a persisted artifact");
			const originalArtifact = await manager.getArtifactPath(artifactId);
			if (!originalArtifact) throw new Error("expected an artifact path");

			manager.setCwdWithoutRelocation(execution);
			manager.appendMessage({ role: "user", content: "executed elsewhere", timestamp: 2 });
			await manager.flush();

			expect(manager.getCwd()).toBe(path.resolve(execution));
			expect(manager.getSessionHome()).toBe(path.resolve(home));
			expect(manager.getSessionFile()).toBe(originalFile);
			expect(await readHeaderCwd(originalFile)).toBe(path.resolve(home));
			expect(await manager.getArtifactPath(artifactId)).toBe(originalArtifact);
			expect(await Bun.file(originalArtifact).text()).toBe("home-owned artifact");

			const snapshot = manager.captureState();
			await manager.moveTo(relocation, relocationStore);
			expect(manager.getCwd()).toBe(path.resolve(relocation));
			expect(manager.getSessionHome()).toBe(path.resolve(relocation));

			await manager.rollbackMove(snapshot);
			expect(manager.getCwd()).toBe(path.resolve(execution));
			expect(manager.getSessionHome()).toBe(path.resolve(home));
			expect(manager.getSessionFile()).toBe(originalFile);
			expect(await readHeaderCwd(originalFile)).toBe(path.resolve(home));
			expect(await manager.getArtifactPath(artifactId)).toBe(originalArtifact);
			expect(await Bun.file(originalArtifact).text()).toBe("home-owned artifact");
		} finally {
			await manager.close();
		}
	});

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
		try {
			await manager.setSessionFile(fileB);

			expect(manager.getCwd()).toBe(path.resolve(projectA));
			expect(manager.getSessionHome()).toBe(path.resolve(projectA));
			expect(manager.getRecordedCwd()).toBe("");
			expect(manager.getSessionDir()).toBe(path.resolve(launchDir));
			expect(await readHeaderCwd(fileB)).toBe("");

			const newFile = await manager.newSession();
			if (!newFile) throw new Error("expected a new persisted session");
			expect(manager.getSessionHome()).toBe(path.resolve(projectA));
			expect(manager.getRecordedCwd()).toBe(path.resolve(projectA));
			expect(await readHeaderCwd(newFile)).toBe(path.resolve(projectA));
		} finally {
			await manager.close();
		}
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
		try {
			await manager.setSessionFile(file);

			// Adopting the missing cwd would make the follow-up `setProjectDir` chdir
			// throw, so resume stays put while the recorded home remains authoritative.
			expect(manager.getCwd()).toBe(path.resolve(launch));
			expect(manager.getSessionHome()).toBe(path.resolve(goneProject));
			expect(manager.getSessionDir()).toBe(path.resolve(launchSessions));
			manager.appendMessage({ role: "user", content: "continued after fallback", timestamp: 2 });
			await manager.flush();
			expect(await readHeaderCwd(file)).toBe(path.resolve(goneProject));
		} finally {
			await manager.close();
		}

		const reopened = await SessionManager.open(file, undefined, undefined, { initialCwd: launch });
		try {
			expect(reopened.getCwd()).toBe(path.resolve(launch));
			expect(reopened.getSessionHome()).toBe(path.resolve(goneProject));
			expect(await readHeaderCwd(file)).toBe(path.resolve(goneProject));
		} finally {
			await reopened.close();
		}
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

	it.each(["new", "fork", "branch"] as const)(
		"homes a %s session at execution cwd after runtime-only fallback",
		async operation => {
			const home = makeTempDir(`@pi-cwd-${operation}-home-`);
			const execution = makeTempDir(`@pi-cwd-${operation}-execution-`);
			const store = makeTempDir(`@pi-cwd-${operation}-store-`);
			const agentDir = makeTempDir(`@pi-cwd-${operation}-agent-`);
			const originalFile = await writeSession(home, store);
			await removeWithRetries(home);
			const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
			const originalOmpProfile = process.env.OMP_PROFILE;
			const originalPiProfile = process.env.PI_PROFILE;
			let manager: SessionManager | undefined;
			try {
				setAgentDir(agentDir);
				manager = await SessionManager.open(originalFile, undefined, undefined, { initialCwd: execution });
				expect(manager.getCwd()).toBe(path.resolve(execution));
				expect(manager.getSessionHome()).toBe(path.resolve(home));
				const leafId = manager.getLeafId();
				if (!leafId) throw new Error("expected a branchable user entry");

				let newFile: string | undefined;
				switch (operation) {
					case "new":
						newFile = await manager.newSession();
						break;
					case "fork":
						newFile = (await manager.fork())?.newSessionFile;
						break;
					case "branch":
						newFile = manager.createBranchedSession(leafId);
						break;
				}
				if (!newFile) throw new Error(`expected ${operation} to create a persisted session`);

				const expectedSessionDir = SessionManager.getDefaultSessionDir(execution, agentDir);
				expect(path.dirname(newFile)).toBe(expectedSessionDir);
				expect(manager.getCwd()).toBe(path.resolve(execution));
				expect(manager.getSessionHome()).toBe(path.resolve(execution));
				expect(await readHeaderCwd(newFile)).toBe(path.resolve(execution));
				expect(await readHeaderCwd(originalFile)).toBe(path.resolve(home));
			} finally {
				try {
					await manager?.close();
				} finally {
					restoreEnv("PI_CODING_AGENT_DIR", originalPiCodingAgentDir);
					restoreEnv("OMP_PROFILE", originalOmpProfile);
					restoreEnv("PI_PROFILE", originalPiProfile);
					__resetDirsFromEnvForTests();
				}
			}
		},
	);
});
