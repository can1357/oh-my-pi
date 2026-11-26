import { expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "../../../src/ui/styles/tools/write";
import type { ToolPresenter } from "../../../src/ui/tools/contract";
import { type WriteArgs, type WriteDetails, writePresenter } from "../../../src/ui/tools/write";
import { ToolCall } from "../../../src/ui/transcript/tool-block";
import { plainToolRows, type ToolScreen, toolScreenSuite } from "./screens";

// The screen capture fed the call a spinner frame until "spinner stopped", even after
// the args completed; the transcript spins the head only while args stream.
const capturePresenter: ToolPresenter<WriteArgs, WriteDetails> = {
	...writePresenter,
	call(args, state) {
		const view = writePresenter.call!(args, state);
		return view?.term?.call ? { ...view, term: { ...view.term, spinning: true } } : view;
	},
};

export const writeScreen: ToolScreen = {
	dir: "tools/write",
	name: "write",
	presenter: capturePresenter,
};

toolScreenSuite(writeScreen);

test("IRC writes paint the preset's direction arrow, receipt badge and error separator", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "nerd" }));
	const call = new ToolCall({
		id: "irc-1",
		name: "write",
		presenter: writePresenter,
		args: { path: "agent://Reviewer", content: "Take a look" },
	});
	call.setExecutionStarted();
	call.updateResult(
		{
			content: [],
			details: {
				message: { to: "Reviewer", receipts: [{ to: "Reviewer", outcome: "failed", error: "not running" }] },
			},
		},
		false,
	);
	const rows = plainToolRows(call, env);
	expect(rows).toContain(" IRC  Reviewer failed");
	expect(rows).toContain("└─ Reviewer ⟨failed⟩ – not running");
});
