import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolCall } from "../../src/ui/transcript/tool-block";
import { toolCallText, toolText } from "../helpers/tool-text";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

beforeEach(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => {
	resetSettingsForTest();
});

/** An apply_patch call whose input is still streaming (args incomplete). */
function streamingCall(input: string): ToolCall {
	return new ToolCall({ id: "call-1", name: "apply_patch", args: { input } });
}

describe("apply_patch rendering", () => {
	it("renders apply_patch results through edit UI instead of generic fallback", () => {
		const rendered = toolText({
			name: "apply_patch",
			args: { input: "*** Begin Patch\n*** Update File: src/demo.ts\n@@\n-old\n+new\n*** End Patch" },
			result: {
				content: [{ type: "text", text: "" }],
				details: { path: "src/demo.ts", op: "update", diff: "@@\n-old\n+new" },
			},
			width: 140,
		});
		expect(rendered).toContain("src/demo.ts");
		expect(rendered).toContain("+new");
		expect(rendered).not.toContain("(no output)");
	});

	it("derives call path, operation, and file-count hints from apply_patch input", () => {
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

		const rendered = toolCallText(streamingCall(input), 160);
		expect(rendered).toContain("src/first.ts");
		expect(rendered).toContain("Edit");
		expect(rendered).toContain("(+1 more)");
	});

	it("does not show missing end-marker errors while apply_patch input is streaming", () => {
		const input = ["*** Begin Patch", "*** Update File: src/streaming.ts", "@@", "-before", "+after"].join("\n");

		const rendered = toolCallText(streamingCall(input), 160);
		expect(rendered).toContain("src/streaming.ts");
		expect(rendered).not.toContain("The last line of the patch must be");
	});

	it("shows an apply_patch parse error preview for malformed input", () => {
		const call = streamingCall(["*** Begin Patch", "*** Update File: src/bad.ts", "*** End Patch"].join("\n"));
		call.updateStreamPreview({
			generation: 1,
			streaming: false,
			files: [{ path: "", error: "Line 3: Update file hunk for path 'src/bad.ts' is empty" }],
		});

		const rendered = toolCallText(call, 160);
		expect(rendered).toContain("src/bad.ts");
		expect(rendered).toContain("is empty");
	});

	it("shows apply_patch preview diffs after args complete", () => {
		const input = [
			"*** Begin Patch",
			"*** Update File: preview.ts",
			"@@",
			"-const value = 1;",
			"+const value = 2;",
			"*** End Patch",
		].join("\n");
		const call = streamingCall(input);
		// The card's bottom rule, where the preview label sits.
		const bottomRule = (text: string): string => text.split("\n").findLast(line => line.includes("╰")) ?? "";
		const before = toolCallText(call, 160);
		expect(bottomRule(before)).not.toContain(" preview ");
		expect(before).not.toContain("const value = 2;");

		call.updateStreamPreview({
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
		call.setArgsComplete();
		const after = toolCallText(call, 160);
		expect(bottomRule(after)).toContain(" preview ");
		expect(after).toContain("const value = 2;");
	});

	it("aligns rendered edit diff separators", () => {
		const rendered = toolText({
			name: "edit",
			args: { path: "packages/coding-agent/src/tools/image-gen.ts" },
			result: {
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
			width: 220,
		});
		expect(rendered).toContain("  10│}");
		expect(rendered).toContain(" +11│import");
		expect(rendered).toContain(" 228│");
		expect(rendered).toContain("+235│");
		expect(rendered).toContain(" 234│");
	});
});
