import { describe, expect, it } from "bun:test";
import type { NativeChild, NativeNode } from "../src/native/node";
import { editToolRenderer } from "../src/tools/edit";
import { grepToolRenderer } from "../src/tools/grep";
import { readToolRenderer } from "../src/tools/read";
import { getNativeBlob } from "../src/native/blobs";
import type { RenderResultOptions } from "../src/tools/renderer";

const done: RenderResultOptions = { expanded: false, isPartial: false };

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function collect(children: readonly NativeChild[] | undefined, kind: string): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of children ?? []) {
		if (!isNode(child)) continue;
		if (child.k === kind) out.push(child);
		out.push(...collect(child.c, kind));
	}
	return out;
}

describe("core tool native views", () => {
	it("describes an edit result as a path-headed tool over a headerless diff", () => {
		const compactDiff = " 4|keep\n-5|old\n+5|new";
		const view = editToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: { diff: compactDiff, path: "/tmp/a.ts", firstChangedLine: 5 },
			},
			done,
			{ path: "src/a.ts" },
		);
		expect(view.tool).toMatchObject({ title: "Edit", target: "src/a.ts:5", targetKind: "path", meta: ["+1 −1"] });
		expect(view.head).toBeUndefined();
		const diffs = collect(view.body, "diff");
		expect(diffs).toHaveLength(1);
		const props = diffs[0]!.p as {
			hunks?: { oldStart: number; newStart: number; lines: string[] }[];
			path?: string;
			lang?: string;
		};
		expect(props.path).toBeUndefined();
		expect(props.lang).toBe("typescript");
		expect(props.hunks?.[0]?.oldStart).toBe(4);
		expect(props.hunks?.[0]?.newStart).toBe(4);
		expect(props.hunks?.[0]?.lines.map(line => line[0])).toEqual([" ", "-", "+"]);
		expect(view.tone).toBeUndefined();
	});

	it("describes an image read as an image node backed by a registered blob", () => {
		// 1×1 transparent PNG.
		const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
		const view = readToolRenderer.describeResult(
			{ content: [{ type: "image", data, mimeType: "image/png" } as { type: string; text?: string }] },
			done,
			{ path: "shots/a.png" },
		);
		const images = collect(view.body, "image");
		expect(images).toHaveLength(1);
		const props = images[0]!.p as { blob: string; alt?: string; w?: number; h?: number };
		expect(getNativeBlob(props.blob)?.mime).toBe("image/png");
		expect(props.alt).toContain("a.png");
		expect([props.w, props.h]).toEqual([1, 1]);
	});

	it("keeps grep hit line numbers and marks match lines", () => {
		const display = ["# src/a.ts", " 9│ctx", "*10│hit here", " 11│after", "", "*40│far hit"].join("\n");
		const view = grepToolRenderer.describeResult(
			{
				content: [{ type: "text", text: display }],
				details: { matchCount: 2, fileCount: 1, displayContent: display },
			},
			done,
			{ pattern: "hit" },
		);
		const blocks = collect(view.body, "code").map(
			n => n.p as { start?: number; text?: string; marks?: { line: number }[] },
		);
		expect(blocks.map(b => b.start)).toEqual([9, 40]);
		expect(blocks[0]!.text).toBe("ctx\nhit here\nafter");
		expect(blocks.flatMap(b => (b.marks ?? []).map(m => m.line))).toEqual([10, 40]);
	});
});
