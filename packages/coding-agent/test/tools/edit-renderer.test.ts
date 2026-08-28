import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { editToolRenderer } from "@oh-my-pi/pi-coding-agent/edit/renderer";
import { SLOPPY_MARKERS } from "@oh-my-pi/pi-coding-agent/edit/sloppy";
import { renderDiff } from "@oh-my-pi/pi-coding-agent/modes/components/diff";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Text, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

let uiThemePromise: Promise<themeModule.Theme> | undefined;

function getUiTheme(): Promise<themeModule.Theme> {
	uiThemePromise ??= (async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
		const theme = await themeModule.getThemeByName("dark");
		expect(theme).toBeDefined();
		return theme!;
	})();
	return uiThemePromise;
}

async function waitForRenderedText(
	component: ToolExecutionComponent,
	width: number,
	expectedText: string,
): Promise<string> {
	const deadline = Date.now() + 1_000;
	let rendered = "";
	while (Date.now() < deadline) {
		rendered = Bun.stripANSI(component.render(width).join("\n"));
		if (rendered.includes(expectedText)) return rendered;
		await Bun.sleep(10);
	}
	return rendered;
}

describe("editToolRenderer", () => {
	it("shows the target path from partial JSON while edit args stream", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{
				__partialJson: '{"path":"packages/coding-agent/src/edit/renderer.ts","old_string":"before',
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
	});

	it("windows the expanded streaming diff to the viewport tail", async () => {
		const uiTheme = await getUiTheme();
		// Pin a tall viewport so previewWindowRows() (rows - reserve) lands at 30:
		// collapsed stays at the 12-row fixed tail, expanded widens to 30.
		const originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
		try {
			const makeDiff = (length: number): string =>
				Array.from({ length }, (_, index) => (index === 0 ? "-head-line-1" : `+tail-line-${index + 1}`)).join("\n");
			const renderPreview = (diff: string, expanded: boolean): string =>
				Bun.stripANSI(
					editToolRenderer
						.renderCall(
							{ file_path: "/tmp/preview.ts", previewDiff: diff },
							{ expanded, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
							uiTheme,
						)
						.render(200)
						.join("\n"),
				);

			const collapsed = renderPreview(makeDiff(20), false);
			expect(collapsed).toContain("tail-line-20");
			expect(collapsed).not.toContain("head-line-1");
			expect(collapsed).toContain("content above");
			expect(collapsed).toContain("(preview)");

			// Within the viewport window, expanded shows the whole diff.
			const expanded = renderPreview(makeDiff(20), true);
			expect(expanded).toContain("head-line-1");
			expect(expanded).toContain("tail-line-20");
			expect(expanded).not.toContain("content above");
			expect(expanded).not.toContain("(preview)");

			// Beyond it, expanded stays a viewport-sized tail window: an unbounded
			// live preview scrolls above the native-scrollback commit boundary and
			// freezes a stale snapshot that duplicates the block at finalize.
			const expandedTall = renderPreview(makeDiff(40), true);
			expect(expandedTall).toContain("tail-line-40");
			expect(expandedTall).not.toContain("head-line-1");
			expect(expandedTall).toContain("content above");
		} finally {
			if (originalRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
		}
	});

	it("does not report a leading blank line as hidden content", async () => {
		const uiTheme = await getUiTheme();
		const rendered = Bun.stripANSI(
			editToolRenderer
				.renderCall(
					{ file_path: "/tmp/leading-blank.ts", previewDiff: "\n+1|first-added\n+2|second-added" },
					{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
					uiTheme,
				)
				.render(200)
				.join("\n"),
		);

		expect(rendered).toContain("first-added");
		expect(rendered).toContain("second-added");
		expect(rendered).not.toContain("content above");
	});

	it("uses a count-free marker for a discarded streaming prefix", async () => {
		const uiTheme = await getUiTheme();
		const diff = [
			"@@ -1,10000 +1,12 @@",
			...Array.from({ length: 10_000 }, (_, index) => `-hidden-line-${index + 1}`),
			...Array.from({ length: 12 }, (_, index) => `+visible-tail-${index + 1}`),
			"",
			"",
		].join("\n");

		const rendered = Bun.stripANSI(
			editToolRenderer
				.renderCall(
					{ file_path: "/tmp/large-preview.ts", previewDiff: diff },
					{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
					uiTheme,
				)
				.render(200)
				.join("\n"),
		);

		expect(rendered).toContain("content above");
		expect(rendered).toContain("visible-tail-12");
		expect(rendered).not.toContain("hidden-line-10000");
		expect(rendered).not.toContain("more hunks");
		expect(rendered).not.toContain("more lines above");
	});

	it("uses hashline input headers for streaming call path without apply_patch errors", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{
				input: "[packages/coding-agent/src/edit/renderer.ts]\nPUT >$:\n+// preview",
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain("The first line of the patch must be");
	});

	it("uses sloppy input section headers for the streaming call path", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{ input: `[src/engine/disk.rs]\n${SLOPPY_MARKERS.open}\nfn parse_disk_ref(` },
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "sloppy" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("src/engine/disk.rs");
	});

	it("counts extra sloppy sections in the streaming call header", async () => {
		const uiTheme = await getUiTheme();
		const input = `[a.ts]\n${SLOPPY_MARKERS.open}\nfoo\n[b.ts]\n${SLOPPY_MARKERS.open}\nbar`;
		const component = editToolRenderer.renderCall(
			{ input },
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "sloppy" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("a.ts");
		expect(rendered).toContain("(+1 more)");
	});

	it("shows hashline envelope target path while preview diff is not computable yet", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{
				input: [
					"*** Begin Patch",
					"[crates/pi-natives/src/shell.rs]",
					"PUT >$:",
					"+pub fn streaming_preview() {",
				].join("\n"),
			},
			{},
			hashlineTool,
			uiStub,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("crates/pi-natives/src/shell.rs");
		expect(rendered).not.toContain("PUT >$:");
		expect(rendered).not.toContain("+pub fn streaming_preview() {");
		expect(rendered).not.toContain("*** Begin Patch");
	});

	it("recognizes compact and quoted hashline input headers", async () => {
		const uiTheme = await getUiTheme();
		const compactComponent = editToolRenderer.renderCall(
			{
				input: "[foo bar.ts]\nPUT <1:\n+// preview",
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const quotedComponent = editToolRenderer.renderCall(
			{
				input: "['baz qux.ts']\nPUT <1:\n+// preview",
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const compactRendered = Bun.stripANSI(compactComponent.render(160).join("\n"));
		const quotedRendered = Bun.stripANSI(quotedComponent.render(160).join("\n"));
		expect(compactRendered).toContain("foo bar.ts");
		expect(quotedRendered).toContain("baz qux.ts");
	});

	it("strips bracket delimiters from hashline input headers", async () => {
		const uiTheme = await getUiTheme();

		// Canonical `[PATH]` form — the parser strips the delimiters and the
		// renderer keeps the title clean.
		const canonical = editToolRenderer.renderCall(
			{
				input: "[packages/coding-agent/src/slash-commands/builtin-registry.ts]\nPUT <1:\n+// preview",
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		// While streaming, the closing bracket may not have arrived yet.
		const partial = editToolRenderer.renderCall(
			{ input: "[a/b/c.ts\nPUT <1:\n+// preview" },
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const canonicalRendered = Bun.stripANSI(canonical.render(160).join("\n"));
		const partialRendered = Bun.stripANSI(partial.render(160).join("\n"));

		expect(canonicalRendered).toContain("packages/coding-agent/src/slash-commands/builtin-registry.ts");
		expect(canonicalRendered).not.toMatch(/\[packages\/coding-agent/);
		expect(partialRendered).toContain("a/b/c.ts");
		expect(partialRendered).not.toMatch(/\[a\/b\/c\.ts/);
	});

	it("uses hashline input headers for completed single-file result path", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated packages/coding-agent/src/edit/renderer.ts" }],
				details: {
					diff: "+1|// preview",
					op: "update",
				},
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "hashline" } },
			uiTheme,
			{
				input: "[packages/coding-agent/src/edit/renderer.ts]\nPUT >$:\n+// preview",
			},
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain(" …");
	});

	it("omits changed-line suffixes from completed edit headers and middle-elides long paths", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated transcript-container.test.ts" }],
				details: {
					diff: "+1│const value = 2;",
					firstChangedLine: 251,
					op: "update",
					path: "/tmp/project/packages/coding-agent/test/modes/components/transcript-container.test.ts",
				},
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "hashline" } },
			uiTheme,
			{ file_path: "packages/coding-agent/test/modes/components/transcript-container.test.ts" },
		);

		const wideHeader = Bun.stripANSI(component.render(160)[0]);
		expect(wideHeader).toContain("packages/coding-agent/test/modes/components/transcript-container.test.ts");
		expect(wideHeader).not.toContain(":251");

		const narrowHeader = Bun.stripANSI(component.render(72)[0]);
		expect(narrowHeader).toContain("…");
		expect(narrowHeader).toContain("container.test.ts");
		expect(narrowHeader).not.toContain(":251");
	});
	it("caches completed diff rendering across stable frame renders", async () => {
		const uiTheme = await getUiTheme();
		let renderDiffCalls = 0;
		let statsColorCalls = 0;
		const countingTheme = new Proxy(uiTheme, {
			get(target, property) {
				if (property === "fg") {
					return (color: Parameters<themeModule.Theme["fg"]>[0], text: string): string => {
						if (color === "toolDiffAdded" && text === "+1") statsColorCalls++;
						return target.fg(color, text);
					};
				}
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const options = {
			expanded: false,
			isPartial: false,
			renderContext: {
				renderDiff: (diffText: string) => {
					renderDiffCalls++;
					return diffText;
				},
			},
		};
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated src/example.ts" }],
				details: {
					diff: "+1│const value = 1;",
					op: "update",
					path: "src/example.ts",
				},
			},
			options,
			countingTheme,
			{ file_path: "src/example.ts" },
		);

		component.render(160);
		component.render(120);
		expect(renderDiffCalls).toBe(1);
		expect(statsColorCalls).toBe(1);

		options.expanded = true;
		component.render(120);
		expect(renderDiffCalls).toBe(2);
		expect(statsColorCalls).toBe(1);
	});

	it("computes the hashline preview diff once a single-line edit finishes streaming", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-stream-preview-"));
		try {
			const content = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
			const filePath = path.join(tmpDir, "memory.ts");
			await Bun.write(filePath, content);

			const snapshots = new InMemorySnapshotStore();
			const tag = snapshots.record(filePath, content);

			// The trailing payload line carries no newline — the common shape for a
			// single-line edit. The streaming pass trims that in-flight line, so the
			// preview only becomes computable once args are marked complete.
			const input = `[memory.ts#${tag}]\nPUT 2-2:\n+export const b = 22;`;
			const component = new ToolExecutionComponent("edit", { input }, { snapshots }, hashlineTool, uiStub, tmpDir);

			component.setArgsComplete();

			// The preview diff computes asynchronously after args complete; poll
			// instead of a fixed sleep so the slower CI VM has time to finish it.
			const rendered = await waitForRenderedText(component, 160, "export const b = 22;");
			expect(rendered).toContain("export const b = 22;");
			expect(rendered).not.toContain("No changes would be made");
		} finally {
			await removeWithRetries(tmpDir);
		}
	});

	it("renders raw custom hashline input carried only in partialJson", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-custom-stream-preview-"));
		try {
			const content = "export const a = 1;\nexport const b = 2;\n";
			const filePath = path.join(tmpDir, "memory.ts");
			await Bun.write(filePath, content);

			const snapshots = new InMemorySnapshotStore();
			const tag = snapshots.record(filePath, content);
			const input = `[memory.ts#${tag}]\nPUT 2-2:\n+export const b = 22;\n`;
			const component = new ToolExecutionComponent(
				"edit",
				{ __partialJson: input },
				{ snapshots },
				hashlineTool,
				uiStub,
				tmpDir,
			);

			const rendered = await waitForRenderedText(component, 160, "export const b = 22;");
			expect(rendered).toContain("memory.ts");
			expect(rendered).toContain("export const b = 22;");
			expect(rendered).not.toContain(" …");
		} finally {
			await removeWithRetries(tmpDir);
		}
	});

	it("renders raw custom apply_patch input carried only in partialJson", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const input = [
			"*** Begin Patch",
			"*** Update File: src/demo.ts",
			"@@",
			"-const value = 1;",
			"+const value = 2;",
			"*** End Patch",
		].join("\n");

		const component = new ToolExecutionComponent("apply_patch", { __partialJson: input }, {}, undefined, uiStub);
		const rendered = await waitForRenderedText(component, 160, "const value = 2;");

		expect(rendered).toContain("src/demo.ts");
		expect(rendered).toContain("const value = 2;");
		expect(rendered).not.toContain(" …");
	});

	it("normalizes raw streamed text input for any renderer", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const customTextTool = {
			name: "custom_text",
			label: "Custom Text",
			renderCall(args: unknown) {
				const input =
					typeof (args as { input?: unknown }).input === "string" ? (args as { input: string }).input : "";
				return new Text(input, 0, 0);
			},
		} as unknown as AgentTool;

		const component = new ToolExecutionComponent(
			"custom_text",
			{ __partialJson: "plain streamed text" },
			{},
			customTextTool,
			uiStub,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("plain streamed text");
	});

	it("uses the supplied theme when the injected diff renderer is unavailable", async () => {
		const activeTheme = await getUiTheme();
		const uiTheme = await themeModule.getThemeByName("light");
		if (!uiTheme) throw new Error("Built-in light theme is unavailable");
		expect(uiTheme.fg("toolDiffAdded", "COLOR")).not.toBe(activeTheme.fg("toolDiffAdded", "COLOR"));
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated demo.ts" }],
				details: { diff: "-1|const oldValue = 1;\n\n+2|const newValue = 2;", op: "update", path: "demo.ts" },
			},
			{ expanded: true, isPartial: false, renderContext: { editMode: "hashline" } },
			uiTheme,
			{ file_path: "demo.ts" },
		);

		const rows = component.render(160);
		const removedRow = rows.find(row => row.includes("oldValue"));
		const addedRow = rows.find(row => row.includes("newValue"));
		const removedColor = uiTheme.fg("toolDiffRemoved", "COLOR").split("COLOR")[0];
		const addedColor = uiTheme.fg("toolDiffAdded", "COLOR").split("COLOR")[0];

		expect(removedRow).toContain(removedColor);
		expect(addedRow).toContain(addedColor);
	});

	it("renders change stats inline on the result header with no separate metadata or stats row", async () => {
		const uiTheme = await getUiTheme();
		const diff = [" 115│ ctx", "-116│ old", "+117│ new one", "+118│ new two"].join("\n");
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated demo.go" }],
				details: { diff, op: "update" },
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "hashline" } },
			uiTheme,
			{ file_path: "demo.go" },
		);

		const lines = Bun.stripANSI(component.render(160).join("\n")).split("\n");
		// Stats ride on the header line next to the path…
		expect(lines[0]).toContain("demo.go");
		expect(lines[0]).toContain("+2");
		expect(lines[0]).toContain("-1");
		expect(lines[0]).toContain("+2/-1");
		// …only there (no standalone stats row), and the diff starts immediately
		// below the header (no blank line, no lone lang-icon metadata row).
		expect(lines[1]).toContain("115│ ctx");
		expect(lines.filter(line => line.includes("+2/-1"))).toHaveLength(1);
	});

	it("bounds a completed diff that contains one oversized change hunk", async () => {
		const uiTheme = await getUiTheme();
		const diff = Array.from({ length: 1_000 }, (_, i) => `+${i + 1}│line ${i}`).join("\n");
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated demo.ts" }],
				details: { diff, op: "update" },
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "hashline" } },
			uiTheme,
			{ file_path: "demo.ts" },
		);

		const lines = component.render(160).map(line => Bun.stripANSI(line));
		const rendered = lines.join("\n");
		expect(lines.filter(line => line.includes("│line "))).toHaveLength(40);
		expect(rendered).toContain("+40│line 39");
		expect(rendered).not.toContain("+41│line 40");
		expect(rendered).toContain("960 more lines");
	});

	it("bounds a completed collapsed diff by rendered rows", async () => {
		const uiTheme = await getUiTheme();
		const tail = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".repeat(4);
		const diff = Array.from({ length: 12 }, (_, index) => {
			const line = index + 1;
			return `-${line}|ROW_${line.toString().padStart(2, "0")}=${tail}\n+${line}|ROW_${line.toString().padStart(2, "0")}=changed-${tail}`;
		}).join("\n");
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated long-lines.txt" }],
				details: { diff, op: "update" },
			},
			{ expanded: false, isPartial: false, renderContext: { renderDiff } },
			uiTheme,
			{ file_path: "long-lines.txt" },
		);

		const lines = component.render(120).map(line => Bun.stripANSI(line));
		expect(lines).toHaveLength(43);
		expect(lines.join("\n")).toContain("more lines");
	});

	it("renders completed edit gutters without inherited frame padding", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated demo.ts" }],
				details: {
					diff: "+1│const renamedIdentifier = computeValueFromSomeVeryLongInputName();",
					op: "update",
				},
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "hashline" } },
			uiTheme,
			{ file_path: "demo.ts" },
		);

		const lines = component.render(48).map(line => Bun.stripANSI(line));
		expect(lines.every(line => visibleWidth(line) === 48)).toBe(true);
		expect(lines[1]).toStartWith("│+1│");
		expect(lines[1]).not.toStartWith("│ +1│");
	});

	it("does not leak the first file's no-change preview into a multi-file delete result", async () => {
		const uiTheme = await getUiTheme();
		const paths = ["scripts/a.ts", "scripts/a.user.md", "scripts/a.system.md"];
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: paths.map(p => `Deleted ${p}`).join("\n") }],
				details: {
					diff: "",
					perFileResults: paths.map(path => ({ path, diff: "", op: "delete" as const, oldText: "x\n" })),
				},
			},
			{
				expanded: false,
				isPartial: false,
				renderContext: {
					editMode: "hashline",
					// The streaming preview only ever holds the first file's result; a
					// delete card must not fall back to it (issue: every card showed
					// "No changes would be made to <first file>").
					editDiffPreview: { error: "No changes would be made to scripts/a.ts." },
				},
			},
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("Delete");
		expect(rendered).not.toContain("No changes would be made");
		for (const path of paths) expect(rendered).toContain(path);
	});

	it("renders a move-only result as source → destination with no diff body", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Moved a.ts to b.ts" }],
				details: { diff: "", op: "update", path: "b.ts", move: "b.ts", sourcePath: "a.ts" },
			},
			{
				expanded: false,
				isPartial: false,
				renderContext: {
					editMode: "hashline",
					editDiffPreview: { error: "No changes would be made to other.ts." },
				},
			},
			uiTheme,
			{ input: "[a.ts#1a2b]\nMV b.ts" },
		);

		const header = Bun.stripANSI(component.render(160)[0]);
		// Header shows the move as source → destination, not the buggy dest → dest.
		expect(header).toContain("a.ts");
		expect(header).toContain("b.ts");
		expect(header).toContain("→");
		expect(Bun.stripANSI(component.render(160).join("\n"))).not.toContain("No changes");
	});

	it("uses the result's own path for a genuine no-op, not the shared preview", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "no change" }],
				details: { diff: "", op: "update", path: "scripts/real.ts" },
			},
			{
				expanded: false,
				isPartial: false,
				renderContext: {
					editMode: "hashline",
					editDiffPreview: { error: "No changes would be made to scripts/WRONG.ts." },
				},
			},
			uiTheme,
			{ file_path: "scripts/real.ts" },
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("No changes were made");
		expect(rendered).toContain("scripts/real.ts");
		expect(rendered).not.toContain("WRONG");
	});
});

