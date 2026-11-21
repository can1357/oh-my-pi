import { centerLine } from "../../utils";
import { padToWidth } from "../../render/utils";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { gradientLogo, PI_LOGO } from "../../prompt/welcome";
import { theme } from "../../theme/theme";
import { col, compact, keyed, node, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";
import { renderStarfield, SETUP_TICK_MS } from "./splash";

export const SETUP_OUTRO_MS = 1200;

const outroMemo = new Memo();

/**
 * Native outro, centered: the builtin `omp` mark, "You're all set", the
 * default model now in effect (`model`, its display name, when there is
 * one), and an indeterminate progress bar standing in for the timed sweep.
 * A click sends the `continue` action.
 */
export function describeSetupOutro(model: string | undefined): NativeNode {
	return outroMemo.get([model], () =>
		col(
			compact([
				node("spacer", { grow: 1 }, undefined, "top"),
				node("image", { builtin: "omp", alt: APP_NAME, w: 72, role: "omp.setup.outro.mark" }, undefined, "logo"),
				keyed(text([span("You're all set", "strong")], { wrap: "none", role: "omp.setup.outro.title" }), "title"),
				model !== undefined &&
					keyed(
						text([span("Default model", "muted"), span(" · ", "dim"), span(model, "muted")], {
							wrap: "none",
							truncate: "end",
							role: "omp.setup.outro.model",
						}),
						"model",
					),
				keyed(
					text([span(`Starting ${APP_NAME}…`, "muted")], { wrap: "none", role: "omp.setup.outro.status" }),
					"status",
				),
				node("progress", { value: null, role: "omp.setup.outro.progress" }, undefined, "progress"),
				node("spacer", { grow: 1 }, undefined, "bottom"),
			]),
			{ align: "center", grow: 1, role: "omp.setup.outro", actions: { click: "continue" } },
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
