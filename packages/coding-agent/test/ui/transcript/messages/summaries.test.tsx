/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import {
	BranchSummaryBlock,
	type CompactionSummary,
	CompactionSummaryBlock,
	HandoffSummaryBlock,
} from "../../../../src/ui/transcript/messages/summaries";
import { screenSuite, single } from "./harness";

function toggled(expanded: { set(value: boolean): void }, label: string): void {
	if (label === "expanded") expanded.set(true);
	else if (label === "collapsed") expanded.set(false);
	else throw new Error(`unknown stage ${label}`);
}

screenSuite("compaction-summary", corpusCase => {
	const inputs = corpusCase.inputs as { message: CompactionSummary };
	const expanded = signal(false);
	return {
		node: single(<CompactionSummaryBlock message={inputs.message} expanded={expanded} />),
		apply: label => toggled(expanded, label),
	};
});

screenSuite("handoff-summary", corpusCase => {
	// The capture created the block expanded (its `display` flag).
	const inputs = corpusCase.inputs as {
		message: { content: string | { type: string; text?: string }[] };
		display: boolean;
	};
	const expanded = signal(inputs.display);
	return {
		node: single(<HandoffSummaryBlock content={inputs.message.content} expanded={expanded} />),
		apply: label => toggled(expanded, label),
	};
});

screenSuite("branch-summary", corpusCase => {
	const inputs = corpusCase.inputs as { message: { summary: string } };
	const expanded = signal(false);
	return {
		node: single(<BranchSummaryBlock summary={inputs.message.summary} expanded={expanded} />),
		apply: label => toggled(expanded, label),
	};
});
