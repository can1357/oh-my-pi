import { expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { type BashArgs, bashPresenter, shellPresenter } from "../../../src/ui/tools/bash";
import { ToolCall } from "../../../src/ui/transcript/tool-block";
import { plainToolRows, type ToolScreen, toolScreenSuite } from "./screens";

export const bashScreen: ToolScreen = {
	dir: "tools/bash",
	name: "bash",
	presenter: bashPresenter,
};

/** The corpus drove a shell renderer titled "Shell" whose command is `args.cmd`. */
export const shellScreen: ToolScreen = {
	dir: "tools/shell",
	name: "shell",
	presenter: shellPresenter<{ cmd?: string }>({
		title: () => "Shell",
		command: args => args?.cmd,
		header: true,
	}),
};

toolScreenSuite(bashScreen);
toolScreenSuite(shellScreen);

test("service results paint the preset's compact PID marker in the footer", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "nerd" }));
	const call = new ToolCall({
		id: "bash-1",
		name: "bash",
		presenter: bashPresenter,
		args: { name: "web", command: "echo ready" },
	});
	call.setExecutionStarted();
	call.updateResult(
		{
			content: [{ type: "text", text: "listening" }],
			details: { service: { name: "web", state: "ready", ready: true, timedOut: false, pid: 51234 } },
		},
		false,
	);
	expect(plainToolRows(call, env).findLast(Boolean)).toContain("51234");
});

export type { BashArgs };
