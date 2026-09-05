import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../../src/cli/args";
import { Settings } from "../../src/config/settings";
import { hasLiveDaemonProjectPresence, registerDaemonProjectPresence } from "../../src/launch/presence";
import { runRootCommand } from "../../src/main";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";

/**
 * The `sessionId`/`title` fields added to the presence record must be purely
 * additive: an older `omp` on the same machine never writes them, and a
 * reader that only understands `{pid, id, projectDir}` (the pre-existing
 * shape `hasLiveDaemonProjectPresence` itself parses) must keep working
 * against both an old-format record and a new one that carries them.
 */
describe("daemon presence session identity field", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		while (dirs.length) {
			await fs.rm(dirs.pop() ?? "", { recursive: true, force: true });
		}
	});

	async function tmpProject(): Promise<{ projectDir: string; runtimeDir: string }> {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-presence-session-"));
		dirs.push(projectDir);
		return { projectDir, runtimeDir: path.join(projectDir, "runtime") };
	}

	it("writes sessionId and title when a session is supplied", async () => {
		const { projectDir, runtimeDir } = await tmpProject();
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir, {
			sessionId: "019fee60-2c7a-7000-9fd5-7439c7bf3dd2",
			title: "Refactor the launcher",
		});
		try {
			const clientsDir = path.join(runtimeDir, "clients");
			const [entry] = await fs.readdir(clientsDir);
			const record = await Bun.file(path.join(clientsDir, entry!)).json();
			expect(record).toMatchObject({
				sessionId: "019fee60-2c7a-7000-9fd5-7439c7bf3dd2",
				title: "Refactor the launcher",
				pid: process.pid,
			});
		} finally {
			await presence.close();
		}
	});

	it("omits sessionId and title entirely when no session is supplied, matching the pre-field record shape", async () => {
		const { projectDir, runtimeDir } = await tmpProject();
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		try {
			const clientsDir = path.join(runtimeDir, "clients");
			const [entry] = await fs.readdir(clientsDir);
			const record = await Bun.file(path.join(clientsDir, entry!)).json();
			expect(record).not.toHaveProperty("sessionId");
			expect(record).not.toHaveProperty("title");
			expect(record).toEqual({
				id: expect.any(String),
				pid: process.pid,
				projectDir: expect.any(String),
			});
		} finally {
			await presence.close();
		}
	});

	it("hasLiveDaemonProjectPresence reports liveness from a legacy record with no sessionId/title field at all", async () => {
		const { runtimeDir } = await tmpProject();
		const clientsDir = path.join(runtimeDir, "clients");
		await fs.mkdir(clientsDir, { recursive: true });
		// Simulated write from an omp build that predates this field: exactly the
		// old three-key shape, nothing more.
		await Bun.write(
			path.join(clientsDir, `${process.pid}-legacy.json`),
			JSON.stringify({ pid: process.pid, id: `${process.pid}-legacy`, projectDir: runtimeDir }),
		);

		// Degrades to "alive, session unknown": liveness still reads correctly
		// from the pid alone, and no exception is thrown reading a record that
		// lacks the newer fields.
		await expect(hasLiveDaemonProjectPresence(runtimeDir)).resolves.toBe(true);
	});

	it("updates sessionId and title in place when update is called", async () => {
		const { projectDir, runtimeDir } = await tmpProject();
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		try {
			const clientsDir = path.join(runtimeDir, "clients");
			const [entry] = await fs.readdir(clientsDir);
			const initialRecord = await Bun.file(path.join(clientsDir, entry!)).json();
			expect(initialRecord).not.toHaveProperty("sessionId");

			await presence.update({
				sessionId: "019fee60-2c7a-7000-9fd5-7439c7bf3dd2",
				title: "Initial session",
			});

			const updatedRecord = await Bun.file(path.join(clientsDir, entry!)).json();
			expect(updatedRecord).toMatchObject({
				id: expect.any(String),
				pid: process.pid,
				sessionId: "019fee60-2c7a-7000-9fd5-7439c7bf3dd2",
				title: "Initial session",
			});

			await presence.update({
				sessionId: "019fee61-0000-7000-9000-111122223333",
				title: "Switched session",
			});

			const transitionedRecord = await Bun.file(path.join(clientsDir, entry!)).json();
			expect(transitionedRecord).toMatchObject({
				id: expect.any(String),
				pid: process.pid,
				sessionId: "019fee61-0000-7000-9000-111122223333",
				title: "Switched session",
			});
		} finally {
			await presence.close();
		}
	});

	it("populates sessionId on default launch and updates on session transition", async () => {
		const { projectDir, runtimeDir } = await tmpProject();
		// Isolate the launch from the developer's real environment the way every
		// other runRootCommand test does: ambient auth discovery and on-disk
		// settings would otherwise decide whether startup reaches session
		// creation at all, so the test would pass or hang depending on whose
		// machine it runs on.
		const authStorage = await AuthStorage.create(path.join(projectDir, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs([]);
		parsed.cwd = projectDir;
		parsed.sessionDir = path.join(projectDir, "sessions");
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;

		// Observations are collected inside the launch and asserted after it
		// returns: an exception thrown from an injected callback is swallowed by
		// startup's own error handling, which would turn a real regression into a
		// runner timeout instead of a named failure.
		let resolvePresenceUpdated: (() => void) | undefined;
		let capturedSession: AgentSession | undefined;
		let launchSessionId: string | undefined;
		let transitionSessionId: string | undefined;
		let launchRecord: unknown;
		let transitionedRecord: unknown;
		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => authStorage,
				settings,
				registerDaemonProjectPresence: async (pDir, _rOverride, initialSession) => {
					const presence = await registerDaemonProjectPresence(pDir, runtimeDir, initialSession);
					const originalUpdate = presence.update.bind(presence);
					presence.update = async sess => {
						await originalUpdate(sess);
						resolvePresenceUpdated?.();
					};
					return presence;
				},
				runInteractiveMode: async session => {
					capturedSession = session;
					const clientsDir = path.join(runtimeDir, "clients");
					const [entry] = await fs.readdir(clientsDir);
					const presenceFile = path.join(clientsDir, entry!);
					launchSessionId = session.sessionManager.getSessionId();
					launchRecord = await Bun.file(presenceFile).json();

					const updated = Promise.withResolvers<void>();
					resolvePresenceUpdated = updated.resolve;
					await session.newSession();
					transitionSessionId = session.sessionManager.getSessionId();
					// Bounded wait: when nothing refreshes the record the test must
					// report a stale sessionId, not hang until the runner gives up.
					await Promise.race([updated.promise, Bun.sleep(5_000)]);
					transitionedRecord = await Bun.file(presenceFile).json();
				},
			});
		} finally {
			authStorage.close();
		}

		expect(capturedSession).toBeDefined();
		// The launch registers the session it actually created, not nothing.
		expect(launchRecord).toMatchObject({ sessionId: launchSessionId });
		// `/new` mints a different id in the same process...
		expect(transitionSessionId).not.toBe(launchSessionId);
		// ...and the record a supervisor reads follows it.
		expect(transitionedRecord).toMatchObject({ sessionId: transitionSessionId });
		await capturedSession?.dispose();
	}, 30_000);
});
