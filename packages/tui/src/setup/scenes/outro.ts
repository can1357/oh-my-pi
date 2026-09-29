import { centerLine } from "../../utils";
import { padToWidth } from "../../render/utils";
import { gradientLogo, logoNode, PI_LOGO } from "../../prompt/welcome";
import { theme } from "../../theme/theme";
import { col, node, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";
import { renderStarfield, SETUP_TICK_MS } from "./splash";

export const SETUP_OUTRO_MS = 1200;

const outroMemo = new Memo();

/**
 * Native outro: the shimmering mark, the saved confirmation, and an
 * indeterminate progress bar standing in for the timed sweep. A click sends
 * the `continue` action.
 */
export function describeSetupOutro(): NativeNode {
	const saved = `${theme.status.success} Setup saved`;
	return outroMemo.get([saved], () =>
		col(
			[
				node("spacer", { grow: 1 }),
				logoNode(PI_LOGO, true),
				text([span(saved, "success strong")], { wrap: "none" }),
				text([span("Handing off to the normal CLI…", "muted")], { wrap: "none" }),
				node("progress", { value: null, max: { w: "48ch" } }),
				node("spacer", { grow: 1 }),
			],
			{ align: "center", gap: "sm", grow: 1, role: "omp.setup.outro", actions: { click: "continue" } },
		),
	);
}

export function renderSetupOutro(width: number, height: number, elapsedMs: number): string[] {
	const frame = Math.floor(elapsedMs / SETUP_TICK_MS);
	const lines = renderStarfield(width, height, frame + 1000);
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_OUTRO_MS));
	const logo = gradientLogo(PI_LOGO, progress * 1.2, { pos: (progress * 2) % 1, strength: 1 - progress });
	const title = theme.bold(theme.fg("success", `${theme.status.success} Setup saved`));
	const subtitle = theme.fg("muted", "Handing off to the normal CLI…");
	const sweepWidth = Math.max(1, Math.min(width - 8, Math.floor((width - 8) * progress)));
	const sweep = `${theme.fg("accent", "━".repeat(sweepWidth))}${theme.fg("dim", "─".repeat(Math.max(0, width - 8 - sweepWidth)))}`;
	const content = [...logo, "", title, subtitle, "", sweep];
	const start = Math.max(0, Math.floor((height - content.length) / 2));
	for (let i = 0; i < content.length && start + i < lines.length; i++) {
		lines[start + i] = centerLine(content[i] ?? "", width);
	}
	return lines.map(line => (width > 0 ? padToWidth(line, width) : ""));
}
