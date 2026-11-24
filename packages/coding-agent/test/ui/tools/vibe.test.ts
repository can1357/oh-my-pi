import "../../../src/ui/styles/tools/vibe";
import {
	vibeKillPresenter,
	vibeListPresenter,
	vibeSendPresenter,
	vibeSpawnPresenter,
	vibeWaitPresenter,
} from "../../../src/ui/tools/vibe";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const vibeSpawnScreen: ToolScreen = {
	dir: "tools/vibe_spawn",
	name: "vibe_spawn",
	presenter: vibeSpawnPresenter,
};
export const vibeSendScreen: ToolScreen = {
	dir: "tools/vibe_send",
	name: "vibe_send",
	presenter: vibeSendPresenter,
};
export const vibeWaitScreen: ToolScreen = {
	dir: "tools/vibe_wait",
	name: "vibe_wait",
	presenter: vibeWaitPresenter,
};
export const vibeKillScreen: ToolScreen = {
	dir: "tools/vibe_kill",
	name: "vibe_kill",
	presenter: vibeKillPresenter,
};
export const vibeListScreen: ToolScreen = {
	dir: "tools/vibe_list",
	name: "vibe_list",
	presenter: vibeListPresenter,
};

toolScreenSuite(vibeSpawnScreen);
toolScreenSuite(vibeSendScreen);
toolScreenSuite(vibeWaitScreen);
toolScreenSuite(vibeKillScreen);
toolScreenSuite(vibeListScreen);
