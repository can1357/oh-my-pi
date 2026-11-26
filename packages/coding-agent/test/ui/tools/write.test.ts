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

// Receipts of a bridged peer's transport are bridge-controlled input: its id and error must not
// inject terminal escapes, extra rows (newlines, U+2028/U+2029) or lone surrogates into the call.
test("a bridged peer's receipt id and error render sanitized, one row each", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "nerd" }));
	const call = new ToolCall({
		id: "irc-2",
		name: "write",
		presenter: writePresenter,
		args: { path: "agent://all", content: "heads up" },
	});
	call.setExecutionStarted();
	call.updateResult(
		{
			content: [],
			details: {
				message: {
					to: "all",
					receipts: [
						{ to: "AuthLoader", outcome: "woken" },
						{
							to: "@cluster/e\tvil\u2028name",
							outcome: "failed",
							error: "\x1b[2Jboom\nINJECTED\u2029tail\ud800",
						},
					],
				},
			},
		},
		false,
	);
	const rows = plainToolRows(call, env);
	expect(rows.join("\n")).not.toMatch(/[\u2028\u2029\ud800]|\[2J/u);
	expect(rows.some(row => row.includes("@cluster/e vil name") && row.includes("boom INJECTED tail"))).toBe(true);
	expect(rows.some(row => row.trimStart().startsWith("INJECTED"))).toBe(false);
});
