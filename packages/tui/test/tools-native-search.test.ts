import { beforeAll, describe, expect, it } from "bun:test";
import type { TspText } from "@oh-my-pi/pi-wire";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { initTheme } from "../src/theme";
import { globToolRenderer } from "../src/tools/glob";
import { grepToolRenderer } from "../src/tools/grep";
import { lspToolRenderer } from "../src/tools/lsp";
import { readToolRenderer } from "../src/tools/read";
import type { RenderResultOptions } from "../src/tools/renderer";

const collapsed: RenderResultOptions = { expanded: false, isPartial: false };
const expanded: RenderResultOptions = { expanded: true, isPartial: false };
const toolCx: DescribeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: kind => kind === "tool",
	feature: () => true,
};

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function collect(children: readonly NativeChild[] | undefined, match: (node: NativeNode) => boolean): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of children ?? []) {
		if (!isNode(child)) continue;
		if (match(child)) out.push(child);
		out.push(...collect(child.c, match));
	}
	return out;
}

function role(node: NativeNode): string | undefined {
	return node.p?.role;
}

function plain(text: TspText | undefined): string {
	return typeof text === "string" ? text : (text ?? []).map(s => s.t).join("");
}

function codeProps(children: readonly NativeChild[] | undefined): { start?: number; text?: string }[] {
	return collect(children, n => n.k === "code").flatMap(n => (n.k === "code" && n.p ? [n.p] : []));
}

function codeStarts(children: readonly NativeChild[] | undefined): (number | undefined)[] {
	return codeProps(children).map(p => p.start);
}

describe("grep native view", () => {
	const display = [
		"# src/",
		"## a.ts",
		" 9│ctx",
		"*10│hit",
		"   │...",
		"*40│far",
		"",
		"## b.ts",
		"*1│x",
		"",
		"## c.ts",
		"*2│y",
	].join("\n");
	const result = {
		content: [{ type: "text", text: display }],
		details: { matchCount: 4, fileCount: 3, displayContent: display },
	};

	it("shows the first two files while collapsed and every file expanded", () => {
		const small = grepToolRenderer.describeResult(result, collapsed, { pattern: "hit" });
		const full = grepToolRenderer.describeResult(result, expanded, { pattern: "hit" });
		const files = (view: typeof small) => collect(view.body, n => role(n) === "omp.tool.search.file");
		expect(files(small)).toHaveLength(2);
		expect(files(full)).toHaveLength(3);
		expect(small.inline).toBe(true);
	});

	it("splits non-adjacent match lines into numbered runs with a gap row between", () => {
		const view = grepToolRenderer.describeResult(result, expanded, { pattern: "hit" });
		const first = collect(view.body, n => role(n) === "omp.tool.search.file")[0]!;
		expect(codeStarts(first.c)).toEqual([9, 40]);
		const kinds = (first.c ?? []).filter(isNode).map(n => n.k);
		expect(kinds).toEqual(["row", "code", "text", "code"]);
	});
});

describe("read native view", () => {
	it("numbers a legacy result (no displayContent) from the selector's range start", () => {
		const view = readToolRenderer.describeResult({ content: [{ type: "text", text: "a\nb" }] }, collapsed, {
			path: "src/x.ts:13-36",
		});
		expect(codeStarts(view.body)).toEqual([13]);
		expect(view.tool?.target).toBe("src/x.ts:13-36");
	});

	it("follows displayContent line numbers across an elided block", () => {
		const view = readToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "x" }],
				details: { displayContent: { text: "a\nb\n…\nz", startLine: 4, lineNumbers: [4, 5, null, 90] } },
			},
			collapsed,
			{ path: "src/x.ts:4-5,90" },
		);
		expect(codeStarts(view.body)).toEqual([4, 90]);
	});

	it("puts a read error's message in the head, not only behind the disclosure", () => {
		const view = readToolRenderer.describeResult(
			{ content: [{ type: "text", text: "Error: ENOENT: no such file" }], isError: true },
			collapsed,
			{ path: "src/nope.ts" },
		);
		expect(view.tone).toBe("error");
		expect(view.inline).toBe(true);
		expect((view.tool?.meta ?? []).map(plain).join(" ")).toContain("ENOENT: no such file");
		expect(view.body).toBeUndefined();
	});
});

