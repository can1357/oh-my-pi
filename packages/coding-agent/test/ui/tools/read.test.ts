import { readPresenter } from "../../../src/ui/tools/read";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const readScreen: ToolScreen = {
	dir: "tools/read",
	name: "read",
	presenter: readPresenter,
};

toolScreenSuite(readScreen);
