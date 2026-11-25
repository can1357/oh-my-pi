import { expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "../../../src/ui/styles/tools/yield";
import { yieldPresenter } from "../../../src/ui/tools/yield";
import { ToolCall } from "../../../src/ui/transcript/tool-block";
import { plainToolRows, type ToolScreen, toolScreenSuite } from "./screens";

export const yieldScreen: ToolScreen = {
	dir: "tools/yield",
	name: "yield",
	presenter: yieldPresenter,
};

toolScreenSuite(yieldScreen);

test("JSON tool arguments use the preset's hooks and bullets with aligned root entries", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const call = new ToolCall({
		id: "yield-1",
		name: "yield",
		presenter: yieldPresenter,
		args: { data: { value: 42, ready: true } },
	});
	const rows = plainToolRows(call, env);
	expect(rows).toContain(" `- * value: 42");
	expect(rows).toContain("    * ready: true");
});
