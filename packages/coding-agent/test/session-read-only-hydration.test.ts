import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type {
	CompactionEntry,
	FileEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	loadSessionMessagesReadOnly,
	resolveBlobRefsInEntries,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

const timestamp = new Date(0).toISOString();
const header = { type: "session", version: 3, id: "session", timestamp, cwd: "/tmp" };

function imageEntry(id: string, parentId: string | null, data: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: [{ type: "image", data, mimeType: "image/png" }], timestamp: 0 },
	};
}

describe("read-only session blob hydration", () => {
	it("reads only retained branch images after a clear boundary and preserves URL and missing-blob fallbacks", async () => {
		using dir = TempDir.createSync("@read-only-hydration-");
		const store = new BlobStore(path.join(dir.path(), "blobs"));
		const discarded = await store.put(Buffer.from("discarded"));
		const retained = await store.put(Buffer.from("retained"));
		const dataUrl = "data:image/png;base64,aW1hZ2U=";
		const url = await store.put(Buffer.from(dataUrl));
		const missing = `blob:sha256:${"0".repeat(64)}`;
		const visible = imageEntry("visible", "reset", retained.ref);
		if (visible.message.role !== "user") throw new Error("Expected user fixture");
		visible.message.providerPayload = {
			type: "openaiResponsesHistory",
			provider: "openai",
			items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: url.ref }] }],
		};
		const entries: FileEntry[] = [
			imageEntry("old", null, discarded.ref),
			{ type: "reset_boundary", id: "reset", parentId: "old", timestamp },
			imageEntry("sibling", "reset", discarded.ref),
			visible,
			imageEntry("missing", "visible", missing),
		];
		const file = path.join(dir.path(), "session.jsonl");
		await Bun.write(file, [header, ...entries].map(value => JSON.stringify(value)).join("\n"));
		const get = store.get.bind(store);
		const reads: string[] = [];
		const readSpy = spyOn(BlobStore.prototype, "get").mockImplementation(async hash => {
			reads.push(hash);
			return get(hash);
		});
		try {
			const messages = await loadSessionMessagesReadOnly(file);
			expect(reads).not.toContain(discarded.hash);
			expect(reads.toSorted()).toEqual([retained.hash, url.hash, "0".repeat(64)].toSorted());
			expect(messages).toHaveLength(2);
			expect(messages[0]).toMatchObject({
				content: [{ type: "image", data: Buffer.from("retained").toString("base64") }],
				providerPayload: { items: [{ content: [{ image_url: dataUrl }] }] },
			});
			expect(messages[1]).toMatchObject({ content: [{ type: "image", data: missing }] });
		} finally {
			readSpy.mockRestore();
		}
	});

	it("does not read compacted-away images or archived frames in a collapsed transcript", async () => {
		using dir = TempDir.createSync("@read-only-compaction-");
		const store = new BlobStore(path.join(dir.path(), "blobs"));
		const discarded = await store.put(Buffer.from("archived"));
		const compaction: CompactionEntry = {
			type: "compaction",
			id: "compact",
			parentId: "keep",
			timestamp,
			firstKeptEntryId: "keep",
			summary: "summary",
			tokensBefore: 1000,
			preserveData: {
				[snapcompact.PRESERVE_KEY]: {
					frames: [{ data: discarded.ref, mimeType: "image/png", cols: 1, rows: 1, chars: 1 }],
					totalChars: 1,
					truncatedChars: 0,
					text: "archived source",
				},
			},
		};
		const file = path.join(dir.path(), "session.jsonl");
		await Bun.write(
			file,
			[
				header,
				imageEntry("old", null, discarded.ref),
				{
					type: "message",
					id: "keep",
					parentId: "old",
					timestamp,
					message: { role: "user", content: "keep", timestamp: 0 },
				},
				compaction,
			]
				.map(value => JSON.stringify(value))
				.join("\n"),
		);
		const get = store.get.bind(store);
		const reads: string[] = [];
		const readSpy = spyOn(BlobStore.prototype, "get").mockImplementation(async hash => {
			reads.push(hash);
			return get(hash);
		});
		try {
			const messages = await loadSessionMessagesReadOnly(file);
			expect(reads).toEqual([]);
			expect(messages).toHaveLength(2);
			expect(messages[0]).toMatchObject({ role: "user", content: "keep" });
			expect(messages[1]).toMatchObject({ role: "compactionSummary", summary: "summary" });
		} finally {
			readSpy.mockRestore();
		}
	});

	it("bounds simultaneous blob reads inside one large frame archive", async () => {
		using dir = TempDir.createSync("@archive-hydration-limit-");
		const store = new BlobStore(path.join(dir.path(), "blobs"));
		const blob = await store.put(Buffer.from("frame"));
		const archive: snapcompact.Archive = {
			frames: Array.from({ length: 48 }, () => ({
				data: blob.ref,
				mimeType: "image/png",
				cols: 1,
				rows: 1,
				chars: 1,
			})),
			totalChars: 48,
			truncatedChars: 0,
		};
		const entry: CompactionEntry = {
			type: "compaction",
			id: "compact",
			parentId: null,
			timestamp,
			firstKeptEntryId: "none",
			summary: "summary",
			tokensBefore: 1000,
			preserveData: { [snapcompact.PRESERVE_KEY]: archive },
		};
		const get = store.get.bind(store);
		let active = 0;
		let peak = 0;
		const readSpy = spyOn(store, "get").mockImplementation(async hash => {
			active++;
			peak = Math.max(peak, active);
			try {
				await Bun.sleep(1);
				return await get(hash);
			} finally {
				active--;
			}
		});
		try {
			await resolveBlobRefsInEntries([entry], store);
			expect(peak).toBeLessThanOrEqual(8);
			expect(archive.frames.map(frame => frame.data)).toEqual(
				Array(48).fill(Buffer.from("frame").toString("base64")),
			);
		} finally {
			readSpy.mockRestore();
		}
	});
});
