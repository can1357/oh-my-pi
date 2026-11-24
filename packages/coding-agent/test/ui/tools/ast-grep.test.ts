import { astGrepPresenter } from "../../../src/ui/tools/ast-grep";
import { type ToolScreen, toolScreenSuite } from "./screens";

/** The corpus records the old renderer's `inline` ("no background box"), which never framed the transcript block. */
export const astGrepScreen: ToolScreen = {
	dir: "tools/ast_grep",
	name: "ast_grep",
	presenter: { ...astGrepPresenter, inline: true },
};

toolScreenSuite(astGrepScreen);
