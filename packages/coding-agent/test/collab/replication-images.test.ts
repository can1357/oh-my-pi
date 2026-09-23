/**
 * Contract for `placeholdImagesForReplication` (issue #9469): every image a
 * snapshot sheds is listed in `collabElided` with a path that resolves to the
 * original image in the host's entry, so a guest can fetch it. Among text the
 * image becomes a text block at the same position (indices keep lining up);
 * image-only arrays, which renderers draw element by element as images, lose
 * the element and the record says `removed: true` with the original index.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { placeholdImagesForReplication } from "@oh-my-pi/pi-coding-agent/collab/replication-images";
import type { ReplicatedEntry } from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import { expectFetchable, valueAtPath } from "./helpers/collab-elided";
import { buildTailFixture, type TailFixture } from "./helpers/tail-fixture";

const IMAGE: ImageContent = { type: "image", data: "iVBORw0KGgo=".repeat(100), mimeType: "image/jpeg" };

const FILE_MENTION: ReplicatedEntry = {
	type: "message",
	id: "mention",
	parentId: null,
	timestamp: "2026-09-24T00:00:00Z",
	message: {
		role: "fileMention",
		files: [
			{ path: "notes.md", content: "notes" },
			{ path: "shot.jpg", content: "", image: IMAGE },
		],
		timestamp: 0,
	},
} as unknown as ReplicatedEntry;

const CUSTOM_MESSAGE: ReplicatedEntry = {
	type: "custom_message",
	id: "custom",
	parentId: null,
	timestamp: "2026-09-24T00:00:00Z",
	customType: "collab-prompt",
	display: true,
	content: [{ type: "text", text: "look" }, IMAGE, { type: "text", text: "after" }],
};

describe("placeholdImagesForReplication (#9469)", () => {
	let fixture: TailFixture;
	beforeAll(() => {
		fixture = buildTailFixture();
	});

	const inPlaceCases: { name: string; entry: () => ReplicatedEntry; path: (string | number)[]; mimeType: string }[] = [
		{
			name: "user content",
			entry: () => fixture.sessionManager.getEntry(fixture.ids.userImage) as ReplicatedEntry,
			path: ["message", "content", 1],
			mimeType: "image/png",
		},
		{
			name: "tool-result content",
			entry: () => fixture.sessionManager.getEntry(fixture.ids.toolImage) as ReplicatedEntry,
			path: ["message", "content", 1],
			mimeType: "image/png",
		},
		{
			name: "file-mention image",
			entry: () => FILE_MENTION,
			path: ["message", "files", 1, "image"],
			mimeType: "image/jpeg",
		},
		{
			name: "custom_message content",
			entry: () => CUSTOM_MESSAGE,
			path: ["content", 1],
			mimeType: "image/jpeg",
		},
	];

	for (const { name, entry, path, mimeType } of inPlaceCases) {
		it(`replaces the ${name} image in place with a fetchable record`, () => {
			const original = entry();
			const copy = structuredClone(original);
			expect(placeholdImagesForReplication(copy)).toBe(1);

			// Same position, same container size: later indices still line up.
			const container = path.slice(0, -1);
			expect(JSON.stringify(Object.keys(valueAtPath(copy, container) as object))).toBe(
				JSON.stringify(Object.keys(valueAtPath(original, container) as object)),
			);
			expect(valueAtPath(copy, path)).toEqual({
				type: "text",
				text: expect.stringMatching(new RegExp(`^\\[image ${mimeType.replace("/", "\\/")}, .+ not sent\\]$`)),
			});

			expect(copy.collabElided?.map(r => [r.kind, r.path, r.mimeType, r.removed])).toEqual([
				["image", path, mimeType, undefined],
			]);
			const [record] = copy.collabElided ?? [];
			if (!record) throw new Error("expected an image record");
			expect(expectFetchable(original, record)).toMatchObject({ type: "image", mimeType });
		});
	}

	const removedCases: { name: string; entry: () => ReplicatedEntry; path: (string | number)[] }[] = [
		{
			name: "tool-result details.images",
			entry: () => fixture.sessionManager.getEntry(fixture.ids.detailsImage) as ReplicatedEntry,
			path: ["message", "details", "images", 0],
		},
		{
			name: "manual bash images",
			entry: () => fixture.sessionManager.getEntry(fixture.ids.bashImage) as ReplicatedEntry,
			path: ["message", "images", 0],
		},
	];

	for (const { name, entry, path } of removedCases) {
		it(`removes the ${name} image and records it as removed`, () => {
			const original = entry();
			const copy = structuredClone(original);
			expect(placeholdImagesForReplication(copy)).toBe(1);

			// No text block where a renderer expects image data: the array shrank.
			const container = path.slice(0, -1);
			expect(valueAtPath(copy, container)).toEqual([]);
			expect(valueAtPath(original, container)).toHaveLength(1);

			expect(copy.collabElided?.map(r => [r.kind, r.path, r.mimeType, r.removed])).toEqual([
				["image", path, "image/png", true],
			]);
			const [record] = copy.collabElided ?? [];
			if (!record) throw new Error("expected an image record");
			expect(expectFetchable(original, record)).toMatchObject({ type: "image", mimeType: "image/png" });
		});
	}

	it("records removed images at their original indices, keeping other elements", () => {
		const other = { type: "chart", title: "not an image" };
		const original = {
			type: "message",
			id: "details",
			parentId: null,
			timestamp: "2026-09-24T00:00:00Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "eval",
				content: [{ type: "text", text: "two figures" }],
				details: { images: [IMAGE, other, { ...IMAGE, mimeType: "image/png" }] },
				isError: false,
				timestamp: 0,
			},
		} as unknown as ReplicatedEntry;
		const copy = structuredClone(original);
		expect(placeholdImagesForReplication(copy)).toBe(2);
		expect(valueAtPath(copy, ["message", "details", "images"])).toEqual([other]);
		const records = copy.collabElided ?? [];
		expect(records.map(r => [r.path, r.mimeType, r.removed])).toEqual([
			[["message", "details", "images", 0], "image/jpeg", true],
			[["message", "details", "images", 2], "image/png", true],
		]);
		for (const record of records) expectFetchable(original, record);
	});
});
