import { beforeAll, describe, expect, it } from "bun:test";
import type { TspText } from "@oh-my-pi/pi-wire";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { setTranscriptPresenters } from "../src/chat/transcript-presentation";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { getThemeByName, initTheme, type Theme } from "../src/theme";
import { globToolRenderer } from "../src/tools/glob";
import { type GrepToolDetails, grepToolRenderer } from "../src/tools/grep";
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

function codeProps(
	children: readonly NativeChild[] | undefined,
): { start?: number; nums?: readonly number[]; text?: string; marks?: readonly { line: number }[] }[] {
	return collect(children, n => n.k === "code").flatMap(n => (n.k === "code" && n.p ? [n.p] : []));
}

function codeStarts(children: readonly NativeChild[] | undefined): (number | undefined)[] {
	return codeProps(children).map(p => p.start);
}

describe("grep native view", () => {
	beforeAll(async () => {
		await initTheme();
	});

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

	it("preserves regex escapes while coloring literals and operators as native spans", () => {
		const pattern = String.raw`file\.ts|\d+`;
		const view = grepToolRenderer.describeCall({ pattern });
		const target = view.tool?.target;
		if (target === undefined || typeof target === "string") {
			throw new Error("Regex header must carry syntax-colored spans");
		}

		expect(plain(target)).toBe(pattern);
		const escapedLiteral = target.find(part => part.t === String.raw`\.`);
		const operators = target.find(part => part.t.includes("|"));
		expect(escapedLiteral?.s).toBeDefined();
		expect(operators?.s).toBeDefined();
		expect(escapedLiteral?.s).not.toBe(operators?.s);
		expect(target.some(part => part.t.includes("\x1b"))).toBe(false);
	});

	it("shows the first two files while collapsed and every file expanded", () => {
		const small = grepToolRenderer.describeResult(result, collapsed, { pattern: "hit" });
		const full = grepToolRenderer.describeResult(result, expanded, { pattern: "hit" });
		const files = (view: typeof small) => collect(view.body, n => role(n) === "omp.tool.search.file");
		expect(files(small)).toHaveLength(2);
		expect(files(full)).toHaveLength(3);
		expect(small.inline).toBe(true);
	});

	it("names the scope before the counts, as the terminal card does", () => {
		const scoped = { ...result, details: { ...result.details, scopePath: "src" } };
		const view = grepToolRenderer.describeResult(scoped, collapsed, { pattern: "hit" });
		expect((view.tool?.meta ?? []).map(plain)).toEqual(["in src", "4 matches · 3 files"]);
	});

	it("keeps non-adjacent match lines in one block numbered by their real lines", () => {
		const view = grepToolRenderer.describeResult(result, expanded, { pattern: "hit" });
		const first = collect(view.body, n => role(n) === "omp.tool.search.file")[0]!;
		const kinds = (first.c ?? []).filter(isNode).map(n => n.k);
		expect(kinds).toEqual(["row", "code"]);
		const [props] = codeProps(first.c);
		expect(props).toMatchObject({ text: "ctx\nhit\nfar", nums: [9, 10, 40] });
		expect(props!.start).toBeUndefined();
		expect(props!.marks?.map(m => m.line)).toEqual([10, 40]);
		// Contiguous files keep `start` and send no `nums`.
		const second = collect(view.body, n => role(n) === "omp.tool.search.file")[1]!;
		expect(codeProps(second.c)).toEqual([expect.objectContaining({ start: 1, nums: undefined })]);
	});

	it("puts a single-file search, which prints no header, under that file's row", () => {
		const single = [" 9│ctx", "*10│hit", "   │...", "*40│far"].join("\n");
		const view = grepToolRenderer.describeResult(
			{
				content: [{ type: "text", text: single }],
				details: {
					matchCount: 2,
					fileCount: 1,
					scopePath: "src/a.ts",
					files: ["src/a.ts"],
					displayContent: single,
				},
			},
			expanded,
			{ pattern: "hit" },
		);
		const body = (view.body ?? []).filter(isNode);
		expect(body.map(role)).toEqual(["omp.tool.search.file"]);
		const kinds = (body[0]!.c ?? []).filter(isNode).map(n => n.k);
		expect(kinds).toEqual(["row", "code"]);
		expect(codeProps(body[0]!.c).map(p => p.nums)).toEqual([[9, 10, 40]]);
	});

	it("omits the file count only when the header already names the single searched file", () => {
		const meta = (details: GrepToolDetails) =>
			grepToolRenderer
				.describeResult({ content: [{ type: "text", text: "" }], details }, expanded, { pattern: "hit" })
				.tool?.meta?.map(plain);
		const single = { matchCount: 2, fileCount: 1, displayContent: "*10│hit\n*40│far" };
		// A single-file search prints no `#` headers; its scope already names the file.
		expect(meta({ ...single, scopePath: "src/a.ts" })).toEqual(["in src/a.ts", "2 matches"]);
		// No scope in the header: `1 file` is the only file information left.
		expect(meta(single)).toEqual(["2 matches · 1 file"]);
		// A directory search matching one file prints its header and keeps the count.
		expect(meta({ matchCount: 1, fileCount: 1, scopePath: "src", displayContent: "## src/a.ts\n*10│hit" })).toEqual([
			"in src",
			"1 match · 1 file",
		]);
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
		expect(codeProps(view.body)).toEqual([expect.objectContaining({ text: "a\nb\nz", nums: [4, 5, 90] })]);
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

	it("sends a mixed group's full reads in whole once their subset is expanded", () => {
		// Regression guard: expanding the `full` subset beside a compact read keeping its previews clamped.
		setTranscriptPresenters([block => (block.type === "toolCall" && block.id === "b" ? "compact" : undefined)]);
		try {
			const group = new ReadToolGroupComponent({ showContentPreview: true });
			for (const id of ["a", "b"]) {
				group.updateArgs({ path: `src/${id}.ts` }, id);
				group.updateResult(
					{
						content: [{ type: "text", text: "x" }],
						details: { displayContent: { text: "1\n2\n3\n4\n5", startLine: 1 } },
					},
					false,
					id,
				);
			}
			const full = (node: NativeNode) => (node.c ?? []).filter(isNode).find(n => n.key === "full");
			const before = full(group.describe(toolCx));
			expect(codeProps(before?.c).map(p => p.text)).toEqual(["1\n2\n3"]);

			group.handleNativeEvent({ type: "toggle", key: "full", collapsed: false });
			const open = full(group.describe(toolCx));
			expect(open?.p).toMatchObject({ collapsed: false });
			expect(codeProps(open?.c).map(p => p.text)).toEqual(["1\n2\n3\n4\n5"]);
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("reports a read's late-result presentation change on refresh, measured against what it last drew", () => {
		// Regression guard: the group resolving the new answer when the result landed, so the
		// refresh saw no change and a retired compact row stayed in terminal scrollback.
		setTranscriptPresenters([
			block =>
				block.type !== "toolCall"
					? undefined
					: JSON.stringify(block.result?.content ?? []).includes("LATE")
						? "hidden"
						: { compact: { label: "ROW" } },
		]);
		try {
			const group = new ReadToolGroupComponent();
			group.updateArgs({ path: "src/a.ts" }, "a");
			expect(group.render(80).join("\n")).toContain("ROW");

			group.updateResult({ content: [{ type: "text", text: "LATE" }] }, false, "a");
			expect(group.refreshTranscriptPresentation(new Set(["a"]))).toBe(true);
			expect(group.render(80).join("\n")).not.toContain("ROW");
		} finally {
			setTranscriptPresenters([]);
		}
	});

	/** A group of reads `ids`, each previewing five lines. */
	function previewGroup(ids: readonly string[], showContentPreview = true): ReadToolGroupComponent {
		const group = new ReadToolGroupComponent({ showContentPreview });
		for (const id of ids) {
			group.updateArgs({ path: `src/${id}.ts` }, id);
			group.updateResult(
				{
					content: [{ type: "text", text: "x" }],
					details: { displayContent: { text: "1\n2\n3\n4\n5", startLine: 1 } },
				},
				false,
				id,
			);
		}
		return group;
	}

	it("opens one compact read in whole, leaving its siblings clamped, and keeps it open across refreshes", () => {
		// Regression guard: an opened read's preview staying clamped by group-wide state, and a later
		// presenter refresh folding it back to its compact row.
		setTranscriptPresenters([block => (block.type === "toolCall" && block.id !== "c" ? "compact" : undefined)]);
		try {
			const group = previewGroup(["a", "b", "c"]);
			group.describe(toolCx);
			group.handleNativeEvent({ type: "toggle", key: "ca", collapsed: false });
			const texts = () =>
				codeProps((group.describe(toolCx).c ?? []).filter(isNode).find(n => n.key === "full")?.c).map(p => p.text);
			expect(texts()).toEqual(["1\n2\n3\n4\n5", "1\n2\n3"]);

			group.refreshTranscriptPresentation();
			expect(texts()).toEqual(["1\n2\n3\n4\n5", "1\n2\n3"]);
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("routes a lone compact read's toggle to that read, not to the hidden one beside it", () => {
		// Regression guard: the lone visible child losing its key, its toggle read as the group's
		// Ctrl+O and revealing the hidden read.
		setTranscriptPresenters([
			block => (block.type !== "toolCall" ? undefined : block.id === "a" ? "hidden" : "compact"),
		]);
		try {
			const group = previewGroup(["a", "b"]);
			const root = group.describe(toolCx);
			const child = (root.c ?? []).filter(isNode).find(n => n.key === "cb");
			expect(child).toBeDefined();
			group.handleNativeEvent({ type: "toggle", key: "cb", collapsed: false });
			expect(JSON.stringify(group.describe(toolCx))).not.toContain("src/a.ts");
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("draws only the reads a refresh left full, even when the group had not drawn yet", () => {
		// Regression guard: an undrawn group's refresh reporting no change and skipping the rebuild,
		// so its first draw still listed the read a presenter now hides.
		const group = previewGroup(["a", "b"], false);
		setTranscriptPresenters([block => (block.type === "toolCall" && block.id === "a" ? "hidden" : undefined)]);
		try {
			group.refreshTranscriptPresentation();
			const drawn = Bun.stripANSI(group.render(100).join("\n"));
			expect(drawn).not.toContain("a.ts");
			expect(drawn).toContain("b.ts");
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("keeps a preview the user opened on a terminal without the tool kind full across refreshes", () => {
		// Regression guard: the fallback card's `p<id>` toggle opening only the preview, so a later
		// presenter refresh compacted the read the user had just opened.
		let compact = false;
		setTranscriptPresenters([block => (block.type === "toolCall" && compact ? "compact" : undefined)]);
		try {
			const group = previewGroup(["a"]);
			group.describe();
			group.handleNativeEvent({ type: "toggle", key: "pa", collapsed: false });
			compact = true;
			group.refreshTranscriptPresentation(new Set(["a"]));
			const root = group.describe();
			expect(collect([root], n => n.key === "ca")).toEqual([]);
			const previews = collect([root], n => role(n) === "omp.tool.read.preview");
			expect(previews.map(preview => preview.p)).toEqual([expect.objectContaining({ collapsed: false })]);
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("keeps a Markdown read the user opened full across refreshes", () => {
		// Regression guard: the Markdown preview card's toggle arriving unkeyed and being dropped, so a
		// later presenter refresh compacted the read the user had just opened.
		let compact = false;
		setTranscriptPresenters([block => (block.type === "toolCall" && compact ? "compact" : undefined)]);
		try {
			const group = new ReadToolGroupComponent({ showContentPreview: true });
			group.updateArgs({ path: "src/a.md" }, "a");
			group.updateResult(
				{
					content: [{ type: "text", text: "# A\n\none\n\ntwo\n\nthree" }],
					details: { contentType: "text/markdown" },
				},
				false,
				"a",
			);
			const card = collect([group.describe(toolCx)], n => n.k === "card")[0];
			expect(card?.key).toBe("ma");
			group.handleNativeEvent({ type: "toggle", key: `${card?.key}`, collapsed: false });
			compact = true;
			group.refreshTranscriptPresentation(new Set(["a"]));
			const root = group.describe(toolCx);
			expect(collect([root], n => n.key === "ca")).toEqual([]);
			expect(collect([root], n => n.k === "card")[0]?.p).toMatchObject({ collapsed: false });
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("opens a read joining a group whose full reads the user opened", () => {
		// Regression guard: a late parallel read clamped beside the unclamped reads of an open card.
		setTranscriptPresenters([block => (block.type === "toolCall" && block.id === "a" ? "compact" : undefined)]);
		try {
			const group = previewGroup(["a", "b"]);
			group.describe(toolCx);
			group.handleNativeEvent({ type: "toggle", key: "full", collapsed: false });
			group.updateArgs({ path: "src/c.ts" }, "c");
			group.updateResult(
				{
					content: [{ type: "text", text: "x" }],
					details: { displayContent: { text: "1\n2\n3\n4\n5", startLine: 1 } },
				},
				false,
				"c",
			);
			const full = (group.describe(toolCx).c ?? []).filter(isNode).find(n => n.key === "full");
			expect(codeProps(full?.c).map(p => p.text)).toEqual(["1\n2\n3\n4\n5", "1\n2\n3\n4\n5"]);
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("clamps Markdown previews after parsing full documents for each grouped read", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		const table = "# Overview\n\n\n| A | B |\n|---|---|\n| one | two |";
		const fence = "```ts\nconst value = 1;\n```\n\nEnd.";
		for (const [id, source] of [
			["table", table],
			["fence", fence],
		]) {
			group.updateArgs({ path: `src/${id}.md` }, id);
			group.updateResult(
				{ content: [{ type: "text", text: source }], details: { contentType: "text/markdown" } },
				false,
				id,
			);
		}

		const collapsed = group.describe(toolCx);
		const previews = collect(collapsed.c, n => n.k === "card");
		expect(previews.map(preview => preview.p)).toEqual([
			expect.objectContaining({ collapsed: true, preview: { lines: 3 } }),
			expect.objectContaining({ collapsed: true, preview: { lines: 3 } }),
		]);
		expect(collect(collapsed.c, n => n.k === "md").flatMap(n => (n.k === "md" ? [n.p?.text] : []))).toEqual([
			table,
			fence,
		]);
		expect(collect(collapsed.c, n => role(n) === "omp.tool.stats")).toHaveLength(0);

		group.setExpanded(true);
		expect(
			collect(group.describe(toolCx).c, n => n.k === "card").flatMap(n => (n.k === "card" ? [n.p?.collapsed] : [])),
		).toEqual([false, false]);
	});

	it("keeps the fallback card for terminals without the tool kind", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "src/a.ts" }, "a");
		expect(group.describe().k).toBe("card");
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

	it("previews each reference's source line, and lists one past the context limit by position", () => {
		const text = [
			"Found 3 reference(s):",
			"  src/a.ts:3:7",
			"    3: const claims = validate(token);",
			"  src/a.ts:3:20",
			"    3: const claims = validate(token);",
			"  ... 1 additional reference(s) shown without context",
			"  src/a.ts:9:1",
		].join("\n");
		const view = lspToolRenderer.describeResult({ content: [{ type: "text", text }] }, collapsed, {
			action: "references",
		});
		// Two references on one line share its source row.
		expect(codeProps(view?.body)).toEqual([
			expect.objectContaining({
				text: "const claims = validate(token);",
				start: 3,
				marks: [{ line: 3, tone: "accent" }],
			}),
		]);
		const texts = collect(view?.body, n => n.k === "text").map(n => (n.k === "text" ? plain(n.p?.spans) : ""));
		expect(texts).toContain("9:1");
	});

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

	it("shows a file whose server sent no report as unverified, never as no issues", () => {
		const text = [
			"✔ src/fast.cpp: no issues",
			"⚠ src/slow.cpp: no diagnostics report yet from clangd; query the file alone for a longer wait",
		].join("\n");
		const view = lspToolRenderer.describeResult(
			{ content: [{ type: "text", text }], details: { action: "diagnostics", success: true } },
			collapsed,
			{ action: "diagnostics", file: "src/*.cpp" },
		);
		expect(view?.inline).not.toBe(true);
		const meta = (view?.tool?.meta ?? []).map(plain).join(" ");
		expect(meta).toContain("1 unverified file");
		expect(meta).not.toContain("No issues");
		expect(collect(view?.body, n => role(n) === "omp.tool.diagnostic")).toHaveLength(1);
	});

	it("shows a partial server failure as a warning, never as no issues", () => {
		const view = lspToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "OK\n⚠ src/frame.rs: some servers failed (rust-analyzer)" }],
				details: { action: "diagnostics", success: true },
			},
			collapsed,
			args,
		);
		expect(view?.tone).toBe("warning");
		expect((view?.tool?.meta ?? []).map(plain).join(" ")).not.toContain("No issues");
		expect(collect(view?.body, n => role(n) === "omp.tool.diagnostic")).toHaveLength(1);

		const clean = lspToolRenderer.describeResult(
			{ content: [{ type: "text", text: "OK" }], details: { action: "diagnostics", success: true } },
			collapsed,
			args,
		);
		expect(clean?.tone).toBeUndefined();
		expect((clean?.tool?.meta ?? []).map(plain)).toEqual(["No issues"]);
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

describe("lsp text view", () => {
	let theme: Theme;
	beforeAll(async () => {
		await initTheme();
		theme = (await getThemeByName("dark"))!;
	});

	it("lists a file whose server sent no report beside the diagnostics, never as no issues", () => {
		const unverified = `${theme.status.warning} src/slow.cpp: no diagnostics report yet from clangd; query the file alone for a longer wait`;
		const cases: Array<[string[], RenderResultOptions]> = [
			[
				[
					`${theme.status.error} src/bad.cpp: 1 error(s)`,
					"src/bad.cpp:3:5 [error] [clangd] use of undeclared identifier 'x'",
					unverified,
				],
				collapsed,
			],
			[[`${theme.status.success} src/fast.cpp: no issues`, unverified], expanded],
		];
		for (const [lines, options] of cases) {
			const rendered = Bun.stripANSI(
				lspToolRenderer
					.renderResult(
						{
							content: [{ type: "text", text: lines.join("\n") }],
							details: { action: "diagnostics", success: true },
						},
						options,
						theme,
						{ action: "diagnostics", file: "src/*.cpp" },
					)
					.render(120)
					.join("\n"),
			);
			expect(rendered).toContain("1 unverified file");
			expect(rendered).toContain("src/slow.cpp: no diagnostics report yet from clangd");
			expect(rendered).not.toContain("No issues");
		}
	});
});
