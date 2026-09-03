import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import type { TUI } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
		if (rendered.includes(expectedText)) {
			return rendered;
		}
		await Bun.sleep(10);
	}
	return rendered;
}

beforeEach(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("apply_patch rendering", () => {
	it("registers apply_patch to use the edit renderer", () => {
		expect(toolRenderers.apply_patch).toBe(toolRenderers.edit);
	});

	it("renders apply_patch results through edit UI instead of generic fallback", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"apply_patch",
			{
				input: "*** Begin Patch\n*** Update File: src/demo.ts\n@@\n-old\n+new\n*** End Patch",
			},
			{},
			undefined,
			uiStub,
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					path: "src/demo.ts",
					op: "update",
					diff: "@@\n-old\n+new",
				},
			},
			false,
		);

		const rendered = Bun.stripANSI(component.render(140).join("\n"));
		expect(rendered).toContain("src/demo.ts");
		expect(rendered).toContain("+new");
		expect(rendered).not.toContain("(no output)");
	});

	it("derives call path, operation, and file-count hints from apply_patch input", async () => {
		const uiTheme = await getUiTheme();
		const input = [
			"*** Begin Patch",
			"*** Update File: src/first.ts",
			"@@",
			"-before",
			"+after",
			"*** Add File: src/new.ts",
			"+hello",
			"*** End Patch",
		].join("\n");

		const component = toolRenderers.apply_patch.renderCall({ input }, { expanded: false, isPartial: true }, uiTheme);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(rendered).toContain("src/first.ts");
		expect(rendered).toContain("Edit");
		expect(rendered).toContain("(+1 more)");
	});

	it("does not show missing end-marker errors while apply_patch input is streaming", async () => {
		const uiTheme = await getUiTheme();
		const input = ["*** Begin Patch", "*** Update File: src/streaming.ts", "@@", "-before", "+after"].join("\n");

		const component = toolRenderers.apply_patch.renderCall({ input }, { expanded: false, isPartial: true }, uiTheme);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(rendered).toContain("src/streaming.ts");
		expect(rendered).not.toContain("The last line of the patch must be");
	});

	it("shows an apply_patch parse error preview for malformed input", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const malformedInput = ["*** Begin Patch", "*** Update File: src/bad.ts", "*** End Patch"].join("\n");

		const component = new ToolExecutionComponent("apply_patch", { input: malformedInput }, {}, undefined, uiStub);
		component.updateStreamPreview({
			generation: 1,
			streaming: false,
			files: [{ path: "", error: "Line 3: Update file hunk for path 'src/bad.ts' is empty" }],
		});
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(rendered).toContain("src/bad.ts");
		expect(rendered).toContain("is empty");
	});

	it("shows apply_patch preview diffs after args complete", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apply-patch-preview-"));
		try {
			await Bun.write(path.join(tmpDir, "preview.ts"), "const value = 1;\n");
			const input = [
				"*** Begin Patch",
				"*** Update File: preview.ts",
				"@@",
				"-const value = 1;",
				"+const value = 2;",
				"*** End Patch",
			].join("\n");

			const component = new ToolExecutionComponent("apply_patch", { input }, {}, undefined, uiStub, tmpDir);
			const before = Bun.stripANSI(component.render(160).join("\n"));
			expect(before).not.toContain("(preview)");

			component.updateStreamPreview({
				generation: 1,
				streaming: false,
				files: [
					{
						path: "preview.ts",
						diff: " 1|const value = 1;\n-1|const value = 1;\n+1|const value = 2;",
						firstChangedLine: 1,
					},
				],
			});
			component.setArgsComplete();
			const after = Bun.stripANSI(component.render(160).join("\n"));
			expect(after).toContain("(preview)");
			expect(after).toContain("const value = 2;");
		} finally {
			await removeWithRetries(tmpDir);
		}
	});

	it("refreshes streaming preview immediately on arg updates without scheduling a debounce", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apply-patch-instant-preview-"));
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			await Bun.write(path.join(tmpDir, "preview.ts"), "const value = 1;\n");
			const component = new ToolExecutionComponent("apply_patch", { input: "" }, {}, undefined, uiStub, tmpDir);

			setTimeoutSpy.mockClear();
			component.updateArgs({
				input: [
					"*** Begin Patch",
					"*** Update File: preview.ts",
					"@@",
					"-const value = 1;",
					"+const value = 2;",
					"*** End Patch",
				].join("\n"),
			});

			expect(setTimeoutSpy).not.toHaveBeenCalled();
		} finally {
			setTimeoutSpy.mockRestore();
			await removeWithRetries(tmpDir);
		}
	});

	it("aligns rendered edit diff separators", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"edit",
			{ path: "packages/coding-agent/src/tools/image-gen.ts" },
			{},
			undefined,
			uiStub,
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					path: "packages/coding-agent/src/tools/image-gen.ts",
					op: "update",
					diff: [
						" 10|}",
						'+11|import { CODEX_INSTRUCTIONS } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";',
						" 12|\t$env,",
						" 228|\toutput_format: typeof OPENAI_IMAGE_OUTPUT_FORMAT;",
						"+235|\tinstructions?: string;",
						' 234|\tinput: Array<{ role: "user"; content: OpenAIInputContent[] }>;',
					].join("\n"),
				},
			},
			false,
		);

		const rendered = Bun.stripANSI(component.render(220).join("\n"));
		expect(rendered).toContain("  10│}");
		expect(rendered).toContain(" +11│import");
		expect(rendered).toContain(" 228│");
		expect(rendered).toContain("+235│");
		expect(rendered).toContain(" 234│");
	});
});