describe("editToolRenderer diff line wrapping", () => {
	// Renders a completed single-line replacement (`-N|old` + `+N|new`) through
	// the real renderDiff so the result carries its production shapes: a blanked
	// dedup gutter on the `+` row (`   +│`) and intra-line inverse highlights.
	async function renderSingleLineReplacement(
		oldLine: string,
		newLine: string,
		width: number,
	): Promise<readonly string[]> {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated demo.ts" }],
				details: { diff: `-42|${oldLine}\n+42|${newLine}`, op: "update", path: "demo.ts" },
			},
			{ expanded: true, isPartial: false, renderContext: { renderDiff } },
			uiTheme,
			{ file_path: "demo.ts" },
		);
		return component.render(width);
	}

	/** Net SGR inverse state after scanning a row; 38/48 extended-color args must not be misread as attribute 7. */
	function inverseActiveAtRowEnd(row: string): boolean {
		let inverse = false;
		for (const match of row.matchAll(/\x1b\[([0-9;]*)m/g)) {
			const params = match[1].split(";");
			for (let i = 0; i < params.length; i++) {
				const param = params[i];
				if (param === "38" || param === "48") {
					i += params[i + 1] === "2" ? 4 : params[i + 1] === "5" ? 2 : 0;
				} else if (param === "" || param === "0") inverse = false;
				else if (param === "7") inverse = true;
				else if (param === "27") inverse = false;
			}
		}
		return inverse;
	}

	it("keeps added-line continuation rows inside the blanked dedup gutter", async () => {
		// renderDiff blanks the repeated line number on the `+` row of a
		// single-line replacement (`   +│`); the wrapper must still recognize that
		// gutter instead of falling back to generic wrapping at column 0.
		const rows = (
			await renderSingleLineReplacement(
				"    the previous synopsis paragraph rambled across quarterly reconciliation notes enumerating every provisional ledger amendment the archival committee had deferred pending review by the regional custodians during the extended winter recess of the auditing season",
				"    the revised synopsis paragraph now catalogues seasonal festival logistics enumerating lantern shipments drum rehearsals and ribbon inventories that the parade stewards confirmed before dawn, closing with the zephyrQuota tally and the marbledFinale banner",
				100,
			)
		).map(row => Bun.stripANSI(row));

		// The tail of the added line lands on continuation rows, which must carry
		// the spaces-only continuation gutter rather than start as bare prose.
		const tailRows = rows.filter(row => row.includes("zephyrQuota") || row.includes("marbledFinale"));
		expect(tailRows.length).toBeGreaterThanOrEqual(1);
		for (const row of tailRows) expect(row).toMatch(/^│\s+│/);
		// Every body row stays inside a code-frame gutter (`-42│`, `   +│`, `    │`).
		for (const row of rows.slice(1, -1)) expect(row).toMatch(/^│\s*[+-]?\s*\d*│/);
	});

	it("renders ill-formed UTF-16 replacements natively", async () => {
		// Native word diffs operate directly over UTF-16 code units, so lone
		// surrogates render and highlight without throwing mid-render.
		const rows = (await renderSingleLineReplacement("alpha \ud800 beta", "alpha \ud801 beta", 100)).map(row =>
			Bun.stripANSI(row),
		);
		expect(rows.some(row => row.includes("-42"))).toBe(true);
		expect(rows.some(row => row.includes("+"))).toBe(true);
	});

	it("closes inverse video at every wrapped row end so frame padding stays uninverted", async () => {
		// A long contiguous rewritten phrase forces the wrap boundary to land
		// inside an inverse-highlighted span; the frame pads each row with spaces,
		// so any inverse still active at row end paints those cells as gray blocks.
		const previousLevel = chalk.level;
		chalk.level = 3;
		let rows: readonly string[];
		try {
			rows = await renderSingleLineReplacement(
				"    stanza recounts venerable chronicle passages spanning bygone dynasties whose archivists engraved ledgers onto vellum scrolls",
				"    stanza celebrates luminous festival processions winding through lantern boulevards while drummers herald jubilant choruses beneath cascading ribbons and fireworks",
				100,
			);
		} finally {
			chalk.level = previousLevel;
		}

		// Precondition: some continuation row's content reopens with inverse right
		// after its gutter, proving a highlighted span crossed a wrap boundary. If
		// diffWords tokenization ever changes so no span crosses, this fails loudly
		// instead of letting the row-end assertions pass vacuously.
		expect(rows.some(row => /│\x1b\[7m/.test(row))).toBe(true);
		for (const row of rows) expect(inverseActiveAtRowEnd(row)).toBe(false);
	});

	// Error results reuse the same body-line wrapper as diff rows; these tests
	// pin the boundary between prose that merely looks pipe-ish and real gutters.
	async function renderErrorResultRows(errorText: string): Promise<string[]> {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: errorText }],
				details: { diff: "", op: "update", path: "demo.ts" },
				isError: true,
			},
			{ expanded: true, isPartial: false, renderContext: { renderDiff } },
			uiTheme,
			{ file_path: "demo.ts" },
		);
		return component.render(100).map(row => Bun.stripANSI(row));
	}

	it("does not give pipe-leading error text a phantom diff gutter when wrapping", async () => {
		// Error text is not a diff row even when it starts with `|`: an empty
		// gutter must wrap generically, not spawn `|` continuation prefixes.
		const rows = await renderErrorResultRows(
			"| pipe-leading diagnostic output that is quite long and should certainly wrap at the render width because it keeps going on and on with more words than fit in one row of the frame",
		);
		const bodyRows = rows.slice(1, -1);
		// Precondition: the text actually wrapped, and the `|` lead survived on row one.
		expect(bodyRows.length).toBeGreaterThanOrEqual(2);
		expect(bodyRows[0]).toMatch(/^│\| /);
		for (const row of bodyRows.slice(1)) expect(row).not.toMatch(/^│\s*\|/);
	});

	it("wraps spaces-then-bare-pipe error text generically instead of minting a gutter", async () => {
		// A digit-less ASCII "|" gutter never comes out of formatCodeFrameLine or
		// canonical diff rows; indented bare-pipe error text must wrap generically.
		const rows = await renderErrorResultRows(
			"   | indented bare-pipe diagnostic output that is quite long and should certainly wrap at the render width because it keeps going on and on with more words than fit in one row of the frame",
		);
		const bodyRows = rows.slice(1, -1);
		// Precondition: the text actually wrapped, and the pipe lead survived on row one.
		expect(bodyRows.length).toBeGreaterThanOrEqual(2);
		expect(bodyRows[0]).toMatch(/^│\s+\| /);
		for (const row of bodyRows.slice(1)) expect(row).not.toMatch(/^│\s*\|/);
	});

	it("wraps digit-leading pipe error text generically when the marker column is missing", async () => {
		// Canonical ASCII-pipe rows always carry a marker column (`-42|`, ` 42|`);
		// `123|` prose has a digit there instead, so it is not a diff row.
		const rows = await renderErrorResultRows(
			"123| numbered pipe-leading diagnostic output that is quite long and should certainly wrap at the render width because it keeps going on and on with more words than fit in one row of the frame",
		);
		const bodyRows = rows.slice(1, -1);
		// Precondition: the text actually wrapped, and the numbered lead survived on row one.
		expect(bodyRows.length).toBeGreaterThanOrEqual(2);
		expect(bodyRows[0]).toMatch(/^│123\| /);
		for (const row of bodyRows.slice(1)) expect(row).not.toMatch(/^│\s*\|/);
	});
});
