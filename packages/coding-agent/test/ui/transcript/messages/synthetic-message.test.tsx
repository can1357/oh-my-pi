/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import { SyntheticMessage } from "../../../../src/ui/transcript/messages/user-message";
import { screenSuite, single } from "./harness";

screenSuite("synthetic-message", corpusCase => {
	const inputs = corpusCase.inputs as { text: string; imageLinks: string[] };
	const expanded = signal(false);
	return {
		node: single(<SyntheticMessage text={inputs.text} imageLinks={inputs.imageLinks} expanded={expanded} />),
		apply(label) {
			if (label === "expanded" || label === "tight ignored, expanded") expanded.set(true);
			else if (label === "collapsed") expanded.set(false);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
