/**
 * Plain-text terminal rows of transcript blocks, for controller tests that assert what a block
 * shows. Paints each block's node statically (dark theme, clock at 0) with every transcript look
 * registered.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { Shell, TranscriptBlock } from "../../src/ui/shell";
import "../../src/ui/styles/messages";
import "../../src/ui/styles/panels/usage-row";
import "../../src/ui/styles/tools";
import "../../src/ui/styles/transcript/exec-run";
import "../../src/ui/styles/transcript/read-group";

const env = staticEnvironment(loadThemeSync("dark"), { now: 0 });

/** A node's rows at `width`, escapes stripped and trailing blanks trimmed. */
export function nodeText(node: UiNode, width = 120): string {
	return paintNode(env, node, width)
		.rows.map(row => stripEscapes(row).trimEnd())
		.join("\n");
}

/** A block's rows at `width`. */
export function blockText(block: TranscriptBlock, width = 120): string {
	return nodeText(block.node, width);
}

/** Every transcript block's rows, in order, blank-line separated. */
export function transcriptText(shell: Shell, width = 120): string {
	return shell.transcript
		.blocks()
		.map(block => blockText(block, width))
		.join("\n\n");
}
