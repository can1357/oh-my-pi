/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import { SkillMessage, type SkillMessageProps } from "../../../../src/ui/transcript/messages/skill-message";
import { screenSuite, single } from "./harness";

screenSuite("skill-message", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: {
			content: SkillMessageProps["content"];
			details?: SkillMessageProps["details"];
		};
		imageLinks: string[];
	};
	const expanded = signal(false);
	return {
		node: single(
			<SkillMessage
				content={inputs.message.content}
				details={inputs.message.details}
				imageLinks={inputs.imageLinks}
				expanded={expanded}
			/>,
		),
		apply(label) {
			// `pending` holds an optimistic row live; it expands first and changes nothing visible.
			if (label === "expanded" || label === "pending") expanded.set(true);
			else if (label === "collapsed") expanded.set(false);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
