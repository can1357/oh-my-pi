import { astEditPresenter } from "../../../src/ui/tools/ast-edit";
import { type ToolScreen, toolScreenSuite } from "./screens";

/** The corpus records the old renderer's `inline` ("no background box"), which never framed the transcript block. */
export const astEditScreen: ToolScreen = {
	dir: "tools/ast_edit",
	name: "ast_edit",
	presenter: { ...astEditPresenter, inline: true },
};

toolScreenSuite(astEditScreen);
