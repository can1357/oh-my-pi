import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import type { SessionEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	getRecentSessions,
	listSessions,
	listSessionsReadOnly,
	readSessionInfo,
	sessionDisplayName,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	overlayTitleSlotContent,
	serializeTitleSlot,
	type SessionTitleUpdate,
} from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const timestamp = "2026-01-01T00:00:00.000Z";
const latestTitle = "Latest journal title 🐈";
const staleSlot = { title: "Old slot title", source: "auto", updatedAt: timestamp } as const;

class Backend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	async init() {}
	async loadIndex() {
		return [...this.files].map(([path, text]) => ({ path, size: Buffer.byteLength(text), mtimeMs: 0 }));
	}
	async readFull(file: string) {
		return this.files.get(file) ?? null;
	}
	async readSlices(file: string, prefix: number, suffix: number): Promise<[string, string]> {
		const bytes = Buffer.from(this.files.get(file) ?? "");
		return [bytes.subarray(0, prefix).toString(), suffix ? bytes.subarray(-suffix).toString() : ""];
	}
	async append(file: string, text: string) {
		this.files.set(file, (this.files.get(file) ?? "") + text);
	}
	async writeFull(file: string, text: string) {
		this.files.set(file, text);
	}
	async updateSessionTitle(file: string, title: SessionTitleUpdate) {
		this.files.set(file, overlayTitleSlotContent(this.files.get(file)!, title));
	}
	async truncate(file: string) {
		this.files.set(file, "");
	}
	async remove(files: string[]) {
		for (const file of files) this.files.delete(file);
	}
	async move(from: string, to: string) {
		this.files.set(to, this.files.get(from)!);
		this.files.delete(from);
	}
}

function user(id: string, parentId: string | null, text: string): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: text, timestamp: 1 } };
}

function journal(cwd: string, withSlot: boolean, payloadSize = 96 * 1024): string {
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: path.basename(cwd),
		cwd,
		timestamp,
		title: "Old header title",
		titleSource: "auto",
	};
	const entries: SessionEntry[] = [
		user("root", null, "First prompt"),
		{
			type: "title_change",
			id: "first-title",
			parentId: "root",
			timestamp,
			title: "Older journal title",
			source: "auto",
		},
		user("history", "first-title", "x".repeat(payloadSize)),
		{
			type: "compaction",
			id: "compacted",
			parentId: "history",
			timestamp,
			firstKeptEntryId: "",
			summary: "Old summary",
			tokensBefore: 1,
		},
		// Renaming on a sibling is still session-global. Physical order, not the
		// timestamp (deliberately equal here), decides which journal title wins.
		{ type: "title_change", id: "latest-title", parentId: "root", timestamp, title: latestTitle, source: "user" },
		user("kept", "compacted", "Active branch after rename"),
		{ type: "message", id: "reply", parentId: "kept", timestamp, message: makeAssistantMessage() },
		{
			type: "custom",
			id: "large-tail",
			parentId: "reply",
			timestamp,
			customType: "title-loading-tail",
			data: "y".repeat(40 * 1024),
		},
	];
	return (
		(withSlot ? serializeTitleSlot(staleSlot) : "") +
		[header, ...entries].map(entry => JSON.stringify(entry)).join("\n") +
		"\n"
	);
}

async function storageFor(kind: "file" | "memory" | "indexed"): Promise<SessionStorage> {
	if (kind === "file") return new FileSessionStorage();
	if (kind === "memory") return new MemorySessionStorage();
	const storage = new IndexedSessionStorage(new Backend());
	await storage.initialize();
	return storage;
}

for (const withSlot of [true, false]) {
	describe(withSlot ? "journal titles over stale title slots" : "journal titles in legacy no-slot files", () => {
		it("folds the latest session-global title and source in full and streamed loads", async () => {
			using dir = TempDir.createSync("@title-journal-load-");
			const file = path.join(dir.path(), "session.jsonl");
			const content = journal(dir.path(), withSlot);
			await Bun.write(file, content);
			for (const loaded of [
				sessionLoader.parseSessionContent(content),
				await sessionLoader.loadEntriesFromFileStream(file),
			]) {
				expect(loaded.entries[0]).toMatchObject({ title: latestTitle, titleSource: "user" });
				expect(loaded.latestTitle).toEqual({ title: latestTitle, source: "user", updatedAt: timestamp });
				// Physical slot presence is not title authority and must remain exact.
				expect(loaded.titleSlot).toEqual(withSlot ? staleSlot : undefined);
			}
			expect(await Bun.file(file).text()).toBe(content);
		});

		for (const kind of ["file", "memory", "indexed"] as const) {
			it(`opens and closes ${kind} without writing or claiming while exposing the latest title`, async () => {
				using dir = TempDir.createSync("@title-journal-open-");
				const storage = await storageFor(kind);
				const file = path.join(dir.path(), "session.jsonl");
				const content = journal(dir.path(), withSlot);
				await storage.writeTextAtomic(file, content);
				const claim = storage instanceof FileSessionStorage ? spyOn(storage, "claimSession") : undefined;
				let session: SessionManager | undefined;
				try {
					session = await SessionManager.open(file, dir.path(), storage, { suppressBreadcrumb: true });
					expect(session.getSessionName()).toBe(latestTitle);
					expect(session.titleSource).toBe("user");
					expect(session.getHeader()).toMatchObject({ title: latestTitle, titleSource: "user" });
					expect(session.getLeafEntry()?.id).toBe("large-tail");
					await session.close();
					expect(await storage.readText(file)).toBe(content);
					if (claim) expect(claim).not.toHaveBeenCalled();
				} finally {
					await session?.close();
					claim?.mockRestore();
				}
			});

			it(`lists and picks the title outside prefix and suffix windows on ${kind}`, async () => {
				using dir = TempDir.createSync("@title-journal-list-");
				const storage = await storageFor(kind);
				const file = path.join(dir.path(), "session.jsonl");
				const content = journal(dir.path(), withSlot);
				await storage.writeTextAtomic(file, content);
				for (const sessions of [
					await listSessions(dir.path(), storage),
					await listSessionsReadOnly(dir.path(), storage),
				]) {
					expect(sessions).toHaveLength(1);
					expect(sessions[0].title).toBe(latestTitle);
					expect(sessionDisplayName(sessions[0])).toBe(latestTitle);
				}
				expect((await getRecentSessions(dir.path(), 1, storage))[0]?.name).toBe(latestTitle);
				if (kind === "file") expect((await readSessionInfo(file))?.title).toBe(latestTitle);
				const writer = storage.openWriter(file);
				await writer.append(
					JSON.stringify({
						type: "title_change",
						id: "newest",
						parentId: "large-tail",
						timestamp,
						title: "Appended rename",
						source: "auto",
					}) + "\n",
				);
				await writer.close();
				expect((await listSessions(dir.path(), storage))[0]?.title).toBe("Appended rename");
			});
		}
	});
}

it("loads a streamed large journal without letting its stale slot win", async () => {
	using dir = TempDir.createSync("@title-journal-stream-");
	const storage = new FileSessionStorage();
	const file = path.join(dir.path(), "session.jsonl");
	const content = journal(dir.path(), true, 8 * 1024 * 1024);
	await storage.writeTextAtomic(file, content);
	const session = await SessionManager.open(file, dir.path(), storage, { suppressBreadcrumb: true });
	try {
		expect(session.getSessionName()).toBe(latestTitle);
		expect(session.titleSource).toBe("user");
	} finally {
		await session.close();
	}
	expect(await storage.readText(file)).toBe(content);
});
