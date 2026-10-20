import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	getMemoryRoot,
	pendingMemorySnapshotCommit,
	refreshMemoryToolDeveloperInstructionsCacheAfterStartup,
	saveLearnedLesson,
	stagedMemorySnapshot,
} from "@oh-my-pi/pi-coding-agent/memories";
import { localBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/local-backend";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const MEMORY_SNAPSHOT_TYPE = "memory-snapshot";

function snapshotRecords(session: SessionManager): { scope?: string; token?: string }[] {
	const records: { scope?: string; token?: string }[] = [];
	for (const entry of session.getBranchView()) {
		if (entry.type !== "custom" || entry.customType !== MEMORY_SNAPSHOT_TYPE) continue;
		records.push((entry.data ?? {}) as { scope?: string; token?: string });
	}
	return records;
}

/** Ids of the memory snapshots the active branch records. */
function snapshotEntryIds(session: SessionManager): string[] {
	const ids: string[] = [];
	for (const entry of session.getBranchView()) {
		if (entry.type !== "custom" || entry.customType !== MEMORY_SNAPSHOT_TYPE) continue;
		ids.push(entry.id);
	}
	return ids;
}

/** The recorded memory content of the active branch. */
function snapshotContent(session: SessionManager): { summary?: string; learned?: string }[] {
	const content: { summary?: string; learned?: string }[] = [];
	for (const entry of session.getBranchView()) {
		if (entry.type !== "custom" || entry.customType !== MEMORY_SNAPSHOT_TYPE) continue;
		content.push((entry.data ?? {}) as { summary?: string; learned?: string });
	}
	return content;
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

	it("reselects the snapshot the active branch records after the leaf moves off it", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Original lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		const original = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(original).toContain("Original lesson");
		pendingMemorySnapshotCommit(session)?.();
		const firstSnapshotId = snapshotEntryIds(session)[0];
		if (!firstSnapshotId) throw new Error("Expected a recorded snapshot");

		// Startup maintenance rewrote the consolidated summary of the project.
		const memoryRoot = getMemoryRoot(agentDir, cwd);
		await fs.mkdir(memoryRoot, { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "memory_summary.md"), "Rewritten summary");
		await refreshMemoryToolDeveloperInstructionsCacheAfterStartup(
			{ sessionManager: session },
			agentDir,
			cwd,
			settings,
		);
		const rewritten = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(rewritten).toContain("Rewritten summary");
		pendingMemorySnapshotCommit(session)?.();
		expect(snapshotEntryIds(session)).toHaveLength(2);

		// The user navigates back to the first snapshot: the active branch now
		// records only the original block, and the prompt must follow it.
		session.branch(firstSnapshotId);
		const reselected = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(reselected).toContain("Original lesson");
		expect(reselected).not.toContain("Rewritten summary");
	});

	it("records the snapshot on the branch the leaf moved to", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Stable lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		});
		const assistantId = session.appendMessage(createAssistantMessage("hello"));
		await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		pendingMemorySnapshotCommit(session)?.();
		expect(snapshotEntryIds(session)).toHaveLength(1);

		// Another session learns a lesson before this one continues.
		await saveLearnedLesson(agentDir, cwd, { content: "Learned elsewhere later" });

		// The user rewinds to the message before the recorded snapshot: the
		// branch holds no snapshot of its own now.
		session.branch(assistantId);
		const block = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(block).toContain("Stable lesson");
		expect(block).not.toContain("Learned elsewhere later");

		// The new branch records the block, so a later resume restores it.
		pendingMemorySnapshotCommit(session)?.();
		expect(snapshotEntryIds(session)).toHaveLength(1);
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const resumed = await SessionManager.open(sessionFile, sessionsDir);
		const resumedBlock = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, resumed);
		expect(resumedBlock).toContain("Stable lesson");
		expect(resumedBlock).not.toContain("Learned elsewhere later");
	});

	it("discards a staged snapshot when the session switched before the prompt committed", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Source lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		const commit = pendingMemorySnapshotCommit(session);

		// The session resumes another transcript before the prompt commits.
		const target = SessionManager.create(cwd, sessionsDir);
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected a persisted session file");
		await session.setSessionFile(targetFile);

		// The staged snapshot belongs to the source transcript: recording it
		// here would make it the target's newest valid record.
		commit?.();
		expect(snapshotRecords(session)).toHaveLength(0);
	});

	it("discards a staged snapshot when the leaf moved before the prompt committed", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Stable lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		const userId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		});
		session.appendMessage(createAssistantMessage("hello"));
		await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		const commit = pendingMemorySnapshotCommit(session);

		// The user rewinds onto another branch before the prompt commits.
		session.branch(userId);

		// The branch the prompt was built for is gone: recording the snapshot
		// here would pin a block the branch never carried.
		commit?.();
		expect(snapshotRecords(session)).toHaveLength(0);
	});

	it("re-stages a pending snapshot on the branch the leaf moved to", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Stable lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		const userId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		});
		session.appendMessage(createAssistantMessage("hello"));
		await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);

		// The user rewinds onto another branch before the prompt commits. The
		// destination branch records no snapshot of its own, so the staged one
		// has to move with it.
		session.branch(userId);
		const block = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(block).toContain("Stable lesson");

		// The snapshot is recorded on the branch the prompt was built for.
		pendingMemorySnapshotCommit(session)?.();
		expect(snapshotRecords(session)).toHaveLength(1);

		// Another session learns a lesson before this one is resumed.
		await saveLearnedLesson(agentDir, cwd, { content: "Learned elsewhere later" });
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const resumed = await SessionManager.open(sessionFile, sessionsDir);
		const resumedBlock = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, resumed);
		expect(resumedBlock).toContain("Stable lesson");
		expect(resumedBlock).not.toContain("Learned elsewhere later");
	});

	it("does not adopt the consolidated summary once the first turn started", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Startup lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		pendingMemorySnapshotCommit(session)?.();

		// Startup maintenance rewrote the consolidated summary of the project.
		const memoryRoot = getMemoryRoot(agentDir, cwd);
		await fs.mkdir(memoryRoot, { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "memory_summary.md"), "Consolidated summary");

		// The first user turn is appended while the refresh re-reads the clear
		// token: the turn that went out was built from the old prompt, so the
		// consolidated summary belongs to the next session.
		let conversationChecks = 0;
		await refreshMemoryToolDeveloperInstructionsCacheAfterStartup(
			{
				sessionManager: session,
				agent: {
					state: {
						get messages(): readonly unknown[] {
							conversationChecks++;
							return conversationChecks > 2 ? [{}] : [];
						},
					},
				},
			},
			agentDir,
			cwd,
			settings,
		);

		const block = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(block).not.toContain("Consolidated summary");
	});

	it("retires the recorded snapshot when the memory files cannot be removed", async () => {
		if (process.platform === "win32") return;
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Snapshot lesson" });

		const session = SessionManager.create(cwd, sessionsDir);
		await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		pendingMemorySnapshotCommit(session)?.();

		// Another session learns a lesson before the clear.
		await saveLearnedLesson(agentDir, cwd, { content: "Disk lesson" });

		// The removal of the memory files fails: the clear token is the only
		// thing that can retire the recorded snapshot.
		const memoryRoot = getMemoryRoot(agentDir, cwd);
		await fs.chmod(memoryRoot, 0o555);
		try {
			await expect(clearMemoryData(agentDir, cwd)).rejects.toThrow();
		} finally {
			await fs.chmod(memoryRoot, 0o755);
		}

		// The recorded snapshot is retired: the block is read from the memory
		// files again instead of being restored from the snapshot.
		const block = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(block).toContain("Disk lesson");
	});

	it("cancels a staged snapshot the prompt dropped, so the next build reads the current memory", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Lesson at build time" });

		const session = SessionManager.create(cwd, sessionsDir);
		const staged = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(staged).toContain("Lesson at build time");

		// The prompt that carried the block was replaced, so the staged block is
		// cancelled instead of recorded.
		const commit = stagedMemorySnapshot(session)?.commit(["a prompt without the memory block"]);
		expect(commit).toBeUndefined();
		expect(snapshotRecords(session)).toHaveLength(0);

		// Another session learns a lesson: the next build must read the current
		// memory state instead of the cancelled block.
		await saveLearnedLesson(agentDir, cwd, { content: "Learned after the replaced prompt" });
		const rebuilt = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(rebuilt).toContain("Learned after the replaced prompt");
	});

	it("does not record a snapshot when the memory files hold nothing injectable", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();

		const session = SessionManager.create(cwd, sessionsDir);
		const block = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(block).toBeUndefined();

		// The prompt commits: an empty memory store injects nothing, so the
		// transcript must not claim a memory block.
		pendingMemorySnapshotCommit(session)?.();
		expect(snapshotRecords(session)).toHaveLength(0);

		session.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		session.appendMessage(createAssistantMessage("hello"));
		await session.flush();

		// Another session learns a lesson before this one is resumed: the
		// resumed session picks it up instead of restoring an empty block.
		await saveLearnedLesson(agentDir, cwd, { content: "Learned elsewhere" });
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const resumed = await SessionManager.open(sessionFile, sessionsDir);
		const rebuilt = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, resumed);
		expect(rebuilt).toContain("Learned elsewhere");
	});

	it("records the snapshot on the branch the prompt is built for after a navigation", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const cwd = settings.getCwd();
		await saveLearnedLesson(agentDir, cwd, { content: "Lesson at build time" });

		const session = SessionManager.create(cwd, sessionsDir);
		const messageId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		});
		session.appendMessage(createAssistantMessage("hello"));
		await session.flush();

		const block = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		if (!block) throw new Error("Expected a memory block");
		expect(block).toContain("Lesson at build time");
		pendingMemorySnapshotCommit(session)?.();
		expect(snapshotRecords(session)).toHaveLength(1);

		// The user navigates back to the first user message: the branch moves
		// off the snapshot, and no prompt is rebuilt, so the snapshot must be
		// staged for the branch the user continued on.
		session.branch(messageId);
		expect(snapshotRecords(session)).toHaveLength(0);

		const recorder = stagedMemorySnapshot(session)?.commit([block]);
		expect(recorder).toBeDefined();
		recorder?.();
		expect(snapshotRecords(session)).toHaveLength(1);
	});

	it("records only the memory content the prompt injects", async () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.summaryInjectionTokenLimit": 100 });
		const cwd = settings.getCwd();
		const memoryRoot = getMemoryRoot(agentDir, cwd);
		await fs.mkdir(memoryRoot, { recursive: true });
		await fs.writeFile(path.join(memoryRoot, "learned.md"), `- ${"L".repeat(20_000)}\n`);

		const session = SessionManager.create(cwd, sessionsDir);
		const block = await buildMemoryToolDeveloperInstructions(agentDir, cwd, settings, session);
		expect(block).toContain("LLLL");
		pendingMemorySnapshotCommit(session)?.();

		// The recorded content is the injected block's, not the whole file: a
		// transcript must not grow with the memory store.
		const recorded = snapshotContent(session)[0];
		expect(recorded?.learned?.length ?? 0).toBeLessThan(1_000);
	});
});
