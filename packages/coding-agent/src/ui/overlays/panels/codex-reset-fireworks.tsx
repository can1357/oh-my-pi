/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The Codex quota celebration: a weekly usage reset arrived early, or saved
 * resets were banked. Natively a centered card (sparkles, a shimmering title,
 * what happened, Close); the terminal draws fireworks over a banner.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { CodexResetFireworksEvent } from "../../../modes/view-model/overlays/codex-reset-fireworks";
import "../../styles/panels/codex-reset-fireworks";
import { ActionButton } from "./common";
import { rowsRole, type SheetAttributes } from "../sheet";

/** Tern's sheet: glass at the pane's top edge (it bursts confetti for this role). */
export const FIREWORKS_SHEET: SheetAttributes = { role: "omp.overlay.fireworks", anchor: "top", size: "md" };

export interface CodexResetFireworksProps {
	readonly event: CodexResetFireworksEvent;
	/** When the show started (the terminal animation's clock origin, ms). */
	readonly startedAt: number;
	onClose(): void;
}

/** Title and line of an event. */
export function fireworksText(event: CodexResetFireworksEvent): { title: string; line: string } {
	if (event.kind === "unscheduled-weekly-reset") return { title: "OpenAI reset", line: "Weekly usage cleared early" };
	const banked = event.added === 1 ? "New reset banked" : `${event.added} resets banked`;
	return { title: "Saved reset", line: `${banked} · ${event.available} available` };
}

export function CodexResetFireworks(props: CodexResetFireworksProps): JSXNode {
	const { title, line } = fireworksText(props.event);
	return (
		<col
			role={rowsRole("omp.fireworks")}
			align="center"
			gap="sm"
			term={{ title, line, startedAt: props.startedAt }}
			onKey={key => {
				if (key.id !== "escape") return false;
				props.onClose();
				return true;
			}}
			onAction={act => {
				if (act === "close") props.onClose();
			}}
		>
			<text
				spans={[
					{ s: "accent", t: "✦ ", fx: "pulse" },
					{ s: "mdLink", t: "✧ ", fx: "pulse" },
					{ s: "warning", t: "✦", fx: "pulse" },
				]}
			/>
			<shimmer text={title} palette={{ low: "thinkingXhigh", mid: "warning", high: "text" }} />
			<text spans={[{ s: "mdLink", t: line }]} />
			<row key="actions" role="omp.actions" align="center" gap="sm">
				<spacer grow={1} />
				<ActionButton id="close" label="Close" title="Close  esc" keys={["escape"]} />
			</row>
		</col>
	);
}
