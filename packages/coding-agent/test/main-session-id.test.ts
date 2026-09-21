/**
 * `--session-id <id>` create-or-resume semantics (issue #12484):
 * exact id match resumes, anything else creates with the prescribed id,
 * and mixing with --resume/--session/--continue/--fork/--no-session fails.
 */
import { describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, SessionResolutionError } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function buildArgs(extra: Partial<Args>, sessionDir?: string): Args {
	return {
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		...extra,
	};
}

const stubSettings = { get: () => undefined } as unknown as Settings;

describe("createSessionManager --session-id", () => {
	it("rejects mixing with resume/continue/no-session", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-id-"));
		for (const extra of [
			{ resume: "abc" },
			{ continue: true },
			{ noSession: true },
			{ fork: "abc" },
		] as Partial<Args>[]) {
			await expect(
				createSessionManager(buildArgs({ sessionId: "pane-1", ...extra }), cwd, stubSettings),
			).rejects.toBeInstanceOf(SessionResolutionError);
		}
	});

	it("rejects paths and empty ids", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-id-"));
		for (const sessionId of ["", "a/b", "x.jsonl"]) {
			await expect(createSessionManager(buildArgs({ sessionId }), cwd, stubSettings)).rejects.toBeInstanceOf(
				SessionResolutionError,
			);
		}
	});

	it("creates a new session with the prescribed id when none matches", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-id-"));
		const sessionDir = path.join(cwd, "sessions");
		const manager = await createSessionManager(
			buildArgs({ sessionId: "zellij-pane-123" }, sessionDir),
			cwd,
			stubSettings,
		);
		expect(manager?.getSessionId()).toBe("zellij-pane-123");
	});

	it("resumes on exact id match", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-id-"));
		const sessionDir = path.join(cwd, "sessions");
		const seeded = SessionManager.create(cwd, sessionDir);
		seeded.appendMessage({ role: "user", content: "seeded", timestamp: Date.now() });
		await seeded.rewriteEntries();
		const seededId = seeded.getSessionId();

		const manager = await createSessionManager(buildArgs({ sessionId: seededId }, sessionDir), cwd, stubSettings);
		expect(manager?.getSessionId()).toBe(seededId);
	});

	it("does not resume on a mere prefix (exact match only)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-id-"));
		const sessionDir = path.join(cwd, "sessions");
		const seeded = SessionManager.create(cwd, sessionDir);
		seeded.appendMessage({ role: "user", content: "seeded", timestamp: Date.now() });
		await seeded.rewriteEntries();
		const prefix = seeded.getSessionId().slice(0, 8);

		const manager = await createSessionManager(buildArgs({ sessionId: prefix }, sessionDir), cwd, stubSettings);
		expect(manager?.getSessionId()).toBe(prefix);
	});
});
