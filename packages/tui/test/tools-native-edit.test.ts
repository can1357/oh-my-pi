import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { pathToFileURL } from "node:url";
import type { NativeChild, NativeNode } from "../src/native/node";
import { editToolRenderer } from "../src/tools/edit";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { getThemeByName, initTheme, type Theme } from "../src/theme";
import type { FileDiagnosticsResult } from "../src/tools/lsp";
import { diagnosticsSection } from "../src/tools/native-view";
import type { RenderResultOptions } from "../src/tools/renderer";

const done: RenderResultOptions = { expanded: false, isPartial: false };
let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme missing");
	uiTheme = theme;
});

afterEach(() => applyHyperlinkSetting("auto"));

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
		// Each diff names its own file, which Tern picks the grammar from.
		const files = sections.map(section => {
			const diffs = collect(section.c, "diff");
			expect(diffs).toHaveLength(1);
			expect(prop(diffs[0]!, "lang")).toBeUndefined();
			return prop(diffs[0]!, "path");
		});
		expect(files).toEqual(["/tmp/a.ts", "/tmp/b.py"]);
		const heads = sections.map(section => spanText(section, "head"));
		expect(heads[0]).toContain("a.ts");
		expect(heads[0]).toContain("+2");
		expect(heads[1]).toContain("b.py");
		expect(heads[1]).toContain("−1");
	});

	it("uses the original path as the native href while sanitizing the displayed edit path", () => {
		const rawPath = "/tmp/edit-\x1b[31mfile\x01.ts";
		const safePath = "/tmp/edit-file.ts";
		const view = editToolRenderer.describeResult(
			{ content: [{ type: "text", text: "ok" }], details: { path: safePath, diff: "-old\n+new" } },
			{ ...done, renderContext: { rawDetails: { path: rawPath, diff: "-old\n+new" } } },
			{ path: rawPath },
		);
		if (!view.tool) throw new Error("Expected edit tool head");
		expect(view.tool.href).toBe(pathToFileURL(rawPath).href);
		expect(view.tool.target).toContain("edit-file.ts");
		expect(view.tool.target).not.toContain("\x1b[31m");
		expect(view.tool.target).not.toContain("\x01");
	});

	it("keeps aligned raw per-file paths out of multi-file native section labels", () => {
		const rawPath = "/tmp/edit-\x1b[31mfile\x01.ts";
		const view = editToolRenderer.describeResult(
			{
				content: [],
				details: {
					diff: "",
					perFileResults: [
						{ path: "/tmp/edit-file.ts", diff: "+new" },
						{ path: "/tmp/other.ts", diff: "+other" },
					],
				},
			},
			{
				...done,
				renderContext: {
					rawDetails: {
						perFileResults: [
							{ path: rawPath, diff: "+new" },
							{ path: "/tmp/other.ts", diff: "+other" },
						],
					},
				},
			},
		);
		const sections = (view.body ?? []).filter(isNode).filter(child => child.k === "section");
		expect(spanText(sections[0]!, "head")).toContain("edit-file.ts");
		expect(spanText(sections[0]!, "head")).not.toContain("\x1b[31m");
		expect(spanText(sections[0]!, "head")).not.toContain("\x01");
	});

	it("links original source and destination paths for ANSI renames without exposing control bytes", () => {
		applyHyperlinkSetting("always");
		const sourcePath = "/tmp/source-\x1b[31mfile\x01.ts";
		const destinationPath = "/tmp/destination-\x1b[31mfile\x01.ts";
		const rendered = editToolRenderer
			.renderResult(
				{
					content: [],
					details: {
						path: "/tmp/destination-file.ts",
						sourcePath: "/tmp/source-file.ts",
						diff: "",
						op: "update",
						move: "/tmp/destination-file.ts",
					},
				},
				{
					...done,
					renderContext: {
						rawDetails: { path: destinationPath, sourcePath, diff: "", op: "update", move: destinationPath },
					},
				},
				uiTheme,
			)
			.render(160)
			.join("\n");
		const links = [...rendered.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]);
		expect(links).toEqual([pathToFileURL(sourcePath).href, pathToFileURL(destinationPath).href]);
		expect(Bun.stripANSI(rendered)).toContain("source-file.ts");
		expect(Bun.stripANSI(rendered)).toContain("destination-file.ts");
		expect(rendered).not.toContain("\x1b[31m");
		expect(rendered).not.toContain("\x01");
	});

	it("links the original per-file path in ANSI multi-file results", () => {
		applyHyperlinkSetting("always");
		const rawPath = "/tmp/edit-\x1b[31mfile\x01.ts";
		const rendered = editToolRenderer
			.renderResult(
				{
					content: [],
					details: {
						diff: "",
						perFileResults: [
							{ path: "/tmp/edit-file.ts", diff: "-before\n+after" },
							{ path: "/tmp/other.ts", diff: "-old\n+new" },
						],
					},
				},
				{
					...done,
					renderContext: { rawDetails: { perFileResults: [{ path: rawPath }, { path: "/tmp/other.ts" }] } },
				},
				uiTheme,
			)
			.render(160)
			.join("\n");
		const links = [...rendered.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]);
		expect(links).toContain(pathToFileURL(rawPath).href);
		expect(Bun.stripANSI(rendered)).toContain("edit-file.ts");
		expect(rendered).not.toContain("\x1b[31m");
		expect(rendered).not.toContain("\x01");
	});

	it("keeps a delete linked to its original path after sanitizing the label", () => {
		applyHyperlinkSetting("always");
		const rawPath = "/tmp/deleted-\x1b[31mfile\x01.ts";
		const result = { content: [], details: { path: "/tmp/deleted-file.ts", diff: "", op: "delete" as const } };
		const options = { ...done, renderContext: { rawDetails: { path: rawPath, diff: "", op: "delete" } } };
		const view = editToolRenderer.describeResult(result, options);
		if (!view.tool) throw new Error("Expected edit tool head");
		expect(view.tool.href).toBe(pathToFileURL(rawPath).href);
		const rendered = editToolRenderer.renderResult(result, options, uiTheme).render(160).join("\n");
		const links = [...rendered.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]);
		expect(links).toEqual([pathToFileURL(rawPath).href]);
		expect(Bun.stripANSI(rendered)).toContain("deleted-file.ts");
		expect(rendered).not.toContain("\x1b[31m");
		expect(rendered).not.toContain("\x01");
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