describe("read group tool node", () => {
	beforeAll(async () => {
		await initTheme();
	});
	it("lists one file row per read and previews as trimmed sections", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "src/a.ts" }, "a");
		group.updateArgs({ path: "src/b.ts" }, "b");
		group.updateResult(
			{
				content: [{ type: "text", text: "x" }],
				details: { displayContent: { text: "1\n2\n3\n4\n5", startLine: 1 } },
			},
			false,
			"a",
		);
		group.updateResult({ content: [{ type: "text", text: "Error: denied" }], isError: true }, false, "b");
		const tool = group.describe(toolCx);
		expect(tool.k).toBe("tool");
		expect(tool.k === "tool" ? tool.p : undefined).toMatchObject({
			target: "2 files",
			frame: "inline",
			status: "error",
			collapsed: true,
		});
		const rows = collect(tool.c, n => role(n) === "omp.tool.file");
		expect(rows).toHaveLength(1);
		const sections = collect(tool.c, n => n.k === "section");
		expect(sections).toHaveLength(1);
		expect(codeProps(sections).map(p => p.text)).toEqual(["1\n2\n3"]);
		expect(collect(tool.c, n => n.k === "card")).toHaveLength(0);

		group.setExpanded(true);
		const open = group.describe(toolCx);
		expect(codeProps(open.c).map(p => p.text)).toEqual(["1\n2\n3\n4\n5"]);
	});

	it("keeps the fallback card for terminals without the tool kind", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "src/a.ts" }, "a");
		expect(group.describe().k).toBe("card");
	});

	it("shows passive context in both native serializers", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "src/a.ts" }, "a");
		group.describe(toolCx);
		group.describe();
		group.setAdditionalContext("read guidance");
		for (const described of [group.describe(toolCx), group.describe()]) {
			// The read card's collapsed preview clamp never hides the context: it is the card's sibling.
			expect(described.k).toBe("col");
			const [readCard, ...rest] = (described.c ?? []).filter(isNode);
			expect(collect([readCard!], n => role(n) === "omp.tool.context")).toHaveLength(0);
			expect(rest.map(role)).toEqual(["omp.tool.context"]);
			expect(JSON.stringify(rest)).toContain("↳ Context: read guidance");
		}
	});
});

describe("glob native view", () => {
	const files = (n: number) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
	it("lists up to six files as rows and wraps more as chips", () => {
		const few = globToolRenderer.describeResult(
			{ content: [], details: { fileCount: 6, files: files(6) } },
			collapsed,
		);
		const many = globToolRenderer.describeResult(
			{ content: [], details: { fileCount: 7, files: files(7) } },
			collapsed,
		);
		expect(collect(few.body, n => role(n) === "omp.tool.file")).toHaveLength(6);
		expect(collect(few.body, n => role(n) === "omp.tool.chip")).toHaveLength(0);
		expect(collect(many.body, n => role(n) === "omp.tool.chip")).toHaveLength(7);
	});
});

describe("lsp native view", () => {
	const args = { action: "diagnostics" as const, file: "src/frame.rs" };

	it("shows a server failure as an error row, never as no issues", () => {
		const view = lspToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "✘ src/frame.rs: all language servers failed (rust-analyzer)" }],
				details: { action: "diagnostics", success: false },
			},
			collapsed,
			args,
		);
		expect(view?.tone).toBe("error");
		expect(view?.inline).not.toBe(true);
		expect((view?.tool?.meta ?? []).map(plain).join(" ")).not.toContain("No issues");
		expect(collect(view?.body, n => role(n) === "omp.tool.error")).toHaveLength(1);
	});

	it("parses grouped diagnostics into file:line:col rows and frames them", () => {
		const text = [
			"2 error(s):",
			"# src/",
			"## frame.rs",
			"  12:5 [error] [rust-analyzer] cannot find type `Op` (E0412)",
			"  14:1 [error] bad",
		].join("\n");
		const view = lspToolRenderer.describeResult(
			{ content: [{ type: "text", text }], details: { action: "diagnostics", success: true } },
			collapsed,
			args,
		);
		expect(view?.inline).not.toBe(true);
		const rows = collect(view?.body, n => role(n) === "omp.tool.diagnostic");
		expect(rows).toHaveLength(2);
		const texts = collect(rows[0]!.c, n => n.k === "text").map(n => (n.k === "text" ? plain(n.p?.spans) : ""));
		expect(texts[0]).toBe("src/frame.rs:12:5");
		const badges = collect(rows[0]!.c, n => n.k === "badge").map(n => (n.k === "badge" ? n.p?.text : undefined));
		expect(badges).toEqual(["rust-analyzer"]);
	});
});
