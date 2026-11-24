import "../../../src/ui/styles/tools/think";
import type { ToolPresenter } from "../../../src/ui/tools/contract";
import { type ThinkArgs, thinkPresenter } from "../../../src/ui/tools/think";
import { type ToolScreen, toolScreenSuite } from "./screens";

// The screen capture never told the renderer whether args were still streaming
// (`argsComplete` unset reads as complete); the transcript flows record the streaming state.
const capturePresenter: ToolPresenter<ThinkArgs> = {
	...thinkPresenter,
	call: (args, state) => thinkPresenter.call!(args, { ...state, argsComplete: true }),
};

export const thinkScreen: ToolScreen = {
	dir: "tools/think",
	name: "think",
	presenter: capturePresenter,
};

toolScreenSuite(thinkScreen);
