import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	pendingMemorySnapshotCommit,
	refreshMemoryToolDeveloperInstructionsCacheAfterStartup,
	saveLearnedLesson,
} from "@oh-my-pi/pi-coding-agent/memories";
import { localBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/local-backend";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const MEMORY_SNAPSHOT_TYPE = "memory-snapshot";

function snapshotRecords(session: SessionManager): { scope?: string; token?: string }[] {
	return session
		.getBranchView()
		.filter(entry => entry.type === "custom" && entry.customType === MEMORY_SNAPSHOT_TYPE)
		.map(entry => (entry.data ?? {}) as { scope?: string; token?: string });
}

describe("memory snapshot across a resume", () => {
	let tmp: string;
	let agentDir: string;
	let sessionsDir: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-snapshot-"));
		agentDir = path.join(tmp, "agent");
		sessionsDir = path.join(tmp, "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
	});
	afterEach(async () => {
		await removeWithRetries(tmp);
	});

	it("rebuilds a resumed session's memory block from its transcript, not from later lessons", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Known at session start" });

		const session = SessionManager.create(cwd, sessionsDir);
		const sent = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(sent).toContain("Known at session start");
		pendingMemorySnapshotCommit(session)?.();
		session.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		session.appendMessage(createAssistantMessage("hello"));
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");

		// Another session learns a lesson before this one is resumed.
		await saveLearnedLesson(agentDir, cwd, { content: "Learned elsewhere later" });

		const resumed = await SessionManager.open(sessionFile, sessionsDir);
		const rebuilt = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, resumed);
		expect(rebuilt).toBe(sent);
		expect(rebuilt).not.toContain("Learned elsewhere later");

		// A fresh session reads the memory files and sees the later lesson.
		const fresh = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, SessionManager.inMemory(cwd));
		expect(fresh).toContain("Learned elsewhere later");
	});

	it("records the snapshot only once the prompt commits", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Committed lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(snapshotRecords(session)).toHaveLength(0);

		pendingMemorySnapshotCommit(session)?.();
		expect(snapshotRecords(session)).toHaveLength(1);
	});

	it("does not restore memory that was cleared after the snapshot was recorded", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Cleared lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		const before = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(before).toContain("Cleared lesson");
		pendingMemorySnapshotCommit(session)?.();
		const messageId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		});
		session.appendMessage(createAssistantMessage("hello"));
		await session.flush();

		await localBackend.clear(agentDir, cwd, { sessionManager: session } as unknown as AgentSession);
		const afterClear = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(afterClear).toBeUndefined();
		pendingMemorySnapshotCommit(session)?.();

		// The user navigates back to the entry before the post-clear snapshot and
		// keeps talking, so the resumed session's branch holds the pre-clear one.
		session.branch(messageId);
		session.appendMessage({ role: "user", content: [{ type: "text", text: "again" }], timestamp: Date.now() });
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const resumed = await SessionManager.open(sessionFile, sessionsDir);
		const resumedBlock = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, resumed);
		expect(resumedBlock).toBeUndefined();
	});

	it("ignores a snapshot appended after a clear that still carries the pre-clear token", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Cleared lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		pendingMemorySnapshotCommit(session)?.();
		const recorded = snapshotRecords(session)[0];
		expect(recorded?.token).toBeDefined();

		await localBackend.clear(agentDir, cwd, { sessionManager: session } as unknown as AgentSession);
		// A snapshot recorded from a read that raced the clear still carries the
		// old token: it must not restore the cleared memory.
		session.appendCustomEntry(MEMORY_SNAPSHOT_TYPE, {
			summary: "",
			learned: "Cleared lesson",
			scope: recorded?.scope,
			token: recorded?.token,
		});

		const block = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(block).toBeUndefined();
	});

	it("does not adopt memory that was cleared before the startup refresh ran", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Startup lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		pendingMemorySnapshotCommit(session)?.();

		await localBackend.clear(agentDir, cwd, { sessionManager: session } as unknown as AgentSession);
		await refreshMemoryToolDeveloperInstructionsCacheAfterStartup(
			{ sessionManager: session },
			agentDir,
			cwd,
			settings,
		);

		const block = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(block).toBeUndefined();
	});

	it("does not restore a snapshot recorded for another project scope", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const projectA = path.join(tmp, "project-a");
		const projectB = path.join(tmp, "project-b");
		await fs.mkdir(projectA, { recursive: true });
		await fs.mkdir(projectB, { recursive: true });
		await saveLearnedLesson(agentDir, projectA, { content: "Project A lesson" });

		const session = SessionManager.create(projectA, sessionsDir);
		const inProjectA = await buildMemoryToolDeveloperInstructions(agentDir, projectA, settings, session);
		expect(inProjectA).toContain("Project A lesson");
		pendingMemorySnapshotCommit(session)?.();

		// The session is relocated to another project: the recorded snapshot
		// belongs to project A and must not be injected there.
		const inProjectB = await buildMemoryToolDeveloperInstructions(agentDir, projectB, settings, session);
		expect(inProjectB).toBeUndefined();
	});
});
