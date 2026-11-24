import { askPresenter } from "../../../src/ui/tools/ask";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const askScreen: ToolScreen = {
	dir: "tools/ask",
	name: "ask",
	presenter: askPresenter,
};

toolScreenSuite(askScreen);
