/**
 * A request's usage in the terminal: a blank row, then the metrics (`⤵ 18K
 * ⤴ 640  💾 12K`) two spaces apart, dim, with the standard horizontal padding.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import { terminalPaddingX } from "../terminal-padding";
import type { UsageMetric } from "../../overlays/panels/usage-row";
import { termOf } from "./common";

defineRolePainter("row", "omp.usage.turn", (node, cx): Block => {
	const metrics = termOf<{ metrics: readonly UsageMetric[] }>(node).metrics ?? [];
	const theme = cx.theme;
	const strip = metrics
		.map(metric => (metric.icon ? `${theme.symbols.symbol(metric.icon)} ${metric.value}` : metric.value))
		.join("  ");
	const paddingX = terminalPaddingX();
	const pad = " ".repeat(paddingX);
	const lines = wrap(theme.fg("dim", strip), Math.max(1, cx.width - 2 * paddingX));
	return { rows: ["", ...lines.map(line => pad + line)] };
});
