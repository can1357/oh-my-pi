import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { archiveSession } from "@oh-my-pi/pi-coding-agent/archive/archive";
import { runRenderCommand } from "@oh-my-pi/pi-coding-agent/cli/render-cli";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import {
	isValidSessionHeader,
	parseSessionFileName,
	parseSessionHeaderText,
	readSessionHeader,
	readSessionHeaderSync,
	rewriteSessionHeaderParentText,
} from "@oh-my-pi/pi-coding-agent/session/session-header";
import {
	closeSessionIndex,
	deleteMissingSessionLineageUnderDirectory,
	deleteSessionLineage,
	getChildSessions,
	getSessionLineage,
	lookupSessionTitle,
	recordSessionLineage,
	recordSessionLineages,
	repointSessionLineageUnderDirectory,
	resolveParentSessionReference,
	salvageSessionIndex,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { listSessionsForPicker } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { packSession, unpackSession } from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { getConfigRootDir, getHistoryDbPath, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";
import { makeAssistantMessage } from "../session-manager/helpers";

describe("session_lineage index", () => {
	let testAgentDir = "";
	let cwd = "";
	let otherCwd = "";
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		HistoryStorage.close();
		closeSessionIndex();
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-lineage-"));
		cwd = path.join(testAgentDir, "project-a");
		otherCwd = path.join(testAgentDir, "project-b");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(otherCwd, { recursive: true });
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		HistoryStorage.close();
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (testAgentDir) {
			removeSyncWithRetries(testAgentDir);
			testAgentDir = "";
		}
	});

	async function createPersistedSession(title?: string, projectDir = cwd): Promise<{ id: string; file: string }> {
		const session = SessionManager.create(projectDir);
		session.appendMessage({ role: "user", content: `work in ${title ?? "root"}`, timestamp: 1 });
		if (title) await session.setSessionName(title, "user");
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const id = session.getSessionId();
		const file = session.getSessionFile();
		if (!file) throw new Error("expected persisted session file");
		await session.close();
		return { id, file };
	}

	it("records root, forked, and branched sessions and resolves parent->children via idx_session_lineage_parent without reading child files", async () => {
		const root = await createPersistedSession("Root session");

		const forked = await SessionManager.forkFrom(root.file, cwd);
		forked.appendMessage({ role: "user", content: "forked follow-up", timestamp: 2 });
		forked.appendMessage(makeAssistantMessage());
		await forked.flush();
		const forkId = forked.getSessionId();
		const forkFile = forked.getSessionFile()!;
		await forked.close();

		const branchedOpener = await SessionManager.open(root.file);
		const leafId = branchedOpener.getLeafId();
		if (!leafId) throw new Error("expected branch leaf id");
		const branchFile = branchedOpener.createBranchedSession(leafId)!;
		const branchId = branchedOpener.getSessionId();
		await branchedOpener.flush();
		await branchedOpener.close();

		expect(getSessionLineage(root.id)).toMatchObject({
			sessionId: root.id,
			parentSessionId: null,
			sessionPath: path.resolve(root.file),
			cwd: path.resolve(cwd),
		});
		expect(getSessionLineage(forkId)).toMatchObject({
			sessionId: forkId,
			parentSessionId: root.id,
			sessionPath: path.resolve(forkFile),
			cwd: path.resolve(cwd),
		});
		expect(getSessionLineage(branchId)).toMatchObject({
			sessionId: branchId,
			parentSessionId: root.id,
			sessionPath: path.resolve(branchFile),
			cwd: path.resolve(cwd),
		});

		// Truncate child session files to prove getChildSessions resolves purely from history.db.
		fs.truncateSync(forkFile, 0);
		fs.truncateSync(branchFile, 0);

		const childrenById = getChildSessions(root.id);
		expect(childrenById.map(child => child.sessionId).sort()).toEqual([branchId, forkId].sort());
		const childrenByPath = getChildSessions(root.file);
		expect(childrenByPath.map(child => child.sessionId).sort()).toEqual([branchId, forkId].sort());

		using db = new Database(getHistoryDbPath(), { readonly: true });
		const plan = db
			.query<{ detail: string }, []>(
				"EXPLAIN QUERY PLAN SELECT session_id FROM session_lineage WHERE parent_session_id = 'probe'",
			)
			.all()
			.map(row => row.detail)
			.join(" ");
		expect(plan).toContain("idx_session_lineage_parent");
	});

	it("updates session_path and cwd on relocation, evicts superseded custom-path owners, and deletes dropped sessions", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "relocate me", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sessionId = session.getSessionId();

		await session.moveTo(otherCwd);
		const movedFile = session.getSessionFile()!;
		await session.close();

		expect(getSessionLineage(sessionId)).toMatchObject({
			sessionId,
			parentSessionId: null,
			sessionPath: path.resolve(movedFile),
			cwd: path.resolve(otherCwd),
		});

		const sharedPath = path.join(otherCwd, "custom.jsonl");
		recordSessionLineage({ sessionId: "first-owner", parentSession: null, sessionPath: sharedPath, cwd: otherCwd });
		recordSessionLineage({
			sessionId: "second-owner",
			parentSession: sessionId,
			sessionPath: sharedPath,
			cwd: otherCwd,
		});
		expect(getSessionLineage("first-owner")).toBeUndefined();
		expect(getSessionLineage(sharedPath)?.sessionId).toBe("second-owner");

		const dropper = SessionManager.create(otherCwd);
		await dropper.dropSession(movedFile);
		await dropper.close();
		expect(getSessionLineage(sessionId)).toBeUndefined();
	});

	it("enriches preliminary picker rows with indexed cwd and parentSessionPath and backfills legacy forks", async () => {
		const root = await createPersistedSession("Parent title");
		const fork = await SessionManager.forkFrom(root.file, cwd);
		await fork.setSessionName("Fork title", "user");
		fork.appendMessage({ role: "user", content: "fork turn", timestamp: 2 });
		fork.appendMessage(makeAssistantMessage());
		await fork.flush();
		const forkFile = fork.getSessionFile()!;
		const forkId = fork.getSessionId();
		await fork.close();

		// Truncate the fork file so preliminary rows must come from history.db alone.
		fs.truncateSync(forkFile, 0);

		const listing = await SessionManager.listForPicker(cwd);
		const preliminaryFork = listing.sessions.find(entry => entry.id === forkId);
		expect(preliminaryFork).toMatchObject({
			id: forkId,
			path: forkFile,
			cwd: path.resolve(cwd),
			title: "Fork title",
			parentSessionPath: path.resolve(root.file),
		});
		await listing.complete;

		// Write a legacy unindexed fork directly to disk and verify complete backfills session_lineage.
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		const legacyId = Bun.randomUUIDv7();
		const legacyFile = path.join(sessionDir, `2025-02-01T00-00-00-000Z_${legacyId}.jsonl`);
		fs.writeFileSync(
			legacyFile,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: legacyId,
				timestamp: "2025-02-01T00:00:00.000Z",
				cwd,
				title: "Legacy fork",
				parentSession: root.file,
			})}\n`,
		);

		const nextListing = await SessionManager.listForPicker(cwd);
		await nextListing.complete;
		expect(getSessionLineage(legacyId)).toMatchObject({
			sessionId: legacyId,
			parentSessionId: root.id,
			sessionPath: path.resolve(legacyFile),
			cwd: path.resolve(cwd),
		});
	});

	it("resolves fork parent UUIDs to parent file paths in archiveSession and salvages lineage across quarantine", async () => {
		const root = await createPersistedSession("Archive root");
		const fork = await SessionManager.forkFrom(root.file, cwd);
		fork.appendMessage({ role: "user", content: "fork prompt", timestamp: 2 });
		fork.appendMessage(makeAssistantMessage());
		await fork.flush();
		const forkId = fork.getSessionId();
		const forkFile = fork.getSessionFile()!;
		await fork.close();

		await HistoryStorage.open().add("fork prompt", cwd, forkId);
		const detail = await archiveSession(forkFile, 5);
		expect(detail.records.parent).toBe(path.resolve(root.file));
		expect(detail.records.prompts.map(entry => entry.text)).toEqual(["fork prompt"]);

		HistoryStorage.close();
		closeSessionIndex();
		using source = new Database(getHistoryDbPath(), { readonly: true });
		const targetPath = path.join(testAgentDir, "salvaged-history.db");
		using target = new Database(targetPath, { create: true });
		const salvaged = salvageSessionIndex(source, target);
		expect(salvaged.lineages).toBeGreaterThanOrEqual(2);
		const salvagedFork = target
			.query<{ parent_session_id: string | null; session_path: string }, [string]>(
				"SELECT parent_session_id, session_path FROM session_lineage WHERE session_id = ?",
			)
			.get(forkId);
		expect(salvagedFork).toEqual({
			parent_session_id: root.id,
			session_path: path.resolve(forkFile),
		});
	});

	it("prefers batch/indexed exact-path and file-header ids over stale timestamped filenames", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const movedFile = path.join(otherCwd, "moved.jsonl");
		const reusedPath = path.join(sessionDir, "2025-02-01T00-00-00-000Z_old-id.jsonl");

		fs.writeFileSync(
			movedFile,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: "old-id",
				timestamp: "2025-02-01T00:00:00.000Z",
				cwd: otherCwd,
			})}\n`,
		);
		recordSessionLineage({
			sessionId: "old-id",
			parentSession: null,
			sessionPath: movedFile,
			cwd: otherCwd,
		});

		// Opening a missing timestamped path mints a fresh header id while keeping `..._old-id.jsonl`.
		const reused = await SessionManager.open(reusedPath);
		const newId = reused.getSessionId();
		expect(newId).not.toBe("old-id");
		reused.appendMessage({ role: "user", content: "reused path turn", timestamp: 2 });
		reused.appendMessage(makeAssistantMessage());
		await reused.flush();
		await reused.close();

		const child = await SessionManager.forkFrom(reusedPath, cwd);
		child.appendMessage({ role: "user", content: "child of reused path", timestamp: 3 });
		child.appendMessage(makeAssistantMessage());
		await child.flush();
		const childId = child.getSessionId();
		await child.close();

		expect(getSessionLineage(movedFile)?.sessionId).toBe("old-id");
		expect(getSessionLineage(reusedPath)?.sessionId).toBe(newId);
		expect(getChildSessions(newId).map(entry => entry.sessionId)).toEqual([childId]);
		expect(getChildSessions(reusedPath).map(entry => entry.sessionId)).toEqual([childId]);
		expect(getChildSessions("old-id")).toEqual([]);

		// Clear session_lineage and verify batch backfill (`recordSessionLineages`) also resolves `newId` via batchPathToId/header.
		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("DELETE FROM session_lineage");
		}
		const listing = await SessionManager.listForPicker(cwd);
		await listing.complete;
		expect(getSessionLineage(reusedPath)?.sessionId).toBe(newId);
		expect(getSessionLineage(childId)?.parentSessionId).toBe(newId);
		expect(getChildSessions(newId).map(entry => entry.sessionId)).toEqual([childId]);
		expect(getChildSessions("old-id")).toEqual([]);
	});

	it("extracts parent session id from unindexed parent headers larger than 8 KiB", () => {
		const largeParentId = Bun.randomUUIDv7();
		const largeParentFile = path.join(cwd, "unindexed-large-parent.jsonl");
		const additionalDirectories = Array.from({ length: 180 }, (_, index) =>
			path.join(cwd, `extra-dir-${String(index).padStart(3, "0")}-${"x".repeat(120)}`),
		);
		const headerLine = `${JSON.stringify({
			type: "session",
			version: 4,
			id: largeParentId,
			timestamp: "2025-02-01T00:00:00.000Z",
			cwd,
			additionalDirectories,
		})}\n`;
		expect(Buffer.byteLength(headerLine, "utf8")).toBeGreaterThan(20 * 1024);
		fs.writeFileSync(largeParentFile, headerLine);

		const childPath = path.join(cwd, "child-of-large-parent.jsonl");
		recordSessionLineage({
			sessionId: "child-large-header",
			parentSession: largeParentFile,
			sessionPath: childPath,
			cwd,
		});

		expect(getSessionLineage("child-large-header")?.parentSessionId).toBe(largeParentId);
		expect(getChildSessions(largeParentId).map(entry => entry.sessionId)).toEqual(["child-large-header"]);
	});

	it("leaves copied session files at a different path out of preliminary indexed rows so project-a lineage never leaks onto project-b", async () => {
		const parentA = await createPersistedSession("Parent A", cwd);
		const forkA = await SessionManager.forkFrom(parentA.file, cwd);
		await forkA.setSessionName("Project A fork", "user");
		forkA.appendMessage({ role: "user", content: "work in project-a", timestamp: 2 });
		forkA.appendMessage(makeAssistantMessage());
		await forkA.flush();
		const sharedId = forkA.getSessionId();
		await forkA.close();

		// Ensure project-b has at least one indexed session so `listing.sessions` exercises the preliminary pass.
		const nativeB = await createPersistedSession("Native B", otherCwd);

		const otherSessionDir = SessionManager.getDefaultSessionDir(otherCwd);
		fs.mkdirSync(otherSessionDir, { recursive: true });
		const copyBFile = path.join(otherSessionDir, `2025-02-03T00-00-00-000Z_${sharedId}.jsonl`);
		fs.writeFileSync(
			copyBFile,
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: sharedId,
					timestamp: "2025-02-03T00:00:00.000Z",
					cwd: otherCwd,
					title: "Project B copy",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-02-03T00:00:01.000Z",
					message: { role: "user", content: "copied turn", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-02-03T00:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);

		const listing = await SessionManager.listForPicker(otherCwd);
		expect(listing.sessions.map(entry => entry.id)).toEqual([nativeB.id]);

		const complete = await listing.complete;
		const scannedCopy = complete.find(entry => entry.id === sharedId);
		expect(scannedCopy).toMatchObject({
			id: sharedId,
			path: copyBFile,
			cwd: path.resolve(otherCwd),
			title: "Project B copy",
		});
		expect(scannedCopy?.parentSessionPath).toBeUndefined();
	});

	it("removes session_lineage rows when FileSessionStorage.deleteSessionWithArtifacts deletes a session without wiping another copy's row", async () => {
		const root = await createPersistedSession("Picker root", cwd);
		const child = await SessionManager.forkFrom(root.file, cwd);
		child.appendMessage({ role: "user", content: "picker child turn", timestamp: 2 });
		child.appendMessage(makeAssistantMessage());
		await child.flush();
		const childId = child.getSessionId();
		const childFile = child.getSessionFile()!;
		await child.close();

		const storage = new FileSessionStorage();

		// Deleting an unindexed copy of `root` at another path must not delete `root`'s lineage row at `root.file`.
		const otherCopy = path.join(otherCwd, path.basename(root.file));
		fs.copyFileSync(root.file, otherCopy);
		await storage.deleteSessionWithArtifacts(otherCopy);
		expect(getSessionLineage(root.id)?.sessionPath).toBe(path.resolve(root.file));

		// Picker deletion of the indexed child session removes its lineage row immediately.
		await storage.deleteSessionWithArtifacts(childFile);
		expect(getSessionLineage(childId)).toBeUndefined();
		expect(getSessionLineage(childFile)).toBeUndefined();
		expect(getChildSessions(root.id)).toEqual([]);
	});

	it("performs zero redundant session_lineage writes on repeat picker scans when a child references an unindexed external parent path", async () => {
		const externalParentId = Bun.randomUUIDv7();
		const externalParentFile = path.join(otherCwd, "external-parent.jsonl");
		fs.writeFileSync(
			externalParentFile,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: externalParentId,
				timestamp: "2025-02-04T00:00:00.000Z",
				cwd: otherCwd,
			})}\n`,
		);

		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const childId = Bun.randomUUIDv7();
		const childFile = path.join(sessionDir, `2025-02-04T00-01-00-000Z_${childId}.jsonl`);
		fs.writeFileSync(
			childFile,
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: childId,
					timestamp: "2025-02-04T00:01:00.000Z",
					cwd,
					title: "External child",
					parentSession: externalParentFile,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-02-04T00:01:01.000Z",
					message: { role: "user", content: "child prompt", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-02-04T00:01:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);

		const firstListing = await SessionManager.listForPicker(cwd);
		await firstListing.complete;
		expect(getSessionLineage(childId)?.parentSessionId).toBe(externalParentId);
		expect(getSessionLineage(externalParentId)).toBeUndefined();

		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("UPDATE session_lineage SET updated_at = 111 WHERE session_id = ?", [childId]);
			db.run("CREATE TABLE lineage_write_audit (n INTEGER NOT NULL)");
			db.run(
				"CREATE TRIGGER trg_lineage_insert AFTER INSERT ON session_lineage BEGIN INSERT INTO lineage_write_audit VALUES (1); END",
			);
			db.run(
				"CREATE TRIGGER trg_lineage_update AFTER UPDATE ON session_lineage BEGIN INSERT INTO lineage_write_audit VALUES (1); END",
			);
		}

		const secondListing = await SessionManager.listForPicker(cwd);
		await secondListing.complete;

		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath(), { readonly: true });
			const writes = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM lineage_write_audit").get();
			const row = db
				.query<{ updated_at: number }, [string]>("SELECT updated_at FROM session_lineage WHERE session_id = ?")
				.get(childId);
			expect(writes?.count).toBe(0);
			expect(row?.updated_at).toBe(111);
		}
	});

	it("preserves an existing explicit parent file path in archiveSession even when another copy with the same id is indexed elsewhere", async () => {
		const sharedParentId = Bun.randomUUIDv7();
		const parentAFile = path.join(cwd, "parent-a.jsonl");
		const parentBFile = path.join(otherCwd, "parent-b.jsonl");

		fs.writeFileSync(
			parentAFile,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: sharedParentId,
				timestamp: "2025-02-05T00:00:00.000Z",
				cwd,
			})}\n`,
		);
		fs.writeFileSync(
			parentBFile,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: sharedParentId,
				timestamp: "2025-02-05T00:00:00.000Z",
				cwd: otherCwd,
			})}\n`,
		);
		recordSessionLineage({
			sessionId: sharedParentId,
			parentSession: null,
			sessionPath: parentBFile,
			cwd: otherCwd,
		});

		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const childId = Bun.randomUUIDv7();
		const childFile = path.join(sessionDir, `2025-02-05T00-01-00-000Z_${childId}.jsonl`);
		fs.writeFileSync(
			childFile,
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: childId,
					timestamp: "2025-02-05T00:01:00.000Z",
					cwd,
					parentSession: parentAFile,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-02-05T00:01:01.000Z",
					message: { role: "user", content: "archive child prompt", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-02-05T00:01:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);

		await HistoryStorage.open().add("archive child prompt", cwd, childId);
		const detail = await archiveSession(childFile, 5);
		expect(detail.records.parent).toBe(parentAFile);
		expect(detail.records.prompts.map(entry => entry.text)).toEqual(["archive child prompt"]);
		{
			using db = new Database(getHistoryDbPath(), { readonly: true });
			const row = db
				.query<{ prompt: string }, [string]>("SELECT prompt FROM history WHERE session_id = ?")
				.get(childId);
			expect(row?.prompt).toBe("archive child prompt");
		}

		// A timestamped parent path in project-a is also preserved while on disk, then resolves to project-b once relocated/removed.
		const timestampedParentA = path.join(cwd, `2025-02-05T00-00-00-000Z_${sharedParentId}.jsonl`);
		fs.copyFileSync(parentAFile, timestampedParentA);
		const timestampedChildFile = path.join(sessionDir, `2025-02-05T00-02-00-000Z_${Bun.randomUUIDv7()}.jsonl`);
		fs.writeFileSync(
			timestampedChildFile,
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: Bun.randomUUIDv7(),
					timestamp: "2025-02-05T00:02:00.000Z",
					cwd,
					parentSession: timestampedParentA,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-02-05T00:02:01.000Z",
					message: { role: "user", content: "timestamped archive child", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-02-05T00:02:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);
		expect((await archiveSession(timestampedChildFile, 5)).records.parent).toBe(timestampedParentA);
		fs.unlinkSync(timestampedParentA);
		expect((await archiveSession(timestampedChildFile, 5)).records.parent).toBe(path.resolve(parentBFile));
	});

	it("deduplicates duplicate session ids in multi-directory picker scans without oscillating session_lineage writes", async () => {
		const sharedId = Bun.randomUUIDv7();
		const dirA = SessionManager.getDefaultSessionDir(cwd);
		const dirB = SessionManager.getDefaultSessionDir(otherCwd);
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });

		const copyAFile = path.join(dirA, `2025-02-06T00-00-00-000Z_${sharedId}.jsonl`);
		const copyBFile = path.join(dirB, `2025-02-06T00-00-00-000Z_${sharedId}.jsonl`);
		const makeCopyContent = (projectDir: string, title: string) =>
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: sharedId,
					timestamp: "2025-02-06T00:00:00.000Z",
					cwd: projectDir,
					title,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-02-06T00:00:01.000Z",
					message: { role: "user", content: `prompt in ${title}`, timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-02-06T00:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n";

		fs.writeFileSync(copyAFile, makeCopyContent(cwd, "Copy A"));
		fs.writeFileSync(copyBFile, makeCopyContent(otherCwd, "Copy B"));
		fs.utimesSync(copyAFile, 1_700_000_000, 1_700_000_000);
		fs.utimesSync(copyBFile, 1_700_000_010, 1_700_000_010);

		const firstAll = await SessionManager.listAllForPicker();
		await firstAll.complete;
		expect(getSessionLineage(sharedId)?.sessionPath).toBe(path.resolve(copyBFile));

		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("UPDATE session_lineage SET updated_at = 222 WHERE session_id = ?", [sharedId]);
			db.run("CREATE TABLE dup_lineage_audit (n INTEGER NOT NULL)");
			db.run(
				"CREATE TRIGGER trg_dup_insert AFTER INSERT ON session_lineage BEGIN INSERT INTO dup_lineage_audit VALUES (1); END",
			);
			db.run(
				"CREATE TRIGGER trg_dup_update AFTER UPDATE ON session_lineage BEGIN INSERT INTO dup_lineage_audit VALUES (1); END",
			);
		}

		const secondAll = await SessionManager.listAllForPicker();
		await secondAll.complete;
		const siblingScan = await listSessionsForPicker(dirA, new FileSessionStorage(), new Set(), [dirB]);
		await siblingScan.complete;
		expect(getSessionLineage(sharedId)?.sessionPath).toBe(path.resolve(copyBFile));

		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath(), { readonly: true });
			const writes = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM dup_lineage_audit").get();
			const row = db
				.query<{ updated_at: number }, [string]>("SELECT updated_at FROM session_lineage WHERE session_id = ?")
				.get(sharedId);
			expect(writes?.count).toBe(0);
			expect(row?.updated_at).toBe(222);
		}

		// When an older copy is already indexed and still present in the scan, cross-project scans keep it with 0 writes.
		recordSessionLineage({
			sessionId: sharedId,
			parentSession: null,
			sessionPath: copyAFile,
			cwd,
		});
		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("DELETE FROM dup_lineage_audit");
		}
		const thirdAll = await SessionManager.listAllForPicker();
		await thirdAll.complete;
		expect(getSessionLineage(sharedId)?.sessionPath).toBe(path.resolve(copyAFile));
		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath(), { readonly: true });
			const writes = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM dup_lineage_audit").get();
			expect(writes?.count).toBe(0);
		}
	});

	it("preserves indexed fallback cwd without redundant SQLite writes when scanning a legacy session header omitting cwd", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const legacyId = Bun.randomUUIDv7();
		const legacyFile = path.join(sessionDir, `2025-02-06T01-00-00-000Z_${legacyId}.jsonl`);
		fs.writeFileSync(
			legacyFile,
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: legacyId,
					timestamp: "2025-02-06T01:00:00.000Z",
					title: "Legacy without cwd",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-02-06T01:00:01.000Z",
					message: { role: "user", content: "legacy prompt", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-02-06T01:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);

		const opened = await SessionManager.open(legacyFile, sessionDir, new FileSessionStorage(), {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
		await opened.close();
		expect(getSessionLineage(legacyId)?.cwd).toBe(path.resolve(cwd));

		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("UPDATE session_lineage SET updated_at = 333 WHERE session_id = ?", [legacyId]);
			db.run("CREATE TABLE legacy_cwd_audit (n INTEGER NOT NULL)");
			db.run(
				"CREATE TRIGGER trg_legacy_cwd_insert AFTER INSERT ON session_lineage BEGIN INSERT INTO legacy_cwd_audit VALUES (1); END",
			);
			db.run(
				"CREATE TRIGGER trg_legacy_cwd_update AFTER UPDATE ON session_lineage BEGIN INSERT INTO legacy_cwd_audit VALUES (1); END",
			);
		}

		const listing = await SessionManager.listForPicker(cwd);
		await listing.complete;
		expect(getSessionLineage(legacyId)?.cwd).toBe(path.resolve(cwd));

		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath(), { readonly: true });
			const writes = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM legacy_cwd_audit").get();
			const row = db
				.query<{ updated_at: number; cwd: string | null }, [string]>(
					"SELECT updated_at, cwd FROM session_lineage WHERE session_id = ?",
				)
				.get(legacyId);
			expect(writes?.count).toBe(0);
			expect(row).toEqual({
				updated_at: 333,
				cwd: path.resolve(cwd),
			});
		}
	});

	it("rejects invalid generated session filename timestamps identically in parseSessionFileName and lineage resolution", () => {
		const validFile = path.join(cwd, "2026-10-26T18-29-27-740Z_parent.jsonl");
		const invalidFile = path.join(cwd, "2026-99-99T99-99-99-999Z_parent.jsonl");

		expect(parseSessionFileName(validFile)?.id).toBe("parent");
		expect(parseSessionFileName(invalidFile)).toBeUndefined();

		const parentSessionFile = path.join(cwd, "real-parent.jsonl");
		fs.writeFileSync(
			parentSessionFile,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: "parent",
				timestamp: "2026-10-26T18:29:27.740Z",
				cwd,
			})}\n`,
		);
		recordSessionLineage({
			sessionId: "parent",
			parentSession: null,
			sessionPath: parentSessionFile,
			cwd,
		});
		recordSessionLineage({
			sessionId: "child",
			parentSession: "parent",
			sessionPath: path.join(cwd, "child.jsonl"),
			cwd,
		});

		expect(resolveParentSessionReference(validFile)).toBe("parent");
		expect(getSessionLineage(validFile)?.sessionId).toBe("parent");
		expect(getChildSessions(validFile).map(entry => entry.sessionId)).toEqual(["child"]);

		expect(resolveParentSessionReference(invalidFile)).toBe(invalidFile);
		expect(getSessionLineage(invalidFile)).toBeUndefined();
		expect(getChildSessions(invalidFile)).toEqual([]);
	});

	it("reads >64 KiB and pretty-printed headers in claimSession and preserves >4 KiB fork parents across picker scans", async () => {
		const root = await createPersistedSession("Large-header root", cwd);
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });

		const hugeForkId = Bun.randomUUIDv7();
		const hugeForkFile = path.join(sessionDir, `2025-02-07T00-00-00-000Z_${hugeForkId}.jsonl`);
		const additionalDirectories = Array.from({ length: 420 }, (_, index) =>
			path.join(cwd, `workspace-${String(index).padStart(3, "0")}-${"d".repeat(160)}`),
		);
		const hugeHeaderLine = JSON.stringify({
			type: "session",
			version: 4,
			id: hugeForkId,
			timestamp: "2025-02-07T00:00:00.000Z",
			cwd,
			title: "Huge fork",
			additionalDirectories,
			parentSession: root.file,
		});
		expect(Buffer.byteLength(hugeHeaderLine, "utf8")).toBeGreaterThan(70 * 1024);

		fs.writeFileSync(
			hugeForkFile,
			[
				hugeHeaderLine,
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-02-07T00:00:01.000Z",
					message: { role: "user", content: "huge fork prompt", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-02-07T00:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);

		const prettyId = Bun.randomUUIDv7();
		const prettyFile = path.join(sessionDir, `2025-02-07T00-01-00-000Z_${prettyId}.jsonl`);
		fs.writeFileSync(
			prettyFile,
			`${JSON.stringify(
				{
					type: "session",
					version: 4,
					id: prettyId,
					timestamp: "2025-02-07T00:01:00.000Z",
					cwd,
				},
				null,
				2,
			)}\n`,
		);

		const storage = new FileSessionStorage();
		expect(storage.claimSession("mismatched-id", hugeForkFile)).toBeNull();
		expect(storage.claimSession("mismatched-id", prettyFile)).toBeNull();
		const releaseHuge = storage.claimSession(hugeForkId, hugeForkFile);
		expect(releaseHuge).not.toBeNull();
		releaseHuge?.();
		const releasePretty = storage.claimSession(prettyId, prettyFile);
		expect(releasePretty).not.toBeNull();
		releasePretty?.();
		fs.unlinkSync(prettyFile);

		recordSessionLineage({
			sessionId: hugeForkId,
			parentSession: root.file,
			sessionPath: hugeForkFile,
			cwd,
		});

		const firstListing = await SessionManager.listForPicker(cwd);
		const scanned = await firstListing.complete;
		const scannedFork = scanned.find(entry => entry.id === hugeForkId);
		expect(scannedFork?.parentSessionPath).toBe(root.file);
		expect(getSessionLineage(hugeForkId)?.parentSessionId).toBe(root.id);
		expect(getChildSessions(root.id).map(entry => entry.sessionId)).toEqual([hugeForkId]);

		// Verify unindexed backfill also extracts parentSession past 70 KiB.
		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("DELETE FROM session_lineage WHERE session_id = ?", [hugeForkId]);
		}
		const backfillListing = await SessionManager.listForPicker(cwd);
		await backfillListing.complete;
		expect(getSessionLineage(hugeForkId)?.parentSessionId).toBe(root.id);
		expect(getChildSessions(root.id).map(entry => entry.sessionId)).toEqual([hugeForkId]);
	});

	it("releases history.db handles on SessionManager.close() and setAgentDir() without explicit closeSessionIndex()", async () => {
		function openFdTargetsUnder(rootDir: string): string[] {
			if (process.platform !== "linux") return [];
			const resolvedRoot = fs.realpathSync(rootDir);
			const prefix = `${resolvedRoot}${path.sep}`;
			const matches: string[] = [];
			for (const entry of fs.readdirSync("/proc/self/fd")) {
				try {
					const target = fs.readlinkSync(`/proc/self/fd/${entry}`).replace(/ \(deleted\)$/, "");
					if (target === resolvedRoot || target.startsWith(prefix)) matches.push(target);
				} catch {}
			}
			return matches;
		}

		const isolatedCloseDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lineage-close-handle-"));
		const isolatedSwitchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lineage-switch-handle-"));
		try {
			// Teardown order 1: rm(agentDir) immediately after SessionManager.close(), BEFORE setAgentDir(prev).
			setAgentDir(isolatedCloseDir);
			const projectClose = path.join(isolatedCloseDir, "project");
			fs.mkdirSync(projectClose, { recursive: true });
			const session = SessionManager.create(projectClose);
			session.appendMessage({ role: "user", content: "open index handle", timestamp: 1 });
			session.appendMessage(makeAssistantMessage());
			await session.flush();
			expect(fs.existsSync(getHistoryDbPath())).toBe(true);
			if (process.platform === "linux") {
				expect(openFdTargetsUnder(isolatedCloseDir).some(target => target.includes("history.db"))).toBe(true);
			}
			await session.close();
			if (process.platform === "linux") {
				expect(openFdTargetsUnder(isolatedCloseDir)).toEqual([]);
			}
			fs.rmSync(isolatedCloseDir, { recursive: true });
			expect(fs.existsSync(isolatedCloseDir)).toBe(false);

			// Teardown order 2: static file helper with no SessionManager instance, then setAgentDir(prev) -> rm(agentDir).
			setAgentDir(isolatedSwitchDir);
			const projectSwitch = path.join(isolatedSwitchDir, "project");
			fs.mkdirSync(projectSwitch, { recursive: true });
			SessionManager.createEmptySessionFile(projectSwitch);
			expect(fs.existsSync(getHistoryDbPath())).toBe(true);
			if (process.platform === "linux") {
				expect(openFdTargetsUnder(isolatedSwitchDir).some(target => target.includes("history.db"))).toBe(true);
			}
			setAgentDir(testAgentDir);
			if (process.platform === "linux") {
				expect(openFdTargetsUnder(isolatedSwitchDir)).toEqual([]);
			}
			fs.rmSync(isolatedSwitchDir, { recursive: true });
			expect(fs.existsSync(isolatedSwitchDir)).toBe(false);
		} finally {
			setAgentDir(testAgentDir);
			removeSyncWithRetries(isolatedCloseDir);
			removeSyncWithRetries(isolatedSwitchDir);
		}
	});

	it("keeps parent session_lineage intact when an in-flight rewriteEntries() is superseded by createBranchedSession()", async () => {
		const enteredAtomicWrite = Promise.withResolvers<void>();
		const releaseAtomicWrite = Promise.withResolvers<void>();

		class GatedFileSessionStorage extends FileSessionStorage {
			#intercepted = false;

			override async writeTextAtomic(
				fpath: string,
				content: string,
				options?: WriteTextAtomicOptions,
			): Promise<void> {
				if (!this.#intercepted) {
					this.#intercepted = true;
					enteredAtomicWrite.resolve();
					await releaseAtomicWrite.promise;
				}
				await super.writeTextAtomic(fpath, content, options);
			}
		}

		const storage = new GatedFileSessionStorage();
		const session = SessionManager.create(cwd, undefined, storage);
		session.appendMessage({ role: "user", content: "parent turn", timestamp: 1 });
		const assistantId = session.appendMessage(makeAssistantMessage());
		session.flushSync();

		const parentId = session.getSessionId();
		const parentFile = session.getSessionFile();
		if (!parentFile) throw new Error("expected persisted parent session file");

		const rewritePromise = session.rewriteEntries();
		await enteredAtomicWrite.promise;

		const childFile = session.createBranchedSession(assistantId);
		if (!childFile) throw new Error("expected persisted branched child session file");
		const childId = session.getSessionId();
		expect(childId).not.toBe(parentId);

		releaseAtomicWrite.resolve();
		await rewritePromise;
		await session.close();

		expect(getSessionLineage(parentId)).toMatchObject({
			sessionId: parentId,
			parentSessionId: null,
			sessionPath: path.resolve(parentFile),
			cwd: path.resolve(cwd),
		});
		expect(getSessionLineage(childId)).toMatchObject({
			sessionId: childId,
			parentSessionId: parentId,
			sessionPath: path.resolve(childFile),
			cwd: path.resolve(cwd),
		});
		expect(getChildSessions(parentId).map(entry => entry.sessionId)).toEqual([childId]);
	});

	it("preserves runtime fallback cwd only while a legacy cwd-less session stays at the same path", async () => {
		const sessionDirA = SessionManager.getDefaultSessionDir(cwd);
		const sessionDirB = SessionManager.getDefaultSessionDir(otherCwd);
		fs.mkdirSync(sessionDirA, { recursive: true });
		fs.mkdirSync(sessionDirB, { recursive: true });

		const legacyId = Bun.randomUUIDv7();
		const fileName = `2025-02-08T00-00-00-000Z_${legacyId}.jsonl`;
		const legacyPathA = path.join(sessionDirA, fileName);
		const legacyPathB = path.join(sessionDirB, fileName);
		const legacyContent =
			[
				JSON.stringify({
					type: "session",
					version: 2,
					id: legacyId,
					timestamp: "2025-02-08T00:00:00.000Z",
					title: "Legacy no-cwd session",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-02-08T00:00:01.000Z",
					message: { role: "user", content: "legacy prompt", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-02-08T00:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n";
		fs.writeFileSync(legacyPathA, legacyContent);

		// Opening the cwd-less legacy session with project-a as fallback cwd indexes project-a at legacyPathA.
		const opened = await SessionManager.open(legacyPathA, sessionDirA, undefined, { initialCwd: cwd });
		await opened.close();
		expect(getSessionLineage(legacyId)).toMatchObject({
			sessionId: legacyId,
			sessionPath: path.resolve(legacyPathA),
			cwd: path.resolve(cwd),
		});

		// Rescanning project-a at the same path keeps the runtime fallback cwd with zero redundant writes.
		{
			using db = new Database(getHistoryDbPath());
			db.run("UPDATE session_lineage SET updated_at = 111 WHERE session_id = ?", [legacyId]);
		}
		const scanA = await SessionManager.listForPicker(cwd);
		await scanA.complete;
		expect(getSessionLineage(legacyId)).toMatchObject({
			sessionId: legacyId,
			sessionPath: path.resolve(legacyPathA),
			cwd: path.resolve(cwd),
			updatedAt: 111,
		});

		// Copying the cwd-less JSONL into project-b and scanning project-b moves session_path to legacyPathB and clears stale cwd.
		fs.writeFileSync(legacyPathB, legacyContent);
		const scanB1 = await SessionManager.listForPicker(otherCwd);
		await scanB1.complete;
		expect(getSessionLineage(legacyId)).toMatchObject({
			sessionId: legacyId,
			sessionPath: path.resolve(legacyPathB),
			cwd: null,
		});

		// Subsequent scan at project-b sees preliminary row cwd === "" (never stale project-a) and performs zero redundant writes.
		{
			using db = new Database(getHistoryDbPath());
			db.run("UPDATE session_lineage SET updated_at = 222 WHERE session_id = ?", [legacyId]);
		}
		const scanB2 = await SessionManager.listForPicker(otherCwd);
		const prelimB2 = scanB2.sessions.find(entry => entry.id === legacyId);
		expect(prelimB2?.cwd).toBe("");
		await scanB2.complete;
		expect(getSessionLineage(legacyId)?.updatedAt).toBe(222);
	});

	it("repoints nested child and grandchild lineage rows on SessionManager.moveTo() without stealing collided merge targets or touching stem-prefix siblings", async () => {
		const parent = SessionManager.create(cwd);
		parent.appendMessage({ role: "user", content: "parent prompt", timestamp: 1 });
		parent.appendMessage(makeAssistantMessage());
		await parent.flush();

		const parentId = parent.getSessionId();
		const oldParentFile = parent.getSessionFile();
		if (!oldParentFile) throw new Error("expected persisted parent session file");
		const oldArtifactsDir = oldParentFile.slice(0, -".jsonl".length);

		// Materialize a nested subagent child and grandchild via the exact task-executor SessionManager.open() path.
		const oldChildFile = path.join(oldArtifactsDir, "0-task.jsonl");
		const childManager = await SessionManager.open(oldChildFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: oldParentFile,
			suppressBreadcrumb: true,
		});
		childManager.appendMessage({ role: "user", content: "subagent prompt", timestamp: 2 });
		childManager.appendMessage(makeAssistantMessage());
		await childManager.flush();
		const childId = childManager.getSessionId();
		await childManager.close();

		const oldGrandchildFile = path.join(oldArtifactsDir, "0-task", "0-subtask.jsonl");
		const grandchildManager = await SessionManager.open(oldGrandchildFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: oldChildFile,
			suppressBreadcrumb: true,
		});
		grandchildManager.appendMessage({ role: "user", content: "grandchild prompt", timestamp: 3 });
		grandchildManager.appendMessage(makeAssistantMessage());
		await grandchildManager.flush();
		const grandchildId = grandchildManager.getSessionId();
		await grandchildManager.close();

		// Stem-prefix sibling directory (`<parent>-other/...`) must never match `<parent>/...`.
		const stemSiblingFile = path.join(`${oldArtifactsDir}-other`, "0-sibling.jsonl");
		const stemSiblingManager = await SessionManager.open(stemSiblingFile, undefined, undefined, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
		stemSiblingManager.appendMessage({ role: "user", content: "sibling prompt", timestamp: 4 });
		stemSiblingManager.appendMessage(makeAssistantMessage());
		await stemSiblingManager.flush();
		const stemSiblingId = stemSiblingManager.getSessionId();
		await stemSiblingManager.close();

		// Pre-populate a colliding transcript at the destination artifact directory so moveTo() takes the merge path:
		// `0-task.jsonl` + `0-task/0-subtask.jsonl` move cleanly, while `1-collided.jsonl` stays stranded at `oldArtifactsDir`.
		const targetSessionDir = SessionManager.getDefaultSessionDir(otherCwd);
		const newParentFile = path.join(targetSessionDir, path.basename(oldParentFile));
		const newArtifactsDir = newParentFile.slice(0, -".jsonl".length);

		const sourceCollidedFile = path.join(oldArtifactsDir, "1-collided.jsonl");
		const sourceCollidedManager = await SessionManager.open(sourceCollidedFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: oldParentFile,
			suppressBreadcrumb: true,
		});
		sourceCollidedManager.appendMessage({ role: "user", content: "source collided", timestamp: 5 });
		sourceCollidedManager.appendMessage(makeAssistantMessage());
		await sourceCollidedManager.flush();
		const sourceCollidedId = sourceCollidedManager.getSessionId();
		await sourceCollidedManager.close();

		const destCollidedFile = path.join(newArtifactsDir, "1-collided.jsonl");
		const destCollidedManager = await SessionManager.open(destCollidedFile, undefined, undefined, {
			initialCwd: otherCwd,
			suppressBreadcrumb: true,
		});
		destCollidedManager.appendMessage({ role: "user", content: "dest occupant", timestamp: 6 });
		destCollidedManager.appendMessage(makeAssistantMessage());
		await destCollidedManager.flush();
		const destCollidedId = destCollidedManager.getSessionId();
		await destCollidedManager.close();

		await parent.moveTo(otherCwd);
		await parent.close();

		const newChildFile = path.join(newArtifactsDir, "0-task.jsonl");
		const newGrandchildFile = path.join(newArtifactsDir, "0-task", "0-subtask.jsonl");
		expect(fs.existsSync(newChildFile)).toBe(true);
		expect(fs.existsSync(newGrandchildFile)).toBe(true);

		expect(getSessionLineage(parentId)?.sessionPath).toBe(path.resolve(newParentFile));
		expect(getSessionLineage(childId)).toMatchObject({
			sessionId: childId,
			parentSessionId: parentId,
			sessionPath: path.resolve(newChildFile),
			cwd: path.resolve(cwd),
		});
		expect(getSessionLineage(grandchildId)).toMatchObject({
			sessionId: grandchildId,
			parentSessionId: childId,
			sessionPath: path.resolve(newGrandchildFile),
			cwd: path.resolve(cwd),
		});

		const childrenById = new Map(getChildSessions(parentId).map(entry => [entry.sessionId, entry.sessionPath]));
		expect(childrenById.get(childId)).toBe(path.resolve(newChildFile));
		// Stranded source copy kept its old path; destination occupant kept its own row.
		expect(childrenById.get(sourceCollidedId)).toBe(path.resolve(sourceCollidedFile));
		expect(getSessionLineage(destCollidedId)?.sessionPath).toBe(path.resolve(destCollidedFile));
		expect(getChildSessions(childId).map(entry => entry.sessionPath)).toEqual([path.resolve(newGrandchildFile)]);
		expect(getSessionLineage(stemSiblingId)?.sessionPath).toBe(path.resolve(stemSiblingFile));
	});

	it("deletes nested child and grandchild lineage rows in deleteSessionWithArtifacts() and deleteSessionWithArtifactsIf() while preserving stem-prefix siblings", async () => {
		const storage = new FileSessionStorage();

		// Case 1: deleteSessionWithArtifacts() removes parent + nested child + nested grandchild, leaving `<parent>-other/...` intact.
		const parent = await createPersistedSession("Parent to delete", cwd);
		const artifactsDir = parent.file.slice(0, -".jsonl".length);

		const childFile = path.join(artifactsDir, "0-task.jsonl");
		const childManager = await SessionManager.open(childFile, undefined, storage, {
			initialCwd: cwd,
			parentSession: parent.file,
			suppressBreadcrumb: true,
		});
		childManager.appendMessage({ role: "user", content: "nested child", timestamp: 1 });
		childManager.appendMessage(makeAssistantMessage());
		await childManager.flush();
		const childId = childManager.getSessionId();
		await childManager.close();

		const grandchildFile = path.join(artifactsDir, "0-task", "0-subtask.jsonl");
		const grandchildManager = await SessionManager.open(grandchildFile, undefined, storage, {
			initialCwd: cwd,
			parentSession: childFile,
			suppressBreadcrumb: true,
		});
		grandchildManager.appendMessage({ role: "user", content: "nested grandchild", timestamp: 2 });
		grandchildManager.appendMessage(makeAssistantMessage());
		await grandchildManager.flush();
		const grandchildId = grandchildManager.getSessionId();
		await grandchildManager.close();

		const stemSiblingFile = path.join(`${artifactsDir}-other`, "0-sibling.jsonl");
		const stemSiblingManager = await SessionManager.open(stemSiblingFile, undefined, storage, {
			initialCwd: cwd,
			suppressBreadcrumb: true,
		});
		stemSiblingManager.appendMessage({ role: "user", content: "stem sibling", timestamp: 3 });
		stemSiblingManager.appendMessage(makeAssistantMessage());
		await stemSiblingManager.flush();
		const stemSiblingId = stemSiblingManager.getSessionId();
		await stemSiblingManager.close();

		await storage.deleteSessionWithArtifacts(parent.file);

		expect(getSessionLineage(parent.id)).toBeUndefined();
		expect(getSessionLineage(childId)).toBeUndefined();
		expect(getSessionLineage(grandchildId)).toBeUndefined();
		expect(getChildSessions(parent.id)).toEqual([]);
		expect(getChildSessions(childId)).toEqual([]);
		expect(getSessionLineage(stemSiblingId)?.sessionPath).toBe(path.resolve(stemSiblingFile));

		// Case 2: deleteSessionWithArtifactsIf() removes parent + nested child when predicate matches, and preserves both when false.
		const conditionalParent = await createPersistedSession("Conditional parent", cwd);
		const conditionalArtifactsDir = conditionalParent.file.slice(0, -".jsonl".length);
		const conditionalChildFile = path.join(conditionalArtifactsDir, "0-task.jsonl");
		const conditionalChildManager = await SessionManager.open(conditionalChildFile, undefined, storage, {
			initialCwd: cwd,
			parentSession: conditionalParent.file,
			suppressBreadcrumb: true,
		});
		conditionalChildManager.appendMessage({ role: "user", content: "conditional child", timestamp: 4 });
		conditionalChildManager.appendMessage(makeAssistantMessage());
		await conditionalChildManager.flush();
		const conditionalChildId = conditionalChildManager.getSessionId();
		await conditionalChildManager.close();

		expect(await storage.deleteSessionWithArtifactsIf(conditionalParent.file, () => false)).toBe(false);
		expect(getSessionLineage(conditionalParent.id)?.sessionPath).toBe(path.resolve(conditionalParent.file));
		expect(getSessionLineage(conditionalChildId)?.sessionPath).toBe(path.resolve(conditionalChildFile));

		expect(await storage.deleteSessionWithArtifactsIf(conditionalParent.file, () => true)).toBe(true);
		expect(getSessionLineage(conditionalParent.id)).toBeUndefined();
		expect(getSessionLineage(conditionalChildId)).toBeUndefined();
		expect(getChildSessions(conditionalParent.id)).toEqual([]);
	});

	it("folds whitespace-only and empty title slots identically across parseSessionContent and header readers", async () => {
		const sessionId = Bun.randomUUIDv7();
		const baseHeader = JSON.stringify({
			type: "session",
			version: 4,
			id: sessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
			title: "Stale raw header title",
			titleSource: "auto",
		});

		const whitespaceSlot = serializeTitleSlot({
			title: "   ",
			source: "user",
			updatedAt: "2026-01-01T00:01:00.000Z",
		});
		const whitespaceContent = `${whitespaceSlot}${baseHeader}\n`;
		const whitespaceFile = path.join(cwd, "whitespace-slot.jsonl");
		fs.writeFileSync(whitespaceFile, whitespaceContent);

		const fullParsedWhitespace = parseSessionContent(whitespaceContent).entries[0];
		if (!isValidSessionHeader(fullParsedWhitespace)) throw new Error("expected valid session header");
		expect(fullParsedWhitespace).toMatchObject({
			type: "session",
			id: sessionId,
			title: "   ",
			titleSource: "user",
		});
		expect(parseSessionHeaderText(whitespaceContent)).toEqual(fullParsedWhitespace);
		expect(await readSessionHeader(whitespaceFile)).toEqual(fullParsedWhitespace);
		expect(readSessionHeaderSync(whitespaceFile)).toEqual(fullParsedWhitespace);

		const emptySlot = serializeTitleSlot({
			title: "",
			updatedAt: "2026-01-01T00:02:00.000Z",
		});
		const emptyContent = `${emptySlot}${baseHeader}\n`;
		const emptyFile = path.join(cwd, "empty-slot.jsonl");
		fs.writeFileSync(emptyFile, emptyContent);

		const fullParsedEmpty = parseSessionContent(emptyContent).entries[0];
		if (!isValidSessionHeader(fullParsedEmpty)) throw new Error("expected valid session header");
		expect(fullParsedEmpty).toEqual({
			type: "session",
			version: 4,
			id: sessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		});
		expect(parseSessionHeaderText(emptyContent)).toEqual(fullParsedEmpty);
		expect(await readSessionHeader(emptyFile)).toEqual(fullParsedEmpty);
		expect(readSessionHeaderSync(emptyFile)).toEqual(fullParsedEmpty);
	});

	it("does not recreate session_lineage rows for sessions deleted while a progressive picker scan is in flight", async () => {
		const sessionA = await createPersistedSession("Session A", cwd);
		const sessionB = await createPersistedSession("Session B", cwd);
		const sessionC = await createPersistedSession("Session C", cwd);
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		const byPath = new Map<string, string>([
			[path.resolve(sessionA.file), sessionA.id],
			[path.resolve(sessionB.file), sessionB.id],
			[path.resolve(sessionC.file), sessionC.id],
		]);

		// Simulate pre-existing titled sessions: drop one session's lineage row completely (`!current`)
		// and make all three dirty relative to `session_lineage` (`cwd = NULL`) so whichever two scan
		// first cover both missing-row backfill and stale-row update paths.
		deleteSessionLineage(sessionA.id);
		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("UPDATE session_lineage SET cwd = NULL WHERE session_id IN (?, ?)", [sessionB.id, sessionC.id]);
		}

		const scannedFirstTwo = Promise.withResolvers<string[]>();
		const allowFinalRead = Promise.withResolvers<void>();
		const alreadyScannedPaths: string[] = [];

		class GatedPickerStorage extends FileSessionStorage {
			override async readTextSlices(
				fpath: string,
				prefixBytes: number,
				suffixBytes: number,
			): Promise<[string, string]> {
				if (alreadyScannedPaths.length === 2) {
					scannedFirstTwo.resolve([...alreadyScannedPaths]);
					await allowFinalRead.promise;
				}
				const slices = await super.readTextSlices(fpath, prefixBytes, suffixBytes);
				alreadyScannedPaths.push(path.resolve(fpath));
				return slices;
			}
		}

		const storage = new GatedPickerStorage();
		const listing = await listSessionsForPicker(sessionDir, storage, new Set());
		// Preliminary rows returned immediately from indexed titles while full scan is still in flight.
		expect(listing.sessions).toHaveLength(3);

		const firstTwoFiles = await scannedFirstTwo.promise;
		// Ensure `sessionA` (`!current`) is among the deleted files; if `sessionA` happened to be 3rd,
		// also delete its lineage row on one of the first two before unlinking so `!current` is exercised.
		const deletedIds: string[] = [];
		for (const file of firstTwoFiles) {
			const id = byPath.get(file);
			if (!id) throw new Error(`unexpected scanned file ${file}`);
			deletedIds.push(id);
		}
		if (!deletedIds.includes(sessionA.id)) {
			deleteSessionLineage(deletedIds[0]!);
		}

		for (const file of firstTwoFiles) {
			await storage.deleteSessionWithArtifacts(file);
		}
		for (const id of deletedIds) {
			expect(getSessionLineage(id)).toBeUndefined();
		}

		allowFinalRead.resolve();
		await listing.complete;

		for (const id of deletedIds) {
			expect(getSessionLineage(id)).toBeUndefined();
		}
		const survivingId = [sessionA.id, sessionB.id, sessionC.id].find(id => !deletedIds.includes(id));
		if (!survivingId) throw new Error("expected one surviving session");
		expect(getSessionLineage(survivingId)?.cwd).toBe(path.resolve(cwd));
	});

	it("preserves and migrates normalized parent ids when reopening relocated nested and shared-artifact subtasks", async () => {
		const parent = SessionManager.create(cwd);
		parent.appendMessage({ role: "user", content: "root prompt", timestamp: 1 });
		parent.appendMessage(makeAssistantMessage());
		await parent.flush();
		const oldParentFile = parent.getSessionFile()!;
		const oldArtifactsDir = oldParentFile.slice(0, -".jsonl".length);

		const oldChildFile = path.join(oldArtifactsDir, "0-task.jsonl");
		const childManager = await SessionManager.open(oldChildFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: oldParentFile,
			suppressBreadcrumb: true,
		});
		childManager.appendMessage({ role: "user", content: "child prompt", timestamp: 2 });
		childManager.appendMessage(makeAssistantMessage());
		await childManager.flush();
		const childId = childManager.getSessionId();
		await childManager.close();

		// Layout A: nested subdirectory (`<artifacts>/0-task/0-subtask.jsonl`).
		const oldNestedGrandchildFile = path.join(oldArtifactsDir, "0-task", "0-subtask.jsonl");
		const nestedGrandchildManager = await SessionManager.open(oldNestedGrandchildFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: oldChildFile,
			suppressBreadcrumb: true,
		});
		nestedGrandchildManager.appendMessage({ role: "user", content: "nested grandchild", timestamp: 3 });
		nestedGrandchildManager.appendMessage(makeAssistantMessage());
		await nestedGrandchildManager.flush();
		const nestedGrandchildId = nestedGrandchildManager.getSessionId();
		await nestedGrandchildManager.close();

		// Layout B: shared parent ArtifactManager directory (`<artifacts>/1-subtask.jsonl` with `parentSession: oldChildFile`).
		const oldSharedGrandchildFile = path.join(oldArtifactsDir, "1-subtask.jsonl");
		const sharedGrandchildManager = await SessionManager.open(oldSharedGrandchildFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: oldChildFile,
			suppressBreadcrumb: true,
		});
		sharedGrandchildManager.appendMessage({ role: "user", content: "shared grandchild", timestamp: 4 });
		sharedGrandchildManager.appendMessage(makeAssistantMessage());
		await sharedGrandchildManager.flush();
		const sharedGrandchildId = sharedGrandchildManager.getSessionId();
		await sharedGrandchildManager.close();

		await parent.moveTo(otherCwd);
		const newParentFile = parent.getSessionFile()!;
		await parent.close();

		const newArtifactsDir = newParentFile.slice(0, -".jsonl".length);
		const newChildFile = path.join(newArtifactsDir, "0-task.jsonl");
		const newNestedGrandchildFile = path.join(newArtifactsDir, "0-task", "0-subtask.jsonl");
		const newSharedGrandchildFile = path.join(newArtifactsDir, "1-subtask.jsonl");

		// Revival / reopen + subsequent append/flush must keep `parentSessionId === childId` rather than reverting to `oldChildFile`.
		const reopenedNested = await SessionManager.open(newNestedGrandchildFile, undefined, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		reopenedNested.appendMessage({ role: "user", content: "revived nested prompt", timestamp: 5 });
		reopenedNested.appendMessage(makeAssistantMessage());
		await reopenedNested.flush();
		await reopenedNested.close();

		const reopenedShared = await SessionManager.open(newSharedGrandchildFile, undefined, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		reopenedShared.appendMessage({ role: "user", content: "revived shared prompt", timestamp: 6 });
		reopenedShared.appendMessage(makeAssistantMessage());
		await reopenedShared.flush();
		await reopenedShared.close();

		expect(getSessionLineage(nestedGrandchildId)?.parentSessionId).toBe(childId);
		expect(getSessionLineage(sharedGrandchildId)?.parentSessionId).toBe(childId);
		expect(new Set(getChildSessions(childId).map(entry => `${entry.sessionId}:${entry.sessionPath}`))).toEqual(
			new Set([
				`${nestedGrandchildId}:${path.resolve(newNestedGrandchildFile)}`,
				`${sharedGrandchildId}:${path.resolve(newSharedGrandchildFile)}`,
			]),
		);
		expect((await archiveSession(newNestedGrandchildFile, 5)).records.parent).toBe(path.resolve(newChildFile));
		expect((await archiveSession(newSharedGrandchildFile, 5)).records.parent).toBe(path.resolve(newChildFile));

		// Cold index rebuild: even with no prior lineage row for either grandchild, reopening migrates historical `oldChildFile` to `childId`.
		deleteSessionLineage(nestedGrandchildId);
		deleteSessionLineage(sharedGrandchildId);
		expect(getChildSessions(childId)).toEqual([]);

		const coldNested = await SessionManager.open(newNestedGrandchildFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		await coldNested.close();
		const coldShared = await SessionManager.open(newSharedGrandchildFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		await coldShared.close();

		expect(getSessionLineage(nestedGrandchildId)?.parentSessionId).toBe(childId);
		expect(getSessionLineage(sharedGrandchildId)?.parentSessionId).toBe(childId);
		expect(new Set(getChildSessions(childId).map(entry => entry.sessionId))).toEqual(
			new Set([nestedGrandchildId, sharedGrandchildId]),
		);

		// Existing normalized parent id also survives reopening when the relocated custom parent file itself is later removed.
		fs.unlinkSync(newChildFile);
		const reopenedAfterParentRemoved = await SessionManager.open(newNestedGrandchildFile, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		await reopenedAfterParentRemoved.close();
		expect(getSessionLineage(nestedGrandchildId)?.parentSessionId).toBe(childId);
	});

	it("acquires BEGIN IMMEDIATE before parent lookups so concurrent WAL commits do not drop lineage updates", async () => {
		const customParentId = Bun.randomUUIDv7();
		const customParentFile = path.join(cwd, "custom-parent.jsonl");
		fs.writeFileSync(
			customParentFile,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: customParentId,
				timestamp: "2026-01-02T00:00:00.000Z",
				cwd,
			})}\n`,
		);
		recordSessionLineage({
			sessionId: customParentId,
			parentSession: null,
			sessionPath: customParentFile,
			cwd,
		});

		const holdImmediateLockInPeer = async (peerKey: string): Promise<{ waitDone: () => Promise<void> }> => {
			const script = `
				import { Database } from "bun:sqlite";
				const dbPath = process.env.OMP_TEST_DB_PATH!;
				const key = process.env.OMP_TEST_PEER_KEY!;
				const db = new Database(dbPath);
				try {
					db.run("PRAGMA journal_mode=WAL");
					db.run("PRAGMA busy_timeout=5000");
					db.run("BEGIN IMMEDIATE");
					process.stdout.write("LOCKED\\n");
					await Bun.sleep(120);
					db.run(
						"INSERT OR REPLACE INTO session_titles (session_id, title, updated_at) VALUES (?, ?, 1)",
						[key, key],
					);
					db.run("COMMIT");
				} finally {
					db.close();
				}
			`;
			const child = Bun.spawn([process.execPath, "-e", script], {
				env: {
					...process.env,
					OMP_TEST_DB_PATH: getHistoryDbPath(),
					OMP_TEST_PEER_KEY: peerKey,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let buffered = "";
			while (!buffered.includes("LOCKED")) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffered += decoder.decode(chunk.value, { stream: true });
			}
			reader.releaseLock();
			if (!buffered.includes("LOCKED")) {
				const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
				throw new Error(`Peer writer failed to lock history.db: ${stderr}`);
			}
			return {
				waitDone: async () => {
					const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
					const exitCode = await child.exited;
					if (exitCode !== 0) {
						throw new Error(`Peer writer exited with ${exitCode}: ${stderr}`);
					}
				},
			};
		};

		const singleChildId = Bun.randomUUIDv7();
		const singleChildFile = path.join(cwd, "single-child.jsonl");
		const peerOne = await holdImmediateLockInPeer("peer-single");
		recordSessionLineage({
			sessionId: singleChildId,
			parentSession: customParentFile,
			sessionPath: singleChildFile,
			cwd,
		});
		await peerOne.waitDone();

		expect(lookupSessionTitle("peer-single")).toBe("peer-single");
		expect(getSessionLineage(singleChildId)).toMatchObject({
			sessionId: singleChildId,
			parentSessionId: customParentId,
			sessionPath: path.resolve(singleChildFile),
		});

		const batchChildId = Bun.randomUUIDv7();
		const batchChildFile = path.join(cwd, "batch-child.jsonl");
		const peerTwo = await holdImmediateLockInPeer("peer-batch");
		recordSessionLineages([
			{
				sessionId: batchChildId,
				parentSession: customParentFile,
				sessionPath: batchChildFile,
				cwd,
			},
		]);
		await peerTwo.waitDone();

		expect(lookupSessionTitle("peer-batch")).toBe("peer-batch");
		expect(getSessionLineage(batchChildId)).toMatchObject({
			sessionId: batchChildId,
			parentSessionId: customParentId,
			sessionPath: path.resolve(batchChildFile),
		});
		expect(new Set(getChildSessions(customParentId).map(entry => entry.sessionId))).toEqual(
			new Set([singleChildId, batchChildId]),
		);
	});

	it("orders equal-timestamp duplicate session copies identically in scan results and lineage backfill", async () => {
		const sharedId = Bun.randomUUIDv7();
		const dirA = SessionManager.getDefaultSessionDir(cwd);
		const dirB = SessionManager.getDefaultSessionDir(otherCwd);
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });

		const copyAFile = path.join(dirA, `2025-02-08T00-00-00-000Z_${sharedId}.jsonl`);
		const copyBFile = path.join(dirB, `2025-02-08T00-00-00-000Z_${sharedId}.jsonl`);
		const makeCopy = (projectDir: string, title: string) =>
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: sharedId,
					timestamp: "2025-02-08T00:00:00.000Z",
					cwd: projectDir,
					title,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-02-08T00:00:01.000Z",
					message: { role: "user", content: `equal-time ${title}`, timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-02-08T00:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n";

		fs.writeFileSync(copyAFile, makeCopy(cwd, "Equal A"));
		fs.writeFileSync(copyBFile, makeCopy(otherCwd, "Equal B"));
		fs.utimesSync(copyAFile, 1_700_100_000, 1_700_100_000);
		fs.utimesSync(copyBFile, 1_700_100_000, 1_700_100_000);

		const listing = await listSessionsForPicker(dirA, new FileSessionStorage(), new Set(), [dirB]);
		const scanned = await listing.complete;
		expect(scanned).toHaveLength(2);
		expect(path.resolve(scanned[0]!.path)).toBe(path.resolve(copyBFile));
		expect(getSessionLineage(sharedId)?.sessionPath).toBe(path.resolve(scanned[0]!.path));

		// Explicit preference for the currently indexed path still overrides path tie-breaking on subsequent scans.
		recordSessionLineage({
			sessionId: sharedId,
			parentSession: null,
			sessionPath: copyAFile,
			cwd,
		});
		const repeatListing = await listSessionsForPicker(dirA, new FileSessionStorage(), new Set(), [dirB]);
		await repeatListing.complete;
		expect(getSessionLineage(sharedId)?.sessionPath).toBe(path.resolve(copyAFile));
	});

	it("preserves original lineage and leaves no deleted staging path when unpackSession placement rolls back", async () => {
		const laptopSession = SessionManager.create(cwd);
		laptopSession.appendMessage({ role: "user", content: "initial laptop turn", timestamp: 1 });
		laptopSession.appendMessage(makeAssistantMessage());
		await laptopSession.flush();
		const laptopFile = laptopSession.getSessionFile()!;
		const sessionId = laptopSession.getSessionId();
		await laptopSession.close();

		const laptopArtifacts = laptopFile.slice(0, -".jsonl".length);
		const nestedChildFile = path.join(laptopArtifacts, "0-task.jsonl");
		const nestedChild = await SessionManager.open(nestedChildFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: laptopFile,
			suppressBreadcrumb: true,
		});
		nestedChild.appendMessage({ role: "user", content: "nested laptop child", timestamp: 2 });
		nestedChild.appendMessage(makeAssistantMessage());
		await nestedChild.flush();
		const nestedChildId = nestedChild.getSessionId();
		await nestedChild.close();

		const forkManager = await SessionManager.forkFrom(laptopFile, cwd, undefined, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const forkFile = forkManager.getSessionFile()!;
		await forkManager.close();

		const initialArchive = path.join(testAgentDir, "laptop.tar");
		await packSession(laptopFile, initialArchive);

		// Continue on a separate cloud agent dir to produce a valid prefix-extending archive (`back.tar`).
		const cloudAgentDir = path.join(testAgentDir, "cloud-agent");
		const cloudCwd = path.join(testAgentDir, "cloud-project");
		fs.mkdirSync(cloudCwd, { recursive: true });
		setAgentDir(cloudAgentDir);
		const cloudUnpacked = await unpackSession(initialArchive, { cwd: cloudCwd });
		const cloudContinued = await SessionManager.open(cloudUnpacked.sessionFile);
		cloudContinued.appendMessage({ role: "user", content: "cloud follow-up", timestamp: 3 });
		cloudContinued.appendMessage(makeAssistantMessage());
		await cloudContinued.flush();
		await cloudContinued.close();
		const backArchive = path.join(testAgentDir, "back.tar");
		await packSession(cloudUnpacked.sessionFile, backArchive);
		HistoryStorage.close();
		closeSessionIndex();

		// 1. Existing indexed session rollback (`restoreAside`): force `openRelocated()` -> `moveTo()` to fail after `setAside()`
		// by placing a directory at the target session file path in `blockedReplaceDir`.
		setAgentDir(testAgentDir);
		expect(getSessionLineage(sessionId)?.sessionPath).toBe(path.resolve(laptopFile));
		const blockedReplaceDir = path.join(testAgentDir, "blocked-replace-sessions");
		const blockingEntryAtDest = path.join(blockedReplaceDir, path.basename(laptopFile));
		fs.mkdirSync(blockingEntryAtDest, { recursive: true });

		await expect(unpackSession(backArchive, { cwd: otherCwd, sessionDir: blockedReplaceDir })).rejects.toThrow();

		expect(fs.existsSync(laptopFile)).toBe(true);
		expect(fs.existsSync(nestedChildFile)).toBe(true);
		expect(getSessionLineage(sessionId)).toMatchObject({
			sessionId,
			sessionPath: path.resolve(laptopFile),
			cwd: path.resolve(cwd),
		});
		expect(getChildSessions(sessionId).map(entry => entry.sessionPath)).toContain(path.resolve(nestedChildFile));
		expect(getSessionLineage(nestedChildId)?.sessionPath).toBe(path.resolve(nestedChildFile));
		expect((await archiveSession(forkFile, 5)).records.parent).toBe(path.resolve(laptopFile));

		// 2. Brand-new session rollback (`created` mode): a failed unpack leaves no deleted staging path in `session_lineage`.
		const freshAgentDir = path.join(testAgentDir, "fresh-agent");
		const freshBlockedDir = path.join(testAgentDir, "fresh-blocked-sessions");
		fs.mkdirSync(path.join(freshBlockedDir, path.basename(laptopFile)), { recursive: true });
		HistoryStorage.close();
		closeSessionIndex();
		setAgentDir(freshAgentDir);

		await expect(unpackSession(backArchive, { cwd: otherCwd, sessionDir: freshBlockedDir })).rejects.toThrow();
		expect(getSessionLineage(sessionId)).toBeUndefined();

		// 3. Unblocking placement indexes the final unpacked destination path in both `created` and `replaced` modes.
		const createdResult = await unpackSession(backArchive, { cwd: otherCwd });
		expect(createdResult.mode).toBe("created");
		expect(getSessionLineage(sessionId)?.sessionPath).toBe(path.resolve(createdResult.sessionFile));
		HistoryStorage.close();
		closeSessionIndex();

		setAgentDir(testAgentDir);
		const replacedResult = await unpackSession(backArchive, { cwd: otherCwd });
		expect(replacedResult.mode).toBe("replaced");
		expect(getSessionLineage(sessionId)?.sessionPath).toBe(path.resolve(replacedResult.sessionFile));
		expect((await archiveSession(forkFile, 5)).records.parent).toBe(path.resolve(replacedResult.sessionFile));
	});

	it("validates scanned titles and lineages asynchronously without synchronous session-file reads", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });

		// Unindexed custom-named parent outside the scanned project session directory.
		const externalParentId = Bun.randomUUIDv7();
		const externalParentFile = path.join(otherCwd, "custom-external-parent.jsonl");
		fs.writeFileSync(
			externalParentFile,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: externalParentId,
				timestamp: "2025-03-01T00:00:00.000Z",
				cwd: otherCwd,
			})}\n`,
		);

		const childId = Bun.randomUUIDv7();
		const childFile = path.join(sessionDir, `2025-03-01T00-01-00-000Z_${childId}.jsonl`);
		fs.writeFileSync(
			childFile,
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: childId,
					timestamp: "2025-03-01T00:01:00.000Z",
					cwd,
					parentSession: externalParentFile,
					title: "Async backfill child",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-03-01T00:01:01.000Z",
					message: { role: "user", content: "async child prompt", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-03-01T00:01:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);

		const replacedId = Bun.randomUUIDv7();
		const impostorId = Bun.randomUUIDv7();
		const replacedFile = path.join(sessionDir, `2025-03-01T00-02-00-000Z_${replacedId}.jsonl`);
		fs.writeFileSync(
			replacedFile,
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: replacedId,
					timestamp: "2025-03-01T00:02:00.000Z",
					cwd,
					title: "Replaced mid-scan",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-03-01T00:02:01.000Z",
					message: { role: "user", content: "replaced prompt", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-03-01T00:02:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);

		// Ensure history.db is already open before spying on synchronous file opens.
		expect(getSessionLineage(childId)).toBeUndefined();

		class ReplaceAfterSliceReadStorage extends FileSessionStorage {
			override async readTextSlices(
				fpath: string,
				prefixBytes: number,
				suffixBytes: number,
			): Promise<[string, string]> {
				const slices = await super.readTextSlices(fpath, prefixBytes, suffixBytes);
				if (path.resolve(fpath) === path.resolve(replacedFile)) {
					await fs.promises.writeFile(
						replacedFile,
						`${JSON.stringify({
							type: "session",
							version: 4,
							id: impostorId,
							timestamp: "2025-03-01T00:03:00.000Z",
							cwd,
						})}\n`,
					);
				}
				return slices;
			}
		}

		const syncJsonlOpens: string[] = [];
		const realOpenSync = fs.openSync.bind(fs);
		const trackedOpenSync = spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
			if (typeof target === "string" && target.endsWith(".jsonl")) {
				syncJsonlOpens.push(target);
			}
			return realOpenSync(target, flags, mode);
		}) as typeof fs.openSync);
		try {
			const listing = await listSessionsForPicker(sessionDir, new ReplaceAfterSliceReadStorage(), new Set());
			await listing.complete;
		} finally {
			trackedOpenSync.mockRestore();
		}

		expect(syncJsonlOpens).toEqual([]);
		expect(lookupSessionTitle(childId)).toBe("Async backfill child");
		expect(getSessionLineage(childId)).toMatchObject({
			sessionId: childId,
			parentSessionId: externalParentId,
			sessionPath: path.resolve(childFile),
			cwd: path.resolve(cwd),
		});
		expect(getSessionLineage(replacedId)).toBeUndefined();
	});

	it("keeps temporary omp render and suppressLineage scratch copies out of session_lineage across writes and teardown", async () => {
		const parent = await createPersistedSession("Rendered parent", cwd);
		const forkManager = await SessionManager.forkFrom(parent.file, cwd, undefined, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const forkFile = forkManager.getSessionFile()!;
		await forkManager.close();

		expect(getSessionLineage(parent.id)?.sessionPath).toBe(path.resolve(parent.file));

		const exitCode = await runRenderCommand({ session: parent.file, quiet: true });
		expect(exitCode).toBe(0);

		// Also exercise `suppressLineage: true` across incremental append, atomic rewrite, clone, and close.
		const scratchCopy = path.join(otherCwd, path.basename(parent.file));
		fs.copyFileSync(parent.file, scratchCopy);
		const suppressed = await SessionManager.open(scratchCopy, undefined, undefined, {
			suppressBreadcrumb: true,
			suppressLineage: true,
		});
		suppressed.appendMessage({ role: "user", content: "scratch mutation", timestamp: 99 });
		suppressed.appendMessage(makeAssistantMessage());
		await suppressed.flush();
		await suppressed.appendEntriesAtomically(() => {
			suppressed.appendThinkingLevelChange("high", "high");
		});
		const clonedSuppressed = suppressed.cloneCurrentSession();
		await clonedSuppressed.appendEntriesAtomically(() => {
			clonedSuppressed.appendThinkingLevelChange("medium", "medium");
		});
		await clonedSuppressed.close();
		await suppressed.close();
		fs.unlinkSync(scratchCopy);

		expect(getSessionLineage(parent.id)?.sessionPath).toBe(path.resolve(parent.file));
		const prelim = await SessionManager.listForPicker(cwd);
		expect(prelim.sessions.find(entry => entry.id === parent.id)?.path).toBe(parent.file);
		await prelim.complete;
		expect((await archiveSession(forkFile, 5)).records.parent).toBe(path.resolve(parent.file));
	});

	it("restores nested child and grandchild lineage rows when same-path unpackSession fails after placement", async () => {
		const rootSession = SessionManager.create(cwd);
		rootSession.appendMessage({ role: "user", content: "root turn", timestamp: 1 });
		rootSession.appendMessage(makeAssistantMessage());
		await rootSession.flush();
		const rootFile = rootSession.getSessionFile()!;
		const rootId = rootSession.getSessionId();
		await rootSession.close();

		const rootArtifacts = rootFile.slice(0, -".jsonl".length);
		const childFile = path.join(rootArtifacts, "0-task.jsonl");
		const childManager = await SessionManager.open(childFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: rootFile,
			suppressBreadcrumb: true,
		});
		childManager.appendMessage({ role: "user", content: "child turn", timestamp: 2 });
		childManager.appendMessage(makeAssistantMessage());
		await childManager.flush();
		const childId = childManager.getSessionId();
		await childManager.close();

		const grandchildFile = path.join(rootArtifacts, "0-task", "0-subtask.jsonl");
		const grandchildManager = await SessionManager.open(grandchildFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: childFile,
			suppressBreadcrumb: true,
		});
		grandchildManager.appendMessage({ role: "user", content: "grandchild turn", timestamp: 3 });
		grandchildManager.appendMessage(makeAssistantMessage());
		await grandchildManager.flush();
		const grandchildId = grandchildManager.getSessionId();
		await grandchildManager.close();

		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("UPDATE session_lineage SET updated_at = 310 WHERE session_id = ?", [childId]);
			db.run("UPDATE session_lineage SET updated_at = 320 WHERE session_id = ?", [grandchildId]);
		}

		const initialArchive = path.join(testAgentDir, "same-path-initial.tar");
		await packSession(rootFile, initialArchive);

		const cloudAgentDir = path.join(testAgentDir, "same-path-cloud-agent");
		const cloudCwd = path.join(testAgentDir, "same-path-cloud-cwd");
		fs.mkdirSync(cloudCwd, { recursive: true });
		setAgentDir(cloudAgentDir);
		const cloudUnpacked = await unpackSession(initialArchive, { cwd: cloudCwd });
		const cloudContinued = await SessionManager.open(cloudUnpacked.sessionFile);
		cloudContinued.appendMessage({ role: "user", content: "cloud extension", timestamp: 4 });
		cloudContinued.appendMessage(makeAssistantMessage());
		await cloudContinued.flush();
		await cloudContinued.close();
		const backArchive = path.join(testAgentDir, "same-path-back.tar");
		await packSession(cloudUnpacked.sessionFile, backArchive);
		HistoryStorage.close();
		closeSessionIndex();

		// Unpack back into the SAME `cwd` (so `placed === rootFile` and `placedArtifacts === rootArtifacts`),
		// failing inside `appendTransferNotice` AFTER `openRelocated` placed the archive at `rootFile`.
		setAgentDir(testAgentDir);
		const appendNoticeSpy = spyOn(SessionManager.prototype, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("simulated arrival notice failure");
		});
		try {
			await expect(unpackSession(backArchive, { cwd })).rejects.toThrow("simulated arrival notice failure");
		} finally {
			appendNoticeSpy.mockRestore();
		}

		expect(fs.existsSync(rootFile)).toBe(true);
		expect(fs.existsSync(childFile)).toBe(true);
		expect(fs.existsSync(grandchildFile)).toBe(true);
		expect(getSessionLineage(rootId)).toMatchObject({
			sessionId: rootId,
			parentSessionId: null,
			sessionPath: path.resolve(rootFile),
			cwd: path.resolve(cwd),
		});
		expect(getSessionLineage(childId)).toMatchObject({
			sessionId: childId,
			parentSessionId: rootId,
			sessionPath: path.resolve(childFile),
			cwd: path.resolve(cwd),
			updatedAt: 310,
		});
		expect(getSessionLineage(grandchildId)).toMatchObject({
			sessionId: grandchildId,
			parentSessionId: childId,
			sessionPath: path.resolve(grandchildFile),
			cwd: path.resolve(cwd),
			updatedAt: 320,
		});
		expect(getChildSessions(rootId).map(entry => entry.sessionPath)).toEqual([path.resolve(childFile)]);
		expect(getChildSessions(childId).map(entry => entry.sessionPath)).toEqual([path.resolve(grandchildFile)]);
	});

	it("repoints relocated descendant transcripts asynchronously without synchronous descendant file opens or stats", async () => {
		const parent = SessionManager.create(cwd);
		parent.appendMessage({ role: "user", content: "root move async", timestamp: 1 });
		parent.appendMessage(makeAssistantMessage());
		await parent.flush();
		const oldParentFile = parent.getSessionFile()!;
		const parentId = parent.getSessionId();
		const oldArtifactsDir = oldParentFile.slice(0, -".jsonl".length);

		const oldChildFile = path.join(oldArtifactsDir, "0-task.jsonl");
		const childManager = await SessionManager.open(oldChildFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: oldParentFile,
			suppressBreadcrumb: true,
		});
		childManager.appendMessage({ role: "user", content: "child move async", timestamp: 2 });
		childManager.appendMessage(makeAssistantMessage());
		await childManager.flush();
		const childId = childManager.getSessionId();
		await childManager.close();

		const oldGrandchildFile = path.join(oldArtifactsDir, "0-task", "0-subtask.jsonl");
		const grandchildManager = await SessionManager.open(oldGrandchildFile, undefined, undefined, {
			initialCwd: cwd,
			parentSession: oldChildFile,
			suppressBreadcrumb: true,
		});
		grandchildManager.appendMessage({ role: "user", content: "grandchild move async", timestamp: 3 });
		grandchildManager.appendMessage(makeAssistantMessage());
		await grandchildManager.flush();
		const grandchildId = grandchildManager.getSessionId();
		await grandchildManager.close();

		// Ensure history.db is already open before spying on synchronous descendant file I/O.
		expect(getSessionLineage(childId)?.sessionPath).toBe(path.resolve(oldChildFile));

		const isDescendantTranscript = (target: unknown): target is string =>
			typeof target === "string" &&
			(target.endsWith("0-task.jsonl") ||
				target.endsWith("0-subtask.jsonl") ||
				target.endsWith("headerless-subtask.jsonl"));

		const syncDescendantOps: string[] = [];
		const realOpenSync = fs.openSync.bind(fs);
		const realStatSync = fs.statSync.bind(fs);
		const openSpy = spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
			if (isDescendantTranscript(target)) syncDescendantOps.push(`openSync:${target}`);
			return realOpenSync(target, flags, mode);
		}) as typeof fs.openSync);
		const statSpy = spyOn(fs, "statSync").mockImplementation(((target, options) => {
			if (isDescendantTranscript(target)) syncDescendantOps.push(`statSync:${target}`);
			return realStatSync(target, options);
		}) as typeof fs.statSync);
		let movedParentFile = "";
		try {
			await parent.moveTo(otherCwd);
			movedParentFile = parent.getSessionFile()!;
			await parent.close();

			// Also exercise direct `await repointSessionLineageUnderDirectory()` on an incomplete-header subtask.
			const directOldDir = path.join(testAgentDir, "direct-old-artifacts");
			const directNewDir = path.join(testAgentDir, "direct-new-artifacts");
			fs.mkdirSync(directNewDir, { recursive: true });
			const directOldFile = path.join(directOldDir, "headerless-subtask.jsonl");
			const directNewFile = path.join(directNewDir, "headerless-subtask.jsonl");
			fs.writeFileSync(directNewFile, '{"type":"session","id":"incomplete');
			recordSessionLineage({
				sessionId: "headerless-subtask-id",
				parentSession: parentId,
				sessionPath: directOldFile,
				cwd: otherCwd,
			});
			await repointSessionLineageUnderDirectory(directOldDir, directNewDir);
			expect(getSessionLineage("headerless-subtask-id")?.sessionPath).toBe(path.resolve(directNewFile));
		} finally {
			openSpy.mockRestore();
			statSpy.mockRestore();
		}

		expect(syncDescendantOps).toEqual([]);
		const movedArtifactsDir = movedParentFile.slice(0, -".jsonl".length);
		expect(getSessionLineage(childId)).toMatchObject({
			sessionId: childId,
			parentSessionId: parentId,
			sessionPath: path.resolve(path.join(movedArtifactsDir, "0-task.jsonl")),
		});
		expect(getSessionLineage(grandchildId)).toMatchObject({
			sessionId: grandchildId,
			parentSessionId: childId,
			sessionPath: path.resolve(path.join(movedArtifactsDir, "0-task", "0-subtask.jsonl")),
		});
	});

	it("persists normalized parent session id when a scanned child references a non-indexed custom copy of an unchanged parent", async () => {
		const parent = await createPersistedSession("Indexed canonical parent", cwd);
		const dirA = SessionManager.getDefaultSessionDir(cwd);
		const dirB = SessionManager.getDefaultSessionDir(otherCwd);
		fs.mkdirSync(dirB, { recursive: true });

		// Custom-named duplicate copy of `parent` in `dirB`; `parent.file` in `dirA` remains the indexed representative.
		const customParentCopy = path.join(dirB, "custom-parent-copy.jsonl");
		fs.copyFileSync(parent.file, customParentCopy);
		fs.utimesSync(customParentCopy, 1_700_000_000, 1_700_000_000);

		const childId = Bun.randomUUIDv7();
		const childFile = path.join(dirB, `2025-04-01T00-00-00-000Z_${childId}.jsonl`);
		fs.writeFileSync(
			childFile,
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: childId,
					timestamp: "2025-04-01T00:00:00.000Z",
					cwd: otherCwd,
					parentSession: customParentCopy,
					title: "Child of custom parent copy",
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-04-01T00:00:01.000Z",
					message: { role: "user", content: "child via custom copy", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-04-01T00:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);

		const firstScan = await listSessionsForPicker(dirA, new FileSessionStorage(), new Set(), [dirB]);
		await firstScan.complete;

		expect(getSessionLineage(parent.id)?.sessionPath).toBe(path.resolve(parent.file));
		expect(getSessionLineage(childId)).toMatchObject({
			sessionId: childId,
			parentSessionId: parent.id,
			sessionPath: path.resolve(childFile),
			cwd: path.resolve(otherCwd),
		});
		expect(getChildSessions(parent.id).map(entry => entry.sessionId)).toEqual([childId]);

		// A repeat unchanged scan must perform zero redundant SQLite writes.
		closeSessionIndex();
		{
			using db = new Database(getHistoryDbPath());
			db.run("UPDATE session_lineage SET updated_at = 444 WHERE session_id = ?", [childId]);
		}
		const secondScan = await listSessionsForPicker(dirA, new FileSessionStorage(), new Set(), [dirB]);
		await secondScan.complete;
		expect(getSessionLineage(childId)?.updatedAt).toBe(444);
	});

	it("preserves unreadable EACCES/EIO lineage rows while deleting ENOENT/ENOTDIR/non-file rows and blocking false incomplete-header relocations", async () => {
		const artifactsDir = path.join(testAgentDir, "conservative-missing-artifacts");
		const nestedDir = path.join(artifactsDir, "0-task");
		const dirReplacingFile = path.join(artifactsDir, "dir-instead-of-file.jsonl");
		const enotdirParentFile = path.join(artifactsDir, "not-a-dir");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.mkdirSync(dirReplacingFile, { recursive: true });
		fs.writeFileSync(enotdirParentFile, "plain-file");

		const eaccesFile = path.join(nestedDir, "eacces-child.jsonl");
		const eioFile = path.join(nestedDir, "eio-child.jsonl");
		const enoentFile = path.join(nestedDir, "enoent-child.jsonl");
		const enotdirFile = path.join(enotdirParentFile, "enotdir-child.jsonl");
		fs.writeFileSync(
			eaccesFile,
			'{"type":"session","id":"eacces-id","version":4,"timestamp":"2025-05-01T00:00:00.000Z"}\n',
		);
		fs.writeFileSync(
			eioFile,
			'{"type":"session","id":"eio-id","version":4,"timestamp":"2025-05-01T00:00:00.000Z"}\n',
		);

		recordSessionLineages([
			{ sessionId: "eacces-id", parentSession: "root-id", sessionPath: eaccesFile, cwd },
			{ sessionId: "eio-id", parentSession: "root-id", sessionPath: eioFile, cwd },
			{ sessionId: "enoent-id", parentSession: "root-id", sessionPath: enoentFile, cwd },
			{ sessionId: "enotdir-id", parentSession: "root-id", sessionPath: enotdirFile, cwd },
			{ sessionId: "dir-id", parentSession: "root-id", sessionPath: dirReplacingFile, cwd },
		]);

		// Also prepare an incomplete-header relocation candidate whose source fails stat with EACCES.
		const relocOldDir = path.join(testAgentDir, "reloc-eacces-old");
		const relocNewDir = path.join(testAgentDir, "reloc-eacces-new");
		fs.mkdirSync(relocOldDir, { recursive: true });
		fs.mkdirSync(relocNewDir, { recursive: true });
		const relocOldFile = path.join(relocOldDir, "incomplete.jsonl");
		const relocNewFile = path.join(relocNewDir, "incomplete.jsonl");
		fs.writeFileSync(relocOldFile, '{"type":"session","id":"incomplete');
		fs.writeFileSync(relocNewFile, '{"type":"session","id":"incomplete');
		recordSessionLineage({
			sessionId: "incomplete-eacces-id",
			parentSession: "root-id",
			sessionPath: relocOldFile,
			cwd,
		});

		const realStat = fsPromises.stat.bind(fsPromises);
		const statSpy = spyOn(fsPromises, "stat").mockImplementation(((target, options) => {
			const resolved = typeof target === "string" ? path.resolve(target) : "";
			if (resolved === path.resolve(eaccesFile) || resolved === path.resolve(relocOldFile)) {
				return Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
			}
			if (resolved === path.resolve(eioFile)) {
				return Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
			}
			return realStat(target, options);
		}) as typeof fsPromises.stat);
		try {
			await deleteMissingSessionLineageUnderDirectory(artifactsDir);
			await repointSessionLineageUnderDirectory(relocOldDir, relocNewDir);
		} finally {
			statSpy.mockRestore();
		}

		expect(getSessionLineage("eacces-id")?.sessionPath).toBe(path.resolve(eaccesFile));
		expect(getSessionLineage("eio-id")?.sessionPath).toBe(path.resolve(eioFile));
		expect(getSessionLineage("enoent-id")).toBeUndefined();
		expect(getSessionLineage("enotdir-id")).toBeUndefined();
		expect(getSessionLineage("dir-id")).toBeUndefined();
		expect(getSessionLineage("incomplete-eacces-id")?.sessionPath).toBe(path.resolve(relocOldFile));

		// Once `relocOldFile` is verifiably ENOENT, repointing succeeds.
		fs.unlinkSync(relocOldFile);
		await repointSessionLineageUnderDirectory(relocOldDir, relocNewDir);
		expect(getSessionLineage("incomplete-eacces-id")?.sessionPath).toBe(path.resolve(relocNewFile));
	});

	it("records normalized parent lineage asynchronously on atomic rewrites without sync parent opens and pre-warms sync parent headers before BEGIN IMMEDIATE", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });

		// Unindexed custom-named parent transcript so resolution must read its header rather than its filename or SQLite.
		const customParentId = Bun.randomUUIDv7();
		const customParentFile = path.join(testAgentDir, "unindexed-custom-parent.jsonl");
		fs.writeFileSync(
			customParentFile,
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id: customParentId,
					timestamp: "2025-05-02T00:00:00.000Z",
					cwd,
					title: "Unindexed custom parent",
				}),
				JSON.stringify({
					type: "message",
					id: "p1",
					parentId: null,
					timestamp: "2025-05-02T00:00:01.000Z",
					message: { role: "user", content: "parent turn", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "p2",
					parentId: "p1",
					timestamp: "2025-05-02T00:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n",
		);
		expect(getSessionLineage(customParentId)).toBeUndefined();

		const syncParentReads: string[] = [];
		const realOpenSync = fs.openSync.bind(fs);
		const openSpy = spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
			if (typeof target === "string" && path.resolve(target) === path.resolve(customParentFile)) {
				syncParentReads.push(target);
			}
			return realOpenSync(target, flags, mode);
		}) as typeof fs.openSync);
		let forkedId = "";
		let forkedFile = "";
		try {
			const forked = await SessionManager.forkFrom(customParentFile, cwd, sessionDir);
			forkedId = forked.getSessionId();
			forkedFile = forked.getSessionFile()!;
			deleteSessionLineage(forkedId);
			forked.setSessionName("Renamed fork");
			await forked.rewriteEntries();
			await forked.close();
		} finally {
			openSpy.mockRestore();
		}

		expect(syncParentReads).toEqual([]);
		expect(getSessionLineage(forkedId)).toMatchObject({
			sessionId: forkedId,
			parentSessionId: customParentId,
			sessionPath: path.resolve(forkedFile),
		});

		// Now verify synchronous `recordSessionLineage` warms unindexed parent headers BEFORE acquiring BEGIN IMMEDIATE.
		const syncParentId = Bun.randomUUIDv7();
		const syncParentFile = path.join(testAgentDir, "sync-prewarm-parent.jsonl");
		fs.writeFileSync(
			syncParentFile,
			`${JSON.stringify({
				type: "session",
				version: 4,
				id: syncParentId,
				timestamp: "2025-05-02T01:00:00.000Z",
				cwd,
			})}\n`,
		);
		// Ensure history.db is already open before spying.
		expect(getSessionLineage(forkedId)?.sessionId).toBe(forkedId);

		let writeLockFreeDuringParentRead = false;
		const syncOpenSpy = spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
			if (typeof target === "string" && path.resolve(target) === path.resolve(syncParentFile)) {
				using probeDb = new Database(getHistoryDbPath());
				probeDb.run("PRAGMA busy_timeout = 0");
				probeDb.run("BEGIN IMMEDIATE");
				probeDb.run("ROLLBACK");
				writeLockFreeDuringParentRead = true;
			}
			return realOpenSync(target, flags, mode);
		}) as typeof fs.openSync);
		const syncChildId = Bun.randomUUIDv7();
		const syncChildFile = path.join(sessionDir, `2025-05-02T01-05-00-000Z_${syncChildId}.jsonl`);
		try {
			recordSessionLineage({
				sessionId: syncChildId,
				parentSession: syncParentFile,
				sessionPath: syncChildFile,
				cwd,
			});
		} finally {
			syncOpenSpy.mockRestore();
		}

		expect(writeLockFreeDuringParentRead).toBe(true);
		expect(getSessionLineage(syncChildId)?.parentSessionId).toBe(syncParentId);
	});

	it("applies one shared parser across parseSessionHeaderText, readSessionHeader, and readSessionHeaderSync for BOM, title-slot, and multi-line headers", async () => {
		const bomDirectFile = path.join(testAgentDir, "bom-direct-header.jsonl");
		const bomDirectText = `\uFEFF${JSON.stringify({
			type: "session",
			version: 4,
			id: "bom-direct",
			timestamp: "2025-05-03T00:00:00.000Z",
			cwd,
			title: "BOM direct",
		})}\n`;
		fs.writeFileSync(bomDirectFile, Buffer.from(bomDirectText, "utf8"));
		expect(parseSessionHeaderText(bomDirectText)).toBeUndefined();
		expect(await readSessionHeader(bomDirectFile)).toBeUndefined();
		expect(readSessionHeaderSync(bomDirectFile)).toBeUndefined();

		const slotLine = serializeTitleSlot({
			title: "Folded slot title",
			source: "user",
			updatedAt: "2025-05-03T00:01:00.000Z",
		});
		const bomSlotFile = path.join(testAgentDir, "bom-slot-header.jsonl");
		const bomSlotText = `\uFEFF${slotLine}${JSON.stringify({
			type: "session",
			version: 4,
			id: "bom-slot",
			timestamp: "2025-05-03T00:01:00.000Z",
			cwd,
		})}\n`;
		fs.writeFileSync(bomSlotFile, Buffer.from(bomSlotText, "utf8"));
		expect(parseSessionHeaderText(bomSlotText)).toBeUndefined();
		expect(await readSessionHeader(bomSlotFile)).toBeUndefined();
		expect(readSessionHeaderSync(bomSlotFile)).toBeUndefined();

		const multilineHeader = JSON.stringify(
			{
				type: "session",
				version: 4,
				id: "shared-parser-session",
				timestamp: "2025-05-03T00:02:00.000Z",
				cwd,
				title: "Stale header title",
				parentSession: "/old/parent.jsonl",
				additionalDirectories: Array.from({ length: 120 }, (_, idx) =>
					path.join(cwd, `multiline-dir-${String(idx).padStart(3, "0")}-${"p".repeat(120)}`),
				),
			},
			null,
			2,
		);
		const trailingBody = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2025-05-03T00:02:01.000Z",
			message: { role: "user", content: "preserve exact body", timestamp: 1 },
		})}\n`;
		const validText = `${slotLine}\r\n  ${multilineHeader}\n${trailingBody}`;
		expect(Buffer.byteLength(validText, "utf8")).toBeGreaterThan(20 * 1024);
		const validFile = path.join(testAgentDir, "valid-multiline-header.jsonl");
		fs.writeFileSync(validFile, validText);

		const fromText = parseSessionHeaderText(validText);
		const fromAsync = await readSessionHeader(validFile);
		const fromSync = readSessionHeaderSync(validFile);
		expect(fromText).toBeDefined();
		expect(fromText?.title).toBe("Folded slot title");
		expect(fromText?.titleSource).toBe("user");
		expect(fromAsync).toEqual(fromText);
		expect(fromSync).toEqual(fromText);

		const truncatedText = validText.slice(0, slotLine.length + 40);
		const truncatedFile = path.join(testAgentDir, "truncated-header.jsonl");
		fs.writeFileSync(truncatedFile, truncatedText);
		expect(parseSessionHeaderText(truncatedText)).toBeUndefined();
		expect(await readSessionHeader(truncatedFile)).toBeUndefined();
		expect(readSessionHeaderSync(truncatedFile)).toBeUndefined();

		const newParentPath = path.join(otherCwd, "relocated-parent.jsonl");
		const rewritten = rewriteSessionHeaderParentText(validText, newParentPath);
		expect(rewritten).toBeDefined();
		expect(rewritten!.startsWith(`${slotLine}\r\n  `)).toBe(true);
		expect(rewritten!.endsWith(`\n${trailingBody}`)).toBe(true);
		expect(parseSessionHeaderText(rewritten!)).toMatchObject({
			id: "shared-parser-session",
			title: "Folded slot title",
			titleSource: "user",
			parentSession: newParentPath,
		});
	});

	it("preserves custom-named root and subtask parent relationships across pack/unpack and cold renamed-root reopening", async () => {
		const agentA = path.join(testAgentDir, "machine-a-agent");
		const agentB = path.join(testAgentDir, "machine-b-agent");
		const cwdA = path.join(testAgentDir, "machine-a", "workspace");
		const cwdB = path.join(testAgentDir, "machine-b", "workspace");
		const customSessionsDirA = path.join(testAgentDir, "machine-a", "custom-sessions");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		fs.mkdirSync(customSessionsDirA, { recursive: true });

		setAgentDir(agentA);
		const rootId = Bun.randomUUIDv7();
		const childId = Bun.randomUUIDv7();
		const nestedGrandchildId = Bun.randomUUIDv7();
		const sharedGrandchildId = Bun.randomUUIDv7();
		const customRootFile = path.join(customSessionsDirA, "custom.jsonl");
		const customArtifactsDir = path.join(customSessionsDirA, "custom");
		const customChildFile = path.join(customArtifactsDir, "0-task.jsonl");
		const customNestedGrandchildFile = path.join(customArtifactsDir, "0-task", "0-subtask.jsonl");
		const customSharedGrandchildFile = path.join(customArtifactsDir, "1-subtask.jsonl");
		fs.mkdirSync(path.dirname(customNestedGrandchildFile), { recursive: true });

		const makeTranscript = (id: string, transcriptCwd: string, parentSession?: string, titleSlotTitle?: string) => {
			const prefix = titleSlotTitle
				? serializeTitleSlot({
						title: titleSlotTitle,
						source: "user",
						updatedAt: "2025-05-03T01:00:00.000Z",
					})
				: "";
			return (
				prefix +
				[
					JSON.stringify({
						type: "session",
						version: 4,
						id,
						timestamp: "2025-05-03T01:00:00.000Z",
						cwd: transcriptCwd,
						...(parentSession ? { parentSession } : {}),
					}),
					JSON.stringify({
						type: "message",
						id: "m1",
						parentId: null,
						timestamp: "2025-05-03T01:00:01.000Z",
						message: { role: "user", content: `turn in ${id}`, timestamp: 1 },
					}),
					JSON.stringify({
						type: "message",
						id: "m2",
						parentId: "m1",
						timestamp: "2025-05-03T01:00:02.000Z",
						message: makeAssistantMessage(),
					}),
				].join("\n") +
				"\n"
			);
		};

		fs.writeFileSync(customRootFile, makeTranscript(rootId, cwdA, undefined, "Custom Root"));
		fs.writeFileSync(customChildFile, makeTranscript(childId, cwdA, customRootFile, "Direct Task"));
		fs.writeFileSync(customNestedGrandchildFile, makeTranscript(nestedGrandchildId, cwdA, customChildFile));
		fs.writeFileSync(customSharedGrandchildFile, makeTranscript(sharedGrandchildId, cwdA, customChildFile));

		const archivePath = path.join(testAgentDir, "custom-root.tar");
		await packSession(customRootFile, archivePath);
		closeSessionIndex();

		// Remove the entire source tree so the receiving machine cannot observe `custom.jsonl`.
		fs.rmSync(path.join(testAgentDir, "machine-a"), { recursive: true, force: true });

		setAgentDir(agentB);
		const unpacked = await unpackSession(archivePath, { cwd: cwdB });
		expect(unpacked.id).toBe(rootId);
		expect(path.basename(unpacked.sessionFile)).toEndWith(`_${rootId}.jsonl`);
		const placedArtifactsDir = unpacked.sessionFile.slice(0, -".jsonl".length);
		const placedChildFile = path.join(placedArtifactsDir, "0-task.jsonl");
		const placedNestedGrandchildFile = path.join(placedArtifactsDir, "0-task", "0-subtask.jsonl");
		const placedSharedGrandchildFile = path.join(placedArtifactsDir, "1-subtask.jsonl");

		expect(getChildSessions(rootId).map(row => row.sessionPath)).toEqual([path.resolve(placedChildFile)]);
		expect(
			getChildSessions(childId)
				.map(row => row.sessionPath)
				.sort(),
		).toEqual([path.resolve(placedNestedGrandchildFile), path.resolve(placedSharedGrandchildFile)].sort());
		expect((await archiveSession(placedChildFile, 5)).records.parent).toBe(path.resolve(unpacked.sessionFile));
		expect((await archiveSession(placedSharedGrandchildFile, 5)).records.parent).toBe(path.resolve(placedChildFile));
		expect((await readSessionHeader(placedChildFile))?.title).toBe("Direct Task");

		// Reopening, appending, and flushing with BOTH warm and cold `session_lineage` preserves parent IDs.
		for (const clearIndexFirst of [false, true]) {
			if (clearIndexFirst) {
				deleteSessionLineage(childId);
				deleteSessionLineage(nestedGrandchildId);
				deleteSessionLineage(sharedGrandchildId);
			}
			for (const targetFile of [placedChildFile, placedNestedGrandchildFile, placedSharedGrandchildFile]) {
				const reopened = await SessionManager.open(targetFile);
				reopened.appendMessage({
					role: "user",
					content: `follow-up cold=${String(clearIndexFirst)}`,
					timestamp: 10,
				});
				reopened.appendMessage(makeAssistantMessage());
				await reopened.flush();
				await reopened.close();
			}
			expect(getSessionLineage(childId)?.parentSessionId).toBe(rootId);
			expect(getSessionLineage(nestedGrandchildId)?.parentSessionId).toBe(childId);
			expect(getSessionLineage(sharedGrandchildId)?.parentSessionId).toBe(childId);
		}

		// Cold fallback check: without manifest/index proof, an unrewritten top-level artifact keeps its raw
		// custom parent path (never guessing root), while a shared-dir grandchild whose sibling `0-task.jsonl`
		// positively exists in the relocated artifact directory resolves to `coldChildId`.
		const coldDir = path.join(testAgentDir, "cold-renamed");
		const coldRootId = Bun.randomUUIDv7();
		const coldChildId = Bun.randomUUIDv7();
		const coldGrandId = Bun.randomUUIDv7();
		const coldRootFile = path.join(coldDir, `2025-05-03T02-00-00-000Z_${coldRootId}.jsonl`);
		const coldArtifactsDir = coldRootFile.slice(0, -".jsonl".length);
		const coldChildFile = path.join(coldArtifactsDir, "0-task.jsonl");
		const coldGrandFile = path.join(coldArtifactsDir, "1-subtask.jsonl");
		fs.mkdirSync(coldArtifactsDir, { recursive: true });
		const vanishedCustomRoot = path.join(testAgentDir, "vanished-origin", " bespoke.jsonl");
		const vanishedCustomChild = path.join(testAgentDir, "vanished-origin", " bespoke", "0-task.jsonl");
		fs.writeFileSync(coldRootFile, makeTranscript(coldRootId, cwdB));
		fs.writeFileSync(coldChildFile, makeTranscript(coldChildId, cwdB, vanishedCustomRoot));
		fs.writeFileSync(coldGrandFile, makeTranscript(coldGrandId, cwdB, vanishedCustomChild));

		expect(
			resolveParentSessionReference(vanishedCustomRoot, {
				forSessionId: coldChildId,
				sessionPath: coldChildFile,
			}),
		).toBe(vanishedCustomRoot);
		expect(
			resolveParentSessionReference(vanishedCustomChild, {
				forSessionId: coldGrandId,
				sessionPath: coldGrandFile,
			}),
		).toBe(coldChildId);
	});

	it("reconciles salvaged session_lineage rows against session_path owners so quarantine recovery never resurrects superseded owners", () => {
		const reusedNewerTargetPath = path.join(cwd, "reused-newer-target.jsonl");
		const reusedTiePath = path.join(cwd, "reused-tie.jsonl");
		const reusedNewerSourcePath = path.join(cwd, "reused-newer-source.jsonl");

		const sourcePath = path.join(testAgentDir, "quarantined-source.db");
		{
			using source = new Database(sourcePath, { create: true });
			source.run(`
				CREATE TABLE session_lineage (
					session_id TEXT PRIMARY KEY,
					parent_session_id TEXT,
					session_path TEXT NOT NULL,
					cwd TEXT,
					updated_at INTEGER NOT NULL
				)
			`);
			const insert = source.prepare(
				"INSERT INTO session_lineage (session_id, parent_session_id, session_path, cwd, updated_at) VALUES (?, ?, ?, ?, ?)",
			);
			insert.run("old-superseded-id", "old-parent-id", reusedNewerTargetPath, cwd, 100);
			insert.run("tie-superseded-id", "tie-old-parent-id", reusedTiePath, cwd, 100);
			insert.run("newer-salvaged-id", "newer-salvaged-parent-id", reusedNewerSourcePath, cwd, 300);
		}

		// Populate the live history.db (`target`) with replacement owners at `reusedNewerTargetPath` (updated_at=200),
		// `reusedTiePath` (updated_at=100), and an older owner at `reusedNewerSourcePath` (updated_at=100).
		recordSessionLineages([
			{
				sessionId: "new-replacement-id",
				parentSession: "new-parent-id",
				sessionPath: reusedNewerTargetPath,
				cwd,
				updatedAt: 200,
			},
			{
				sessionId: "tie-replacement-id",
				parentSession: "tie-new-parent-id",
				sessionPath: reusedTiePath,
				cwd,
				updatedAt: 100,
			},
			{
				sessionId: "older-target-id",
				parentSession: "older-target-parent-id",
				sessionPath: reusedNewerSourcePath,
				cwd,
				updatedAt: 100,
			},
		]);
		closeSessionIndex();

		{
			using source = new Database(sourcePath, { readonly: true });
			using target = new Database(getHistoryDbPath());
			const salvaged = salvageSessionIndex(source, target);
			expect(salvaged.lineages).toBe(1);
			const duplicatePathOwners = target
				.query<{ session_path: string; owners: number }, []>(
					"SELECT session_path, COUNT(*) AS owners FROM session_lineage GROUP BY session_path HAVING COUNT(*) > 1",
				)
				.all();
			expect(duplicatePathOwners).toEqual([]);
		}

		expect(getSessionLineage("old-superseded-id")).toBeUndefined();
		expect(getChildSessions("old-parent-id")).toEqual([]);
		expect(getSessionLineage(reusedNewerTargetPath)?.sessionId).toBe("new-replacement-id");
		expect(getChildSessions("new-parent-id").map(row => row.sessionId)).toEqual(["new-replacement-id"]);

		expect(getSessionLineage("tie-superseded-id")).toBeUndefined();
		expect(getChildSessions("tie-old-parent-id")).toEqual([]);
		expect(getSessionLineage(reusedTiePath)?.sessionId).toBe("tie-replacement-id");

		expect(getSessionLineage("older-target-id")).toBeUndefined();
		expect(getChildSessions("older-target-parent-id")).toEqual([]);
		expect(getSessionLineage("newer-salvaged-id")).toMatchObject({
			sessionId: "newer-salvaged-id",
			parentSessionId: "newer-salvaged-parent-id",
			sessionPath: path.resolve(reusedNewerSourcePath),
		});
	});

	it("preserves retained source lineage for same-id subtask merge collisions in moveTo and repointSessionLineageUnderDirectory", async () => {
		const parent = SessionManager.create(cwd);
		parent.appendMessage({ role: "user", content: "parent before move", timestamp: 1 });
		parent.appendMessage(makeAssistantMessage());
		await parent.flush();
		const parentId = parent.getSessionId();
		const oldParentFile = parent.getSessionFile()!;
		const oldArtifactsDir = oldParentFile.slice(0, -".jsonl".length);
		fs.mkdirSync(oldArtifactsDir, { recursive: true });

		const collidedSubtaskId = Bun.randomUUIDv7();
		const movedSubtaskId = Bun.randomUUIDv7();
		const oldCollidedSubtaskFile = path.join(oldArtifactsDir, "0-task.jsonl");
		const oldMovedSubtaskFile = path.join(oldArtifactsDir, "1-task.jsonl");

		const makeSubtaskContent = (id: string, marker: string) =>
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id,
					timestamp: "2025-05-04T00:00:00.000Z",
					cwd,
					parentSession: oldParentFile,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-05-04T00:00:01.000Z",
					message: { role: "user", content: marker, timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-05-04T00:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n";

		fs.writeFileSync(oldCollidedSubtaskFile, makeSubtaskContent(collidedSubtaskId, "newer-source-copy"));
		fs.writeFileSync(oldMovedSubtaskFile, makeSubtaskContent(movedSubtaskId, "cleanly-moved-copy"));
		recordSessionLineages([
			{
				sessionId: collidedSubtaskId,
				parentSession: parentId,
				sessionPath: oldCollidedSubtaskFile,
				cwd,
			},
			{
				sessionId: movedSubtaskId,
				parentSession: parentId,
				sessionPath: oldMovedSubtaskFile,
				cwd,
			},
		]);

		// Seed an older copy with the SAME filename and SAME sessionId in the destination artifacts dir.
		const destSessionDir = SessionManager.getDefaultSessionDir(otherCwd);
		const destParentFile = path.join(destSessionDir, path.basename(oldParentFile));
		const destArtifactsDir = destParentFile.slice(0, -".jsonl".length);
		fs.mkdirSync(destArtifactsDir, { recursive: true });
		const staleDestCollidedFile = path.join(destArtifactsDir, "0-task.jsonl");
		fs.writeFileSync(staleDestCollidedFile, makeSubtaskContent(collidedSubtaskId, "older-stale-dest-copy"));

		await parent.moveTo(otherCwd);
		await parent.close();

		const destMovedSubtaskFile = path.join(destArtifactsDir, "1-task.jsonl");
		expect(fs.existsSync(oldCollidedSubtaskFile)).toBe(true);
		expect(fs.readFileSync(oldCollidedSubtaskFile, "utf8")).toContain("newer-source-copy");
		expect(fs.readFileSync(staleDestCollidedFile, "utf8")).toContain("older-stale-dest-copy");
		expect(fs.existsSync(oldMovedSubtaskFile)).toBe(false);
		expect(fs.existsSync(destMovedSubtaskFile)).toBe(true);

		expect(getSessionLineage(collidedSubtaskId)?.sessionPath).toBe(path.resolve(oldCollidedSubtaskFile));
		expect(getSessionLineage(movedSubtaskId)?.sessionPath).toBe(path.resolve(destMovedSubtaskFile));
		expect(
			getChildSessions(parentId)
				.map(row => row.sessionPath)
				.sort(),
		).toEqual([path.resolve(oldCollidedSubtaskFile), path.resolve(destMovedSubtaskFile)].sort());

		// Direct `repointSessionLineageUnderDirectory`: distinct same-id copy stays on `oldDir`, while a hard-linked
		// destination copy (same inode, simulating `link()` succeeding and `unlink()` failing) repoints to `newDir`.
		const directOldDir = path.join(testAgentDir, "direct-repoint-old");
		const directNewDir = path.join(testAgentDir, "direct-repoint-new");
		fs.mkdirSync(directOldDir, { recursive: true });
		fs.mkdirSync(directNewDir, { recursive: true });

		const distinctSameId = Bun.randomUUIDv7();
		const linkedSameId = Bun.randomUUIDv7();
		const distinctOldFile = path.join(directOldDir, "distinct.jsonl");
		const distinctNewFile = path.join(directNewDir, "distinct.jsonl");
		const linkedOldFile = path.join(directOldDir, "linked.jsonl");
		const linkedNewFile = path.join(directNewDir, "linked.jsonl");

		fs.writeFileSync(distinctOldFile, makeSubtaskContent(distinctSameId, "distinct-newer"));
		fs.writeFileSync(distinctNewFile, makeSubtaskContent(distinctSameId, "distinct-older"));
		fs.writeFileSync(linkedOldFile, makeSubtaskContent(linkedSameId, "hardlinked-copy"));
		fs.linkSync(linkedOldFile, linkedNewFile);

		recordSessionLineages([
			{
				sessionId: distinctSameId,
				parentSession: parentId,
				sessionPath: distinctOldFile,
				cwd,
			},
			{
				sessionId: linkedSameId,
				parentSession: parentId,
				sessionPath: linkedOldFile,
				cwd,
			},
		]);

		await repointSessionLineageUnderDirectory(directOldDir, directNewDir);
		expect(getSessionLineage(distinctSameId)?.sessionPath).toBe(path.resolve(distinctOldFile));
		expect(getSessionLineage(linkedSameId)?.sessionPath).toBe(path.resolve(linkedNewFile));
	});

	it("resolves foreign Windows parentSession paths across lineage indexing, child queries, and archive details", async () => {
		const parent = SessionManager.create(cwd);
		parent.appendMessage({ role: "user", content: "windows parent root", timestamp: 1 });
		parent.appendMessage(makeAssistantMessage());
		await parent.flush();
		const parentId = parent.getSessionId();
		const parentFile = parent.getSessionFile()!;
		await parent.close();

		const winGeneratedParent = `C:\\sessions\\2026-10-26T18-29-27-740Z_${parentId}.jsonl`;
		const uncGeneratedParent = `\\\\fileserver\\share\\sessions\\2026-10-26T18-29-27-740Z_${parentId}.jsonl`;
		expect(parseSessionFileName(winGeneratedParent)?.id).toBe(parentId);
		expect(parseSessionFileName(uncGeneratedParent)?.id).toBe(parentId);

		const sessionDir = path.dirname(parentFile);
		const makeForeignTranscript = (id: string, sessionCwd: string, parentSession: string) =>
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id,
					timestamp: "2026-10-26T18:30:00.000Z",
					cwd: sessionCwd,
					parentSession,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-10-26T18:30:01.000Z",
					message: { role: "user", content: `turn in ${id}`, timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2026-10-26T18:30:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n";

		const branchedChildId = Bun.randomUUIDv7();
		const branchedChildFile = path.join(sessionDir, `2026-10-26T18-30-00-000Z_${branchedChildId}.jsonl`);
		fs.writeFileSync(
			branchedChildFile,
			makeForeignTranscript(branchedChildId, "C:\\Users\\alice\\project", winGeneratedParent),
		);

		const artifactsDir = parentFile.slice(0, -".jsonl".length);
		fs.mkdirSync(artifactsDir, { recursive: true });
		const taskChildId = Bun.randomUUIDv7();
		const taskGrandchildId = Bun.randomUUIDv7();
		const taskChildFile = path.join(artifactsDir, "0-task.jsonl");
		const taskGrandchildFile = path.join(artifactsDir, "1-subtask.jsonl");
		const winTaskChildParent = `C:\\Users\\alice\\.omp\\agent\\sessions\\${path.basename(parentFile)}`;
		const winTaskGrandParent = `C:\\Users\\alice\\.omp\\agent\\sessions\\${path.basename(artifactsDir)}\\0-task.jsonl`;
		fs.writeFileSync(taskChildFile, makeForeignTranscript(taskChildId, cwd, winTaskChildParent));
		fs.writeFileSync(taskGrandchildFile, makeForeignTranscript(taskGrandchildId, cwd, winTaskGrandParent));

		const originalCwd = process.cwd();
		const decoyCwd = path.join(testAgentDir, "posix-cwd-decoy");
		fs.mkdirSync(decoyCwd, { recursive: true });
		if (process.platform !== "win32") {
			const decoyId = Bun.randomUUIDv7();
			const decoyFile = path.join(decoyCwd, winGeneratedParent);
			fs.writeFileSync(decoyFile, makeForeignTranscript(decoyId, cwd, "decoy-root"));
			process.chdir(decoyCwd);
		}

		try {
			recordSessionLineages([
				{
					sessionId: branchedChildId,
					parentSession: winGeneratedParent,
					sessionPath: branchedChildFile,
					cwd: "C:\\Users\\alice\\project",
				},
				{
					sessionId: taskChildId,
					parentSession: winTaskChildParent,
					sessionPath: taskChildFile,
					cwd,
				},
				{
					sessionId: taskGrandchildId,
					parentSession: winTaskGrandParent,
					sessionPath: taskGrandchildFile,
					cwd,
				},
			]);

			expect(getSessionLineage(branchedChildId)?.parentSessionId).toBe(parentId);
			if (process.platform !== "win32") {
				expect(getSessionLineage(branchedChildId)?.cwd).toBe("C:\\Users\\alice\\project");
			}
			expect(getSessionLineage(winGeneratedParent)?.sessionId).toBe(parentId);
			expect(getSessionLineage(uncGeneratedParent)?.sessionId).toBe(parentId);
			expect(
				getChildSessions(parentId)
					.map(row => row.sessionId)
					.sort(),
			).toEqual([branchedChildId, taskChildId].sort());
			expect(
				getChildSessions(winGeneratedParent)
					.map(row => row.sessionId)
					.sort(),
			).toEqual([branchedChildId, taskChildId].sort());
			expect(getChildSessions(taskChildId).map(row => row.sessionId)).toEqual([taskGrandchildId]);

			const detail = await archiveSession(branchedChildFile, 5);
			expect(detail.records.parent).toBe(path.resolve(parentFile));
		} finally {
			if (process.cwd() !== originalCwd) {
				process.chdir(originalCwd);
			}
		}
	});

	it("does not rewrite or reparent an unpacked shared-directory grandchild to root when its intermediate parent is missing", async () => {
		const agentA = path.join(testAgentDir, "orphan-agent-a");
		const agentB = path.join(testAgentDir, "orphan-agent-b");
		const agentC = path.join(testAgentDir, "orphan-agent-c");
		const cwdA = path.join(testAgentDir, "orphan-machine-a", "proj");
		const cwdB = path.join(testAgentDir, "orphan-machine-b", "proj");
		const cwdC = path.join(testAgentDir, "orphan-machine-c", "proj");
		const customSessionDir = path.join(testAgentDir, "orphan-machine-a", "custom-sessions");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		fs.mkdirSync(cwdC, { recursive: true });
		fs.mkdirSync(customSessionDir, { recursive: true });
		setAgentDir(agentA);

		const makeTranscript = (id: string, sessionCwd: string, parentSession?: string) =>
			[
				JSON.stringify({
					type: "session",
					version: 4,
					id,
					timestamp: "2025-05-05T01:00:00.000Z",
					cwd: sessionCwd,
					...(parentSession ? { parentSession } : {}),
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2025-05-05T01:00:01.000Z",
					message: { role: "user", content: `turn in ${id}`, timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2025-05-05T01:00:02.000Z",
					message: makeAssistantMessage(),
				}),
			].join("\n") + "\n";

		const rootId = Bun.randomUUIDv7();
		const grandchildId = Bun.randomUUIDv7();
		const customRootFile = path.join(customSessionDir, "custom.jsonl");
		const customArtifactsDir = path.join(customSessionDir, "custom");
		const missingChildFile = path.join(customArtifactsDir, "0-task.jsonl");
		const survivingGrandchildFile = path.join(customArtifactsDir, "1-subtask.jsonl");
		fs.mkdirSync(customArtifactsDir, { recursive: true });
		fs.writeFileSync(customRootFile, makeTranscript(rootId, cwdA));
		// `0-task.jsonl` is intentionally absent so `1-subtask.jsonl` is the ONLY JSONL artifact in the archive.
		fs.writeFileSync(survivingGrandchildFile, makeTranscript(grandchildId, cwdA, missingChildFile));

		const archivePath = path.join(testAgentDir, "orphan-grandchild.tar");
		await packSession(customRootFile, archivePath);

		// Also prepare a legacy v1 archive with `sessionFile` omitted from `manifest.json`.
		const legacyMembers = await readArchiveEntries({ path: archivePath, format: "tar" });
		const parsedManifest = JSON.parse(new TextDecoder().decode(legacyMembers.get("manifest.json"))) as Record<
			string,
			unknown
		>;
		expect(parsedManifest.sessionFile).toBe(path.resolve(customRootFile));
		delete parsedManifest.sessionFile;
		delete parsedManifest.realSessionFile;
		legacyMembers.set("manifest.json", new TextEncoder().encode(`${JSON.stringify(parsedManifest, null, 2)}\n`));
		const legacyOrphanArchivePath = path.join(testAgentDir, "orphan-grandchild-v1.tar");
		await writeArchive(legacyOrphanArchivePath, "tar", legacyMembers);

		// Also prepare a legacy v1 archive where `0-task.jsonl` IS present alongside `1-subtask.jsonl`.
		const fullChildId = Bun.randomUUIDv7();
		fs.writeFileSync(missingChildFile, makeTranscript(fullChildId, cwdA, customRootFile));
		const fullArchivePath = path.join(testAgentDir, "full-custom.tar");
		await packSession(customRootFile, fullArchivePath);
		const fullMembers = await readArchiveEntries({ path: fullArchivePath, format: "tar" });
		const fullManifest = JSON.parse(new TextDecoder().decode(fullMembers.get("manifest.json"))) as Record<
			string,
			unknown
		>;
		delete fullManifest.sessionFile;
		delete fullManifest.realSessionFile;
		fullMembers.set("manifest.json", new TextEncoder().encode(`${JSON.stringify(fullManifest, null, 2)}\n`));
		const legacyFullArchivePath = path.join(testAgentDir, "full-custom-v1.tar");
		await writeArchive(legacyFullArchivePath, "tar", fullMembers);
		closeSessionIndex();

		fs.rmSync(path.join(testAgentDir, "orphan-machine-a"), { recursive: true, force: true });

		for (const [targetAgent, targetCwd, targetArchive] of [
			[agentB, cwdB, archivePath],
			[agentC, cwdC, legacyOrphanArchivePath],
		] as const) {
			setAgentDir(targetAgent);
			const unpacked = await unpackSession(targetArchive, { cwd: targetCwd });
			const placedGrandchild = path.join(unpacked.sessionFile.slice(0, -".jsonl".length), "1-subtask.jsonl");
			expect((await readSessionHeader(placedGrandchild))?.parentSession).toBe(missingChildFile);
			expect(getChildSessions(unpacked.id)).toEqual([]);
			expect(getSessionLineage(grandchildId)?.parentSessionId).toBe(missingChildFile);

			deleteSessionLineage(grandchildId);
			const reopened = await SessionManager.open(placedGrandchild);
			reopened.appendMessage({ role: "user", content: "follow-up on orphan grandchild", timestamp: 20 });
			reopened.appendMessage(makeAssistantMessage());
			await reopened.flush();
			await reopened.close();
			expect((await readSessionHeader(placedGrandchild))?.parentSession).toBe(missingChildFile);
			expect(getChildSessions(unpacked.id)).toEqual([]);
			expect(getSessionLineage(grandchildId)?.parentSessionId).toBe(missingChildFile);
		}

		// Legacy v1 archive WITH `0-task.jsonl` + `1-subtask.jsonl` positively derives `custom.jsonl` from sibling match.
		const agentD = path.join(testAgentDir, "orphan-agent-d");
		const cwdD = path.join(testAgentDir, "orphan-machine-d", "proj");
		fs.mkdirSync(cwdD, { recursive: true });
		setAgentDir(agentD);
		const unpackedLegacyFull = await unpackSession(legacyFullArchivePath, { cwd: cwdD });
		const legacyArtifactsDir = unpackedLegacyFull.sessionFile.slice(0, -".jsonl".length);
		const placedLegacyChild = path.join(legacyArtifactsDir, "0-task.jsonl");
		const placedLegacyGrandchild = path.join(legacyArtifactsDir, "1-subtask.jsonl");
		expect((await readSessionHeader(placedLegacyChild))?.parentSession).toBe(unpackedLegacyFull.sessionFile);
		expect((await readSessionHeader(placedLegacyGrandchild))?.parentSession).toBe(placedLegacyChild);
		expect(getChildSessions(unpackedLegacyFull.id).map(row => row.sessionPath)).toEqual([
			path.resolve(placedLegacyChild),
		]);
		expect(getChildSessions(fullChildId).map(row => row.sessionPath)).toEqual([path.resolve(placedLegacyGrandchild)]);
	});
});
