/**
 * Terminal look of the queued-messages band (`col` `omp.queue`): a blank
 * row, then one cell in, each cut to one line: per group a muted
 * `Steering · 1` over dim `  1. message` rows, then the dim hint
 * `  └ ⌥↑ to edit`.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, truncate } from "@oh-my-pi/pi-tui/text/width";
import { keyLabel } from "../../keys/hints";
import type { QueuedMessageGroup } from "../../dock/queue";
import { termOf } from "../messages/fill";

function paintQueue(node: UiNode, cx: PaintContext): Block {
	const { groups, key } = termOf<{
		groups: readonly QueuedMessageGroup[];
		key: string;
	}>(node);
	if (!groups || groups.length === 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	const room = Math.max(1, cx.width - 2);
	const line = (color: string, text: string): string => ` ${truncate(theme.fg(color, text), room)}`;
	const rows = [""];
	for (const group of groups) {
		rows.push(line("muted", `${group.label}${theme.symbols.symbol("sep.dot")}${group.messages.length}`));
		group.messages.forEach((message, index) => {
			rows.push(line("dim", `  ${index + 1}. ${replaceTabs(message).replace(/\r?\n/g, " ↵ ")}`));
		});
	}
	rows.push(line("dim", `  ${theme.symbols.symbol("tree.hook")} ${keyLabel(theme, key ?? "alt+up")} to edit`));
	return { rows };
}

defineRolePainter("col", "omp.queue", paintQueue);
