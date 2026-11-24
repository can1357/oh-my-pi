import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/eval";
import { ToolCall } from "../../src/ui/transcript/tool-block";
import { toolCallText, toolText } from "../helpers/tool-text";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/** An expanded eval card whose args are still streaming. */
function pendingText(code: string): string {
	const call = new ToolCall({ id: "call-1", name: "eval", args: { language: "js", code } });
	call.setExpanded(true);
	return toolCallText(call, 120);
}

describe("eval renderer: display-only streaming formatting", () => {
	const source = "if (ready) {run();finish();}";

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("preserves percent command package identifiers instead of formatting them as JavaScript operators", () => {
		const command = "%bun add csv-parse@5";
		expect(pendingText(command)).toContain(command);
	});

	it("expands compact source in both pending and completed previews", () => {
		const pending = pendingText(source);
		const details: EvalToolDetails = {
			language: "js",
			languages: ["js"],
			cells: [{ index: 0, code: source, language: "js", output: "", status: "complete" }],
		};
		const completed = toolText({
			name: "eval",
			args: { language: "js", code: source },
			result: { content: [{ type: "text", text: "" }], details },
			expanded: true,
		});

		for (const rendered of [pending, completed]) {
			expect(rendered).toContain("run();");
			expect(rendered).toContain("finish();");
			expect(rendered).not.toContain("run();finish();");
		}
	});
});
