import { describe, expect, it } from "bun:test";
import type { CollabElided, SessionEntry } from "@oh-my-pi/pi-wire";
import { applyElidedValue } from "../src/lib/elided";

const record = (path: (string | number)[], kind: CollabElided["kind"], removed?: true): CollabElided => ({
	path,
	kind,
	bytes: 1,
	hash: JSON.stringify(path),
	...(removed ? { removed } : {}),
});

function toolResult(details: unknown, collabElided: CollabElided[], texts: string[] = ["ok"]): SessionEntry {
	return {
		type: "message",
		id: "r1",
		parentId: null,
		timestamp: "2026-09-24T00:00:02Z",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "eval",
			content: texts.map(text => ({ type: "text" as const, text })),
			details,
			isError: false,
			timestamp: 2,
		},
		collabElided,
	};
}

describe("applyElidedValue", () => {
	it("restores removed images at their original indices in any load order", () => {
		const a = { type: "image", mimeType: "image/png", data: "AAAA" };
		const b = { type: "image", mimeType: "image/png", data: "BBBB" };
		const note = { type: "text", text: "legend", caption: "full caption" };
		const removedA = record(["message", "details", "images", 0], "image", true);
		const removedB = record(["message", "details", "images", 2], "image", true);
		// The caption's path counts the removed image before it.
		const caption = record(["message", "details", "images", 1, "caption"], "string");
		const held = toolResult({ images: [{ ...note, caption: "full…[clipped]" }] }, [removedA, removedB, caption]);
		const images = (entry: SessionEntry) =>
			entry.type === "message" && entry.message.role === "toolResult"
				? (entry.message.details as { images: unknown[] }).images
				: undefined;

		let later = applyElidedValue(held, removedB, b);
		later = applyElidedValue(later, caption, "full caption");
		later = applyElidedValue(later, removedA, a);
		let earlier = applyElidedValue(held, removedA, a);
		earlier = applyElidedValue(earlier, caption, "full caption");
		earlier = applyElidedValue(earlier, removedB, b);

		expect(images(later)).toEqual([a, note, b]);
		expect(images(earlier)).toEqual([a, note, b]);
		expect(later.collabElided).toBeUndefined();
		expect(images(held)).toEqual([{ ...note, caption: "full…[clipped]" }]);
	});

	it("drops the records a loaded original covers", () => {
		const clipped = record(["message", "content", 1, "text"], "string");
		const array = record(["message", "content"], "array");
		const held = toolResult(undefined, [clipped, array], ["head", "clip…", "…[3 items elided for collab session]"]);

		expect(applyElidedValue(held, clipped, "the whole second block").collabElided).toEqual([array]);
		const full = [1, 2, 3, 4].map(n => ({ type: "text" as const, text: `block ${n}` }));
		const all = applyElidedValue(held, array, full);
		expect(all.type === "message" && all.message.content).toEqual(full);
		expect(all.collabElided).toBeUndefined();
	});
});
