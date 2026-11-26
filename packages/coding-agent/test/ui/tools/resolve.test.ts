import { expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "../../../src/ui/styles/tools/resolve";
import { rejectToolPresenter, resolveToolPresenter } from "../../../src/ui/tools/resolve";
import { ToolCall } from "../../../src/ui/transcript/tool-block";
import { plainToolRows, type ToolScreen, toolScreenSuite } from "./screens";

export const resolveScreen: ToolScreen = {
	dir: "tools/resolve",
	name: "resolve",
	presenter: resolveToolPresenter,
};
export const rejectScreen: ToolScreen = {
	dir: "tools/reject",
	name: "reject",
	presenter: rejectToolPresenter,
};

toolScreenSuite(resolveScreen);
toolScreenSuite(rejectScreen);

test("a resolution banner uses the preset's outcome glyph and source badge", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const call = new ToolCall({ id: "resolve-1", name: "resolve", presenter: resolveToolPresenter, args: {} });
	call.setExecutionStarted();
	const content = [{ type: "text", text: "" }];
	call.updateResult({ content, details: { label: "edit: tokenizer", action: "apply" } }, false);
	expect(plainToolRows(call, env)).toContain(" [v] Accept: tokenizer [edit]");
	call.updateResult({ content, details: { label: "edit: tokenizer", action: "discard" } }, false);
	expect(plainToolRows(call, env)).toContain(" [-] Discard: tokenizer [edit]");
});
