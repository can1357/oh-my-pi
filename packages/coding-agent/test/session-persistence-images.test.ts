import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type {
	CompactionEntry,
	FileEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveBlobRefsInEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Archive } from "@oh-my-pi/snapcompact";
import * as snapcompact from "@oh-my-pi/snapcompact";

type ImagePayload = { data: string; mimeType: string; type?: "image" };
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type ToolResultEntry = Omit<SessionMessageEntry, "message"> & { message: ToolResultMessage };

const text = (value: string): TextContent => ({ type: "text", text: value });
const png = (data: string): ImageContent => ({ type: "image", data, mimeType: "image/png" });
const payload = (data: string): ImagePayload => ({ data, mimeType: "image/png" });

function messageEntry(message: ToolResultMessage): ToolResultEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message,
	};
}

describe("session image persistence", () => {
	it("externalizes and resolves content images and tool detail image payloads", async () => {
		using tempDir = TempDir.createSync("@session-image-persistence-");
		const blobStore = new BlobStore(tempDir.path());
		const contentImageData = Buffer.alloc(1500, 1).toString("base64");
		const generatedImageData = Buffer.alloc(1500, 2).toString("base64");
		const typedDetailImageData = Buffer.alloc(1500, 3).toString("base64");

		const original = messageEntry({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "generate_image",
			content: [text("generated"), png(contentImageData)],
			details: {
				images: [payload(generatedImageData), png(typedDetailImageData)],
			},
			isError: false,
			timestamp: Date.now(),
		});

		const persisted = prepareEntryForPersistence(original, blobStore) as ToolResultEntry;
		const persistedContentImage = persisted.message.content.find(
			(block): block is ImageContent => block.type === "image",
		);
		const persistedDetails = persisted.message.details as { images: ImagePayload[] };

		expect(persistedContentImage).toBeDefined();
		expect(isBlobRef(persistedContentImage?.data ?? "")).toBe(true);
		expect(persistedDetails.images).toHaveLength(2);
		expect(persistedDetails.images.every(image => isBlobRef(image.data))).toBe(true);

		const loaded: FileEntry[] = [structuredClone(persisted)];
		await resolveBlobRefsInEntries(loaded, blobStore);
		const resolved = loaded[0] as ToolResultEntry;
		const resolvedContentImage = resolved.message.content.find(
			(block): block is ImageContent => block.type === "image",
		);
		const resolvedDetails = resolved.message.details as { images: ImagePayload[] };

		expect(resolvedContentImage?.data).toBe(contentImageData);
		expect(resolvedDetails.images[0]?.data).toBe(generatedImageData);
		expect(resolvedDetails.images[1]?.data).toBe(typedDetailImageData);
	});

	it("externalizes and restores native Responses images in assistant content and provider history", async () => {
		using tempDir = TempDir.createSync("@session-native-image-persistence-");
		const blobStore = new BlobStore(tempDir.path());
		const data = Buffer.alloc(1500, 4).toString("base64");
		const original: SessionMessageEntry = {
			type: "message",
			id: "entry-native-image",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [png(data)],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-image-test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: "openai",
					items: [{ type: "image_generation_call", id: "ig_1", status: "completed", result: data }],
				},
				timestamp: Date.now(),
			},
		};

		const persisted = prepareEntryForPersistence(original, blobStore);
		if (persisted.type !== "message" || persisted.message.role !== "assistant") {
			throw new Error("expected persisted assistant message");
		}
		const persistedImage = persisted.message.content.find(block => block.type === "image");
		const persistedPayload = persisted.message.providerPayload;
		if (persistedPayload?.type !== "openaiResponsesHistory") {
			throw new Error("expected persisted Responses history");
		}
		const persistedItem = persistedPayload.items[0];
		if (!persistedItem || typeof persistedItem.result !== "string") {
			throw new Error("expected persisted image generation item");
		}
		expect(isBlobRef(persistedImage?.data ?? "")).toBe(true);
		expect(isBlobRef(persistedItem.result)).toBe(true);

		const loaded: FileEntry[] = [structuredClone(persisted)];
		await resolveBlobRefsInEntries(loaded, blobStore);
		const resolved = loaded[0];
		if (resolved?.type !== "message" || resolved.message.role !== "assistant") {
			throw new Error("expected resolved assistant message");
		}
		const resolvedImage = resolved.message.content.find(block => block.type === "image");
		const resolvedPayload = resolved.message.providerPayload;
		if (resolvedPayload?.type !== "openaiResponsesHistory") {
			throw new Error("expected resolved Responses history");
		}
		const resolvedItem = resolvedPayload.items[0];
		expect(resolvedImage?.data).toBe(data);
		expect(resolvedItem?.result).toBe(data);
	});

	it("skips the async resolver for entries without blob refs while still resolving blob-ref entries", async () => {
		using tempDir = TempDir.createSync("@session-blob-precheck-");
		const blobStore = new BlobStore(tempDir.path());
		let getCalls = 0;
		const origGet = blobStore.get.bind(blobStore);
		blobStore.get = async (hash: string) => {
			getCalls++;
			return origGet(hash);
		};

		const imageData = Buffer.alloc(1500, 7).toString("base64");
		const withImage = messageEntry({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [png(imageData)],
			isError: false,
			timestamp: 0,
		} as unknown as ToolResultMessage);
		const persistedWithImage = prepareEntryForPersistence(withImage, blobStore);

		const textOnly: FileEntry[] = Array.from({ length: 50 }, (_, i) => ({
			type: "message",
			id: `text-${i}`,
			parentId: i === 0 ? null : `text-${i - 1}`,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: [text(`plain body ${i}`)], timestamp: 0 },
		})) as unknown as FileEntry[];

		const loaded: FileEntry[] = [
			...textOnly.map(entry => structuredClone(entry)),
			structuredClone(persistedWithImage),
		];
		await resolveBlobRefsInEntries(loaded, blobStore);

		// The blob-ref entry resolves through BlobStore.get exactly once; the 50 text entries never touch it.
		expect(getCalls).toBe(1);
		const resolved = loaded[loaded.length - 1] as ToolResultEntry;
		const resolvedImage = resolved.message.content.find((block): block is ImageContent => block.type === "image");
		expect(resolvedImage?.data).toBe(imageData);
	});
});

