import { expect, test } from "bun:test";
import { createRoot } from "@oh-my-pi/pi-tui";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { CORPUS_NOW, corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import "../../../src/ui/styles/tools/lsp";
import { type LspArgs, lspPresenter } from "../../../src/ui/tools/lsp";
import { toolNode, toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("lsp", "lsp", lspPresenter);

function paintCall(args: LspArgs): readonly string[] {
	const env = corpusEnvironment("dark");
	env.setNow(CORPUS_NOW);
	const state = { expanded: false, isPartial: false, argsComplete: true, executionStarted: false };
	return createRoot(dispose => {
		try {
			return paintNode(env, toolNode("lsp", lspPresenter.call?.(args, state), [], "pending", state), 80).rows;
		} finally {
			dispose();
		}
	});
}

// Models emit `null` for unused optional args; issue #20663 crashed the TUI painting `new_name: null`.
test("null optional args paint like omitted ones", () => {
	const omitted = paintCall({ action: "references", file: "a.ts", symbol: "foo" });
	expect(paintCall({ action: "references", file: "a.ts", symbol: "foo", line: null, new_name: null })).toEqual(
		omitted,
	);
});
