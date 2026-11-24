import "../../../src/ui/styles/tools/todo";
import { todoPresenter } from "../../../src/ui/tools/todo";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const todoScreen: ToolScreen = {
	dir: "tools/todo",
	name: "todo",
	presenter: todoPresenter,
	/** The capture drove the completion strike by spinner frame. */
	frames: {
		"strike frame 0": 0,
		"strike frame 5": 5,
		"strike frame 14": 14,
		"strike done": undefined,
	},
};

toolScreenSuite(todoScreen);