/** Strict base64 the way a provider's decoder validates it: only the base64
 *  alphabet, canonical padding, length a multiple of 4. Buffer.from is lenient
 *  and would silently accept the corrupted payload this test guards against. */
function isStrictBase64(data: string): boolean {
	return /^[A-Za-z0-9+/]*={0,2}$/.test(data) && data.length % 4 === 0;
}

describe("snapcompact frame persistence", () => {
	it("externalizes oversized frame base64 to the blob store instead of truncating it", async () => {
		using tempDir = TempDir.createSync("@snapcompact-frame-persistence-");
		const blobStore = new BlobStore(tempDir.path());
		// 400k bytes -> ~533k base64 chars, comfortably past the 500k persist cap
		// that previously truncated the frame and appended the notice.
		const frameData = Buffer.alloc(400_000, 7).toString("base64");
		expect(isStrictBase64(frameData)).toBe(true);
		expect(frameData.length).toBeGreaterThan(500_000);

		const archive: Archive = {
			frames: [{ data: frameData, mimeType: "image/png", cols: 100, rows: 100, chars: 5000 }],
			totalChars: 5000,
			truncatedChars: 0,
			text: "archived source text",
		};
		const entry: CompactionEntry = {
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "summary",
			firstKeptEntryId: "entry-1",
			tokensBefore: 5000,
			preserveData: { [snapcompact.PRESERVE_KEY]: archive },
		};

		const persisted = prepareEntryForPersistence(entry, blobStore) as CompactionEntry;
		const persistedArchive = persisted.preserveData![snapcompact.PRESERVE_KEY] as Archive;
		expect(isBlobRef(persistedArchive.frames[0]!.data)).toBe(true);
		expect(persistedArchive.frames[0]!.data).not.toContain("[Session persistence truncated large content]");

		const loaded: CompactionEntry[] = [structuredClone(persisted)];
		await resolveBlobRefsInEntries(loaded, blobStore);
		const loadedArchive = snapcompact.getPreservedArchive(loaded[0]!.preserveData)!;
		expect(loadedArchive.frames[0]!.data).toBe(frameData);

		const blocks = snapcompact.historyBlocks(loadedArchive, {
			maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET,
		});
		const imageBlocks = blocks.filter((block): block is ImageContent => block.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks.every(block => isStrictBase64(block.data))).toBe(true);
	});

	it("recovers frames corrupted by older persistence versions as retained source text", async () => {
		using tempDir = TempDir.createSync("@snapcompact-frame-recovery-");
		const blobStore = new BlobStore(tempDir.path());
		const sourceText = "complete normalized archived source";
		const corruptedData = `${Buffer.alloc(400_000, 7).toString("base64").slice(0, 499_953)}\n\n[Session persistence truncated large content]`;
		const entry: CompactionEntry = {
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "summary",
			firstKeptEntryId: "entry-1",
			tokensBefore: 5000,
			preserveData: {
				[snapcompact.PRESERVE_KEY]: {
					frames: [{ data: corruptedData, mimeType: "image/png", cols: 100, rows: 100, chars: 5000 }],
					totalChars: 5000,
					truncatedChars: 0,
					text: sourceText,
				} satisfies Archive,
			},
		};

		await resolveBlobRefsInEntries([entry], blobStore);
		const recovered = snapcompact.getPreservedArchive(entry.preserveData)!;
		const blocks = snapcompact.historyBlocks(recovered, {
			maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET,
		});
		expect(blocks).toEqual([{ type: "text", text: sourceText }]);
	});
});
