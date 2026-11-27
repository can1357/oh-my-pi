import "../../../src/ui/styles/tools/wait";
import { waitPresenter } from "../../../src/ui/tools/wait";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const waitScreen: ToolScreen = {
	dir: "tools/wait",
	name: "wait",
	presenter: waitPresenter,
};

toolScreenSuite(waitScreen);
