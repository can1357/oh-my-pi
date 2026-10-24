/**
 * research-mode: the harness's capability surface inside omp.
 *
 * Registers `/help` (renders the bundled capability guide) and keeps one
 * statusline entry showing the active project and screening progress.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import helpGuide from "./help.md" with { type: "text" };
import { buildResearchHint, readResearchState, STATUS_KEY } from "./statusline";

/** Statusline reads hit SQLite; one turn's worth of staleness is invisible. */
const HINT_TTL_MS = 5_000;

export default function researchMode(pi: ExtensionAPI): void {
	pi.registerCommand("help", {
		description: "Show what the research harness can do",
		handler: async (_args, ctx) => {
			ctx.ui.notify(helpGuide.trimEnd(), "info");
		},
	});

	let cachedAt = 0;
	let cachedHint = "";
	const refreshHint = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		const now = Date.now();
		if (!cachedHint || now - cachedAt >= HINT_TTL_MS) {
			cachedHint = buildResearchHint(await readResearchState());
			cachedAt = now;
		}
		ctx.ui.setStatus(STATUS_KEY, cachedHint);
	};

	// Event-driven only: session start paints the hint, turn end refreshes it
	// after commands that screen records. No polling.
	pi.on("session_start", refreshHint);
	pi.on("turn_end", refreshHint);
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
