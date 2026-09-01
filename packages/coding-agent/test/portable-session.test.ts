import { describe, expect, it } from "bun:test";
import {
	PORTABLE_SESSION_FORMAT,
	PORTABLE_SESSION_FORMAT_VERSION,
	parsePortableSessionSnapshot,
	type PortableSessionSnapshot,
} from "@oh-my-pi/pi-coding-agent/session/portable-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

function validSnapshot(): PortableSessionSnapshot {
	return {
		format: PORTABLE_SESSION_FORMAT,
		formatVersion: PORTABLE_SESSION_FORMAT_VERSION,
		header: {
			type: "session",
			version: 3,
			id: "source-session",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: "/source",
		},
		entries: [
			{
				type: "custom",
				id: "root",
				parentId: null,
				timestamp: "2026-09-01T00:00:01.000Z",
				customType: "fixture",
			},
		],
		leafId: "root",
	};
}

describe("portable OMP sessions", () => {
	it("exports a detached logical snapshot without prior local file paths", async () => {
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create("/source", "/sessions/source", storage);
		manager.getHeader()!.previousSessionFiles = ["/old/private/session.jsonl"];
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		const snapshot = await manager.exportPortableSession();
		expect(snapshot).toMatchObject({
			format: PORTABLE_SESSION_FORMAT,
			formatVersion: PORTABLE_SESSION_FORMAT_VERSION,
			leafId: manager.getLeafId(),
		});
		expect(snapshot.header.previousSessionFiles).toBeUndefined();

		snapshot.header.title = "changed outside manager";
		snapshot.entries.length = 0;
		expect(manager.getHeader()?.title).toBeUndefined();
		expect(manager.getEntries()).toHaveLength(1);
	});

	it("imports under a fresh identity and durably restores the selected branch", async () => {
		const storage = new MemorySessionStorage();
		const source = SessionManager.create("/source", "/sessions/source", storage);
		await source.setSessionName("Portable fixture", "user");
		const rootId = source.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const selectedId = source.appendMessage({ role: "user", content: "selected", timestamp: 2 });
		source.branch(rootId);
		const siblingId = source.appendMessage({ role: "user", content: "sibling", timestamp: 3 });
		source.branch(selectedId);
		const snapshot = await source.exportPortableSession();

		const imported = await SessionManager.importPortableSession(snapshot, {
			cwd: "/destination",
			sessionDir: "/sessions/destination",
			storage,
			suppressBreadcrumb: true,
		});
		const importedFile = imported.getSessionFile();
		if (!importedFile) throw new Error("Expected imported session file");
		const importedId = imported.getSessionId();
		await imported.close();

		const reopened = await SessionManager.open(importedFile, "/sessions/destination", storage, {
			initialCwd: "/destination",
			suppressBreadcrumb: true,
		});
		const header = reopened.getHeader();
		expect(header).toMatchObject({
			id: importedId,
			cwd: "/destination",
			title: "Portable fixture",
			parentSession: snapshot.header.id,
		});
		expect(importedId).not.toBe(snapshot.header.id);
		expect(header?.providerPromptCacheKey).toBeUndefined();

		const branchIds = reopened.getBranch().map(entry => entry.id);
		expect(branchIds).toContain(rootId);
		expect(branchIds).toContain(selectedId);
		expect(branchIds).not.toContain(siblingId);
		expect(reopened.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: "portable_session_import",
			data: {
				sourceSessionId: snapshot.header.id,
				sourceLeafId: selectedId,
				formatVersion: PORTABLE_SESSION_FORMAT_VERSION,
			},
		});
		await reopened.close();
	});

	it("rejects snapshots whose selected leaf is absent", () => {
		const snapshot = validSnapshot();
		snapshot.leafId = "missing";
		expect(() => parsePortableSessionSnapshot(snapshot)).toThrow("leaf missing does not exist");
	});

	it("rejects snapshots with cyclic entry ancestry", () => {
		const snapshot = validSnapshot();
		snapshot.entries.push({
			type: "custom",
			id: "child",
			parentId: "root",
			timestamp: "2026-09-01T00:00:02.000Z",
			customType: "fixture",
		});
		snapshot.entries[0]!.parentId = "child";
		expect(() => parsePortableSessionSnapshot(snapshot)).toThrow("entry ancestry contains a cycle");
	});

	it("rejects unsupported portable format versions", () => {
		const snapshot = { ...validSnapshot(), formatVersion: 2 };
		expect(() => parsePortableSessionSnapshot(snapshot)).toThrow("unsupported format version 2");
	});
});
