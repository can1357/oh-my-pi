import type { AgentSession } from "../../session/agent-session";
import {
	cfgComputerDisplay,
	cfgComputerEnabled,
	cfgComputerMaxHeight,
	cfgComputerMaxWidth,
	cfgComputerTakeover,
} from "../../tools/settings";

/** Fast-tier selection and effective computer-use settings shown by `/session info`. */
export function sessionModeRows(session: AgentSession): [label: string, value: string][] {
	const settings = session.settings;
	const fast = session.isUltrafastModeEnabled()
		? "Ultrafast"
		: session.isFastModeEnabled()
			? "Fast (priority)"
			: "off";
	const computerEnabled = cfgComputerEnabled.get(settings);
	const computerActive = session.getEvalPreludes().some(definition => definition.name === "computer");
	return [
		["Fast tier", fast],
		["Computer use", computerEnabled ? "enabled" : "disabled"],
		["Computer prelude", computerActive ? "active" : "inactive"],
		[
			"Computer settings",
			`display=${cfgComputerDisplay.get(settings)}, maxWidth=${cfgComputerMaxWidth.get(settings)}, maxHeight=${cfgComputerMaxHeight.get(settings)}, takeover=${cfgComputerTakeover.get(settings)}`,
		],
	];
}
