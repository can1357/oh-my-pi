/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import type { AdvisorMessageDetails } from "../../../../src/session/transcript/messages";
import { AdvisorMessage } from "../../../../src/ui/transcript/messages/advisor-message";
import { screenSuite, single } from "./harness";

screenSuite("advisor-message", corpusCase => {
	const inputs = corpusCase.inputs as {
		details: AdvisorMessageDetails;
		globalExpanded: boolean;
	};
	const global = signal(inputs.globalExpanded);
	const node = single(<AdvisorMessage details={inputs.details} expanded={global} />);
	const toggle = (collapsed: boolean): void =>
		node.handlers.onToggle?.(collapsed, { type: "toggle", key: "", collapsed });
	return {
		node,
		apply(label) {
			if (label === "global expanded") global.set(true);
			else if (label === "global collapsed") global.set(false);
			else if (label === "native toggle collapsed") toggle(true);
			else if (label === "native toggle expanded") toggle(false);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
