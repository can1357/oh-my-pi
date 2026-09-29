import { describe, expect, it } from "bun:test";
import type { NativeChild, NativeNode } from "../src/native/node";
import { editToolRenderer } from "../src/tools/edit";
import type { FileDiagnosticsResult } from "../src/tools/lsp";
import { diagnosticsSection } from "../src/tools/native-view";
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

/** A node prop by name (props are a per-kind union). */
function prop(node: NativeNode, key: string): unknown {
	return node.p && key in node.p ? Reflect.get(node.p, key) : undefined;
}

/** The joined text of a span-list prop (`spans`, `head`). */
function spanText(node: NativeNode, key: "spans" | "head"): string {
	const spans = prop(node, key);
	return Array.isArray(spans) ? spans.map(span => String(span.t)).join("") : "";
}

describe("edit native views", () => {
	it("heads a multi-file edit by file count and gives each file one section with one diff, never a card", () => {
		const view = editToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					diff: "",
					perFileResults: [
						{ path: "/tmp/a.ts", diff: " 1|keep\n-2|old\n+2|new\n+3|more" },
						{ path: "/tmp/b.py", diff: "-7|gone" },
					],
				},
			},
			done,
			{ edits: [{ path: "/tmp/a.ts" }, { path: "/tmp/b.py" }] },
		);
		expect(view.tool).toMatchObject({ title: "Edit", target: "2 files", targetKind: "text", meta: ["+2 −2"] });
		expect(collect(view.body, "card")).toHaveLength(0);
		const sections = (view.body ?? []).filter(isNode).filter(child => child.k === "section");
		expect(sections).toHaveLength(2);
		for (const section of sections) {
			const diffs = collect(section.c, "diff");
			expect(diffs).toHaveLength(1);
			expect(prop(diffs[0]!, "path")).toBeUndefined();
		}
		const heads = sections.map(section => spanText(section, "head"));
		expect(heads[0]).toContain("a.ts");
		expect(heads[0]).toContain("+2");
		expect(heads[1]).toContain("b.py");
		expect(heads[1]).toContain("−1");
	});

	it("caps diagnostics at five rows, most severe first, with a +N more line", () => {
		const messages = [
			...Array.from({ length: 5 }, (_, i) => `src/a.ts:${i + 10}:1 [warning] unused ${i}`),
			"src/a.ts:40:3 [error] [ts] Type mismatch (2322)",
			"src/a.ts:2:1 [info] note",
		];
		const diagnostics: FileDiagnosticsResult = { messages, summary: "1 error(s), 5 warning(s)", errored: true };
		const children = (diagnosticsSection(diagnostics)?.c ?? []).filter(isNode);
		const rows = children.filter(child => prop(child, "role") === "omp.tool.diagnostic");
		expect(rows).toHaveLength(5);
		expect(collect(rows[0]!.c, "icon")[0]!.p).toMatchObject({ name: "x-circle", tone: "error" });
		expect(collect(rows[0]!.c, "text").map(t => spanText(t, "spans"))).toEqual(["40:3", "Type mismatch ts 2322"]);
		expect(spanText(children.at(-1)!, "spans")).toBe("+2 more");
	});
});
