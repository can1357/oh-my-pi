/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, expect, test } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { getKeybindings, KeybindingsManager, setKeybindings } from "../../../../src/config/keybindings/keybindings";
import { setKeyHintPlatform } from "@oh-my-pi/pi-tui/theme/keys";
import {
	BranchSummaryBlock,
	type CompactionSummary,
	CompactionSummaryBlock,
	HandoffSummaryBlock,
} from "../../../../src/ui/transcript/messages/summaries";
import { screenSuite, single } from "./harness";

let originalBindings: KeybindingsManager | undefined;
afterEach(() => {
	if (originalBindings) setKeybindings(originalBindings);
	originalBindings = undefined;
	setKeyHintPlatform(undefined);
});

test("a summary divider shows the rebound expand key in the painter's preset", () => {
	originalBindings = getKeybindings();
	setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "alt+x" }));
	setKeyHintPlatform("darwin");
	const node = single(<BranchSummaryBlock summary="Changes on the branch" expanded={false} />);
	for (const symbolPreset of ["ascii", "nerd"] as const) {
		const theme = loadThemeSync("dark", { symbolPreset });
		const rows = paintNode(staticEnvironment(theme), node, 80).rows.map(stripEscapes);
		const key = symbolPreset === "ascii" ? "Option+X" : `${theme.symbols.symbol("key.altMac")} X`;
		expect(rows.find(row => row.includes("branch"))).toContain(`${theme.symbols.symbol("sep.dot").trim()} ${key}`);
	}
});

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
