import { type BashArgs, bashPresenter, shellPresenter } from "../../../src/ui/tools/bash";
import { type ToolScreen, toolScreenSuite } from "./screens";

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

export type { BashArgs };
