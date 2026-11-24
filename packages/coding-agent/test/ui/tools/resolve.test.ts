import "../../../src/ui/styles/tools/resolve";
import { rejectToolPresenter, resolveToolPresenter } from "../../../src/ui/tools/resolve";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const resolveScreen: ToolScreen = {
	dir: "tools/resolve",
	name: "resolve",
	presenter: resolveToolPresenter,
};
export const rejectScreen: ToolScreen = {
	dir: "tools/reject",
	name: "reject",
	presenter: rejectToolPresenter,
};

toolScreenSuite(resolveScreen);
toolScreenSuite(rejectScreen);
