import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { gradientLogo, PI_LOGO } from "../../components/welcome";
import { theme } from "../../theme/theme";
import { renderStarfield, SETUP_TICK_MS } from "./splash";

export const SETUP_OUTRO_MS = 1200;

function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width);
	const left = Math.floor((width - lineWidth) / 2);
	return padding(left) + line + padding(width - left - lineWidth);
}

function clampLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
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
	return lines.map(line => clampLine(line, width));
}
