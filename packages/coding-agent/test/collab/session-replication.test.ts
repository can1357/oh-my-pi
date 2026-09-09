import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeManager(): { manager: SessionManager; cwd: string } {
	const dir = TempDir.createSync("@pi-collab-repl-");
	tempDirs.push(dir);
	const cwd = dir.path();
	return { manager: SessionManager.create(cwd, path.join(cwd, "sessions")), cwd };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

// Comfortably above BLOB_EXTERNALIZE_THRESHOLD (1024 base64 chars).
const BIG_IMAGE_B64 = Buffer.alloc(1024, 7).toString("base64");

describe("SessionManager collab replication", () => {
	it("onEntryAppended receives the in-memory entry with inline image data while the persisted line externalizes it", async () => {
		const { manager } = makeManager();
		const captured: SessionEntry[] = [];
		manager.onEntryAppended = entry => captured.push(entry);

		manager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "look at this" },
				{ type: "image", data: BIG_IMAGE_B64, mimeType: "image/png" },
			],
			timestamp: Date.now(),
		});
		// Persistence is deferred until an assistant message exists; force it.
		await manager.rewriteEntries();

		expect(captured).toHaveLength(1);
		const hooked = captured[0]!;
		if (hooked.type !== "message" || hooked.message.role !== "user" || typeof hooked.message.content === "string") {
			throw new Error("unexpected hook entry shape");
		}
		const hookedImage = hooked.message.content.find(c => c.type === "image");
		expect(hookedImage?.data).toBe(BIG_IMAGE_B64);

		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
		const persisted = lines.map(line => JSON.parse(line)).find(e => e.type === "message");
		const persistedImage = persisted.message.content.find((c: { type: string; data?: string }) => c.type === "image");
		expect(isBlobRef(persistedImage.data)).toBe(true);
	});

	it("swallows hook failures so persistence is never broken by a broadcast error", () => {
		const { manager } = makeManager();
		manager.onEntryAppended = () => {
			throw new Error("socket exploded");
		};
		const id = manager.appendMessage({ role: "user", content: "still works", timestamp: Date.now() });
		expect(manager.getEntry(id)?.id).toBe(id);
	});

	it("ingestReplicatedEntry preserves foreign ids and advances the leaf", async () => {
		const { manager } = makeManager();
		const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });

		const foreign: SessionEntry = {
			type: "message",
			id: "feed0001",
			parentId: rootId,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "from the host", timestamp: Date.now() },
		};
		manager.ingestReplicatedEntry(foreign);

		expect(manager.getEntry("feed0001")?.parentId).toBe(rootId);
		// Leaf advanced: the next locally appended entry chains off the ingested one.
		const nextId = manager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		expect(manager.getEntry(nextId)?.parentId).toBe("feed0001");

		// Round-trip: a fresh manager loading the file sees the foreign ids verbatim.
		await manager.rewriteEntries();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		const { manager: loaded } = makeManager();
		await loaded.setSessionFile(file);
		expect(loaded.getEntry("feed0001")?.parentId).toBe(rootId);
		expect(loaded.getEntry(nextId)?.parentId).toBe("feed0001");
	});

	it("snapshotForReplication deep-copies entries and preserves the header identity", () => {
		const cwd = process.cwd();
		const manager = SessionManager.inMemory(cwd);
		manager.appendMessage({ role: "user", content: "snapshot me", timestamp: Date.now() });

		const snapshot = manager.snapshotForReplication();
		expect(snapshot.header.id).toBe(manager.getSessionId());
		expect(snapshot.header.cwd).toBe(path.resolve(cwd));
		expect(snapshot.entries).toHaveLength(1);

		// Deep copy: mutating the snapshot must not leak into the live session.
		const entry = snapshot.entries[0]!;
		if (entry.type !== "message") throw new Error("unexpected entry type");
		entry.message = { role: "user", content: "mutated", timestamp: 0 };
		const live = manager.getEntry(entry.id);
		if (live?.type !== "message" || live.message.role !== "user") throw new Error("unexpected live entry");
		expect(live.message.content).toBe("snapshot me");
	});
});
