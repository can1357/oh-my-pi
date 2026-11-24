import "../../../src/ui/styles/tools/yield";
import { yieldPresenter } from "../../../src/ui/tools/yield";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const yieldScreen: ToolScreen = {
	dir: "tools/yield",
	name: "yield",
	presenter: yieldPresenter,
};

toolScreenSuite(yieldScreen);
