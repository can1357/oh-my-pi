import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Two omp windows on one session file. The second window's full-file rewrite
 * leaves the first holding a stale size token, so its next publish is rejected.
 */
describe("SessionManager with a concurrent writer on the same file", () => {
	let temp: TempDir;
	let sessionDir: string;
	let storage: FileSessionStorage;

	beforeEach(() => {
		temp = TempDir.createSync("@pi-session-concurrent-writer-");
		sessionDir = temp.path();
		storage = new FileSessionStorage();
	});

	afterEach(() => {
		setSystemTime();
		vi.restoreAllMocks();
		temp[Symbol.dispose]();
	});

	it("keeps persisting after another process rewrites the file", async () => {
		const first = SessionManager.create(sessionDir, sessionDir, storage);
		first.appendMessage({ role: "user", content: "mine before", timestamp: Date.now() });
		await first.flush();
		const sessionFile = first.getSessionFile();
		expect(sessionFile).toBeTruthy();
		if (!sessionFile) return;

		// Second window: opens the same file, appends, publishes a full rewrite.
		const second = await SessionManager.open(sessionFile, sessionDir, storage, {});
		second.appendMessage({ role: "user", content: "theirs", timestamp: Date.now() });
		await second.rewriteEntries();
		await second.flush();

		// First window writes on with a stale size token.
		first.appendMessage({ role: "user", content: "mine after", timestamp: Date.now() });
		await first.rewriteEntries().catch(() => undefined);
		await first.flush().catch(() => undefined);
		// Let the reconcile pass drain.
		await first.flush().catch(() => undefined);

		const persisted = await Bun.file(sessionFile).text();
		expect(persisted).toContain("mine before");
		expect(persisted).toContain("mine after");
		expect(persisted).toContain("theirs");

		// And the session is still writable, not latched dead.
		first.appendMessage({ role: "user", content: "still alive", timestamp: Date.now() });
		await first.flush();
		expect(await Bun.file(sessionFile).text()).toContain("still alive");
	});

	it("keeps warning while the session stays unsaved", async () => {
		const manager = SessionManager.create(sessionDir, sessionDir, storage);
		await manager.ensureOnDisk();
		const warnings: string[] = [];
		manager.onPersistenceError(error => warnings.push(error.message));

		const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		spyOn(storage, "writeTextAtomic").mockImplementation(() => Promise.reject(failure));
		spyOn(storage, "writeTextSync").mockImplementation(() => {
			throw failure;
		});
		spyOn(fs, "writeSync").mockImplementation(() => {
			throw failure;
		});

		manager.appendMessage({ role: "user", content: "first unsaved turn", timestamp: Date.now() });
		await manager.flush().catch(() => undefined);
		expect(warnings).toHaveLength(1);

		// Same broken store, a minute of further work: the user hears about it again.
		setSystemTime(new Date(Date.now() + 60_000));
		manager.appendMessage({ role: "user", content: "later unsaved turn", timestamp: Date.now() });
		await manager.flush().catch(() => undefined);
		expect(warnings.length).toBeGreaterThan(1);
	});

	it("reports the session unsaved once reconciling keeps losing", async () => {
		const manager = SessionManager.create(sessionDir, sessionDir, storage);
		await manager.ensureOnDisk();
		const warnings: string[] = [];
		manager.onPersistenceError(error => warnings.push(error.message));
		const sessionFile = manager.getSessionFile() ?? "";
		// Every publish loses the race: another writer always got there first.
		spyOn(storage, "writeTextAtomic").mockImplementation(() =>
			Promise.reject(new SessionWriteConflictError(sessionFile, 1, 2)),
		);

		for (let turn = 0; turn < 10 && warnings.length === 0; turn++) {
			manager.appendMessage({ role: "user", content: `turn ${turn}`, timestamp: Date.now() });
			await manager.rewriteEntries().catch(() => undefined);
			await manager.flush().catch(() => undefined);
		}

		expect(warnings.length).toBeGreaterThan(0);
	});
});
