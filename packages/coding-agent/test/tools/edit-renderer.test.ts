import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InMemorySnapshotStore } from "@pk-nerdsaver-ai/hashline";
import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { renderGalleryState, resolveFixture } from "@pk-nerdsaver-ai/pi-coding-agent/cli/gallery-cli";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { editToolRenderer } from "@pk-nerdsaver-ai/pi-coding-agent/edit/renderer";
import { ToolExecutionComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/tool-execution";
import * as themeModule from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { Text, type TUI, visibleWidth } from "@pk-nerdsaver-ai/pi-tui";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const theme = await themeModule.getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
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
				edits: [{}],
				__partialJson: '{"edits":[{"path":"packages/coding-agent/src/edit/renderer.ts","old_text":"before',
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
	});

	it("lifts the streaming diff tail window when expanded", async () => {
		const uiTheme = await getUiTheme();
		const diff = Array.from({ length: 20 }, (_, index) =>
			index === 0 ? "-head-line-1" : `+tail-line-${index + 1}`,
		).join("\n");
		const renderPreview = (expanded: boolean): string =>
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

		const collapsed = renderPreview(false);
		expect(collapsed).toContain("tail-line-20");
		expect(collapsed).not.toContain("head-line-1");
		expect(collapsed).toContain("more lines above");
		expect(collapsed).toContain("(preview)");

		const expanded = renderPreview(true);
		expect(expanded).toContain("head-line-1");
		expect(expanded).toContain("tail-line-20");
		expect(expanded).not.toContain("more lines above");
		expect(expanded).not.toContain("(preview)");
	});

	it("uses hashline input headers for streaming call path without apply_patch errors", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{
				input: "[packages/coding-agent/src/edit/renderer.ts]\nINS.TAIL:\n+// preview",
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain("The first line of the patch must be");
	});

	it("shows hashline envelope target path while preview diff is not computable yet", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{
				input: [
					"*** Begin Patch",
					"[crates/pi-natives/src/shell.rs]",
					"INS.TAIL:",
					"+pub fn streaming_preview() {",
				].join("\n"),
			},
			{},
			hashlineTool,
			uiStub,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("crates/pi-natives/src/shell.rs");
		expect(rendered).not.toContain("INS.TAIL:");
		expect(rendered).not.toContain("+pub fn streaming_preview() {");
		expect(rendered).not.toContain("*** Begin Patch");
	});

	it("recognizes compact and quoted hashline input headers", async () => {
		const uiTheme = await getUiTheme();
		const compactComponent = editToolRenderer.renderCall(
			{
				input: "[foo bar.ts]\nINS.HEAD:\n+// preview",
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const quotedComponent = editToolRenderer.renderCall(
			{
				input: "['baz qux.ts']\nINS.HEAD:\n+// preview",
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
				input: "[packages/coding-agent/src/slash-commands/builtin-registry.ts]\nINS.HEAD:\n+// preview",
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		// While streaming, the closing bracket may not have arrived yet.
		const partial = editToolRenderer.renderCall(
			{ input: "[a/b/c.ts\nINS.HEAD:\n+// preview" },
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
				input: "[packages/coding-agent/src/edit/renderer.ts]\nINS.TAIL:\n+// preview",
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
			uiTheme,
			{ file_path: "src/example.ts" },
		);

		component.render(160);
		component.render(120);
		expect(renderDiffCalls).toBe(1);

		options.expanded = true;
		component.render(120);
		expect(renderDiffCalls).toBe(2);
	});

	it("computes the hashline preview diff once a single-line edit finishes streaming", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {} } as unknown as TUI;
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
			const input = `[memory.ts#${tag}]\nSWAP 2.=2:\n+export const b = 22;`;
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
		const uiStub = { requestRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-custom-stream-preview-"));
		try {
			const content = "export const a = 1;\nexport const b = 2;\n";
			const filePath = path.join(tmpDir, "memory.ts");
			await Bun.write(filePath, content);

			const snapshots = new InMemorySnapshotStore();
			const tag = snapshots.record(filePath, content);
			const input = `[memory.ts#${tag}]\nSWAP 2.=2:\n+export const b = 22;\n`;
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
		const uiStub = { requestRender() {} } as unknown as TUI;
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
		const uiStub = { requestRender() {} } as unknown as TUI;
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

	it("renders the delete gallery fixture as a Delete card without a no-change body", async () => {
		await getUiTheme();
		const text = (await renderGalleryState("edit_delete", resolveFixture("edit_delete"), "success", 160))
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(text).toContain("Delete");
		expect(text).toContain("scripts/prune-changelogs.ts");
		expect(text).not.toContain("No changes");
	});

	it("renders the move gallery fixture as source → destination", async () => {
		await getUiTheme();
		const text = (await renderGalleryState("edit_move", resolveFixture("edit_move"), "success", 160))
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(text).toContain("scripts/prune-changelogs.ts");
		expect(text).toContain("scripts/archived/prune-changelogs.ts");
		expect(text).toContain("→");
		expect(text).not.toContain("No changes");
	});
});
