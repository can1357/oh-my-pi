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
	expect(rows).toContain("  └─ Reviewer ⟨failed⟩ – not running");
});

test("default-preset broadcasts run the quote rail into the receipt branches", () => {
	const env = staticEnvironment(loadThemeSync("dark"));
	const call = new ToolCall({
		id: "irc-all",
		name: "write",
		presenter: writePresenter,
		args: { path: "agent://all", content: "Toolchain bug\nKeep proofs admitted" },
	});
	call.setExecutionStarted();
	const receipts = Array.from({ length: 9 }, (_, index) => ({ to: `Fixer${index}`, outcome: "injected" }));
	call.updateResult({ content: [], details: { message: { to: "all", receipts } } }, false);
	const rows = plainToolRows(call, env);
	const row = (text: string): string => rows.find(line => line.includes(text)) ?? "";

	const spine = row("Fixer0").indexOf("├─");
	expect(spine).not.toBe(-1);
	expect(row("Toolchain bug")[spine]).toBe("│");
	expect(row("Keep proofs admitted")[spine]).toBe("│");
	expect(row("1 more recipients").indexOf("└─")).toBe(spine);
});

test("default-preset messages without receipt branches keep the quote border", () => {
	const env = staticEnvironment(loadThemeSync("dark"));
	const call = new ToolCall({
		id: "irc-one",
		name: "write",
		presenter: writePresenter,
		args: { path: "agent://Reviewer", content: "Take a look" },
	});
	call.setExecutionStarted();
	call.updateResult(
		{ content: [], details: { message: { to: "Reviewer", receipts: [{ to: "Reviewer", outcome: "injected" }] } } },
		false,
	);
	expect(plainToolRows(call, env)).toContain("  ▏ Take a look");
});
