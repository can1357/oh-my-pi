/** The transcript browser (`col` `omp.transcript.browser`): the frame its model lays out (see `TranscriptBrowserModel`). */
import { defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import type { BrowserTerm } from "../../transcript/figures/browser";
import { termOf } from "../messages/fill";

defineRolePainter("col", "omp.transcript.browser", (node, cx) => {
	const browser = termOf<BrowserTerm>(node).browser;
	return browser ? { rows: browser.paint(cx.width, cx.theme) } : EMPTY_BLOCK;
});
