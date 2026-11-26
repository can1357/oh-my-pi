/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import type { LateDiagnosticsFile } from "../../../../src/session/transcript/late-diagnostics-message";
import { LateDiagnostics } from "../../../../src/ui/transcript/messages/late-diagnostics";
import { screenSuite, single } from "./harness";

screenSuite("late-diagnostics", corpusCase => {
	const inputs = corpusCase.inputs as { files: LateDiagnosticsFile[] };
	const expanded = signal(false);
	const visible = signal(true);
	return {
		node: single(<LateDiagnostics files={inputs.files} expanded={expanded} visible={visible} />),
		apply(label) {
			if (label === "expanded") expanded.set(true);
			else if (label === "collapsed") expanded.set(false);
			else if (label === "tool activity hidden") visible.set(false);
			else if (label === "tool activity shown") visible.set(true);
			else throw new Error(`unknown stage ${label}`);
		},
	};
});
