import { afterEach, expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { getKeybindings, KeybindingsManager, setKeybindings } from "../../../src/config/keybindings/keybindings";
import { defaultPresenter } from "../../../src/ui/tools/default";
import type { ToolResult } from "../../../src/ui/tools/contract";
import { ToolCall } from "../../../src/ui/transcript/tool-block";
import { plainToolRows, type ToolCaseInputs, type ToolScreen, toolScreenSuite } from "./screens";

/** The corpus drove the generic card with `{ label, args }` and a `{ skipped }` result flag. */
interface DefaultInput {
	readonly label: string;
	readonly args: unknown;
}

export const defaultScreen: ToolScreen = {
	dir: "tools/default",
	name: "mystery_tool",
	presenter: defaultPresenter,
	adapter: {
		args: (inputs: ToolCaseInputs) => (inputs.args as DefaultInput).args,
		result: (inputs: ToolCaseInputs): ToolResult | undefined => inputs.result,
		renderContext: (inputs: ToolCaseInputs) => ({
			label: (inputs.args as DefaultInput).label,
		}),
	},
};

toolScreenSuite(defaultScreen);

const originalBindings = getKeybindings();
afterEach(() => setKeybindings(originalBindings));

test("generic card rows use the preset's branch and advertise the rebound expand key", () => {
	setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "f9" }));
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const call = new ToolCall({
		id: "custom-1",
		name: "custom",
		presenter: defaultPresenter,
		args: { query: "weather" },
	});
	expect(plainToolRows(call, env)).toContain(`  '- query="weather"`);
	call.setExecutionStarted();
	call.updateResult({ content: [{ type: "text", text: "Light rain" }] }, false);
	expect(plainToolRows(call, env)).toContain(" [F9: Expand]");
});
