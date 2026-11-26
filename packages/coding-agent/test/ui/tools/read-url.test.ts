import { readUrlPresenter } from "../../../src/ui/tools/read-url";
import { type ToolScreen, toolScreenSuite } from "./screens";

/** The corpus drove the URL-read renderer directly (no `read` dispatch): no merge, no frameless default. */
export const readUrlScreen: ToolScreen = {
	dir: "tools/read-url",
	name: "read",
	presenter: readUrlPresenter,
};

toolScreenSuite(readUrlScreen);
