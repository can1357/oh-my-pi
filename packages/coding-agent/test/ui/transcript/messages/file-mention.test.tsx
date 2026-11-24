/** @jsxImportSource @oh-my-pi/pi-tui */
import { FileMentions, type MentionedFile } from "../../../../src/ui/transcript/messages/file-mention";
import { screenSuite, single } from "./harness";

screenSuite("file-mention", corpusCase => {
	const inputs = corpusCase.inputs as {
		files: MentionedFile[];
		indent: number;
	};
	return {
		node: single(<FileMentions files={inputs.files} indent={inputs.indent} />),
	};
});
