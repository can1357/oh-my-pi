/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The stats-dashboard notice: where the dashboard runs, and a button that
 * opens it. The terminal shows the dimmed message under a blank row.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import "../../styles/panels/stats-notice";
import { ActionButton } from "./common";

export interface StatsNoticeProps {
	readonly message: string;
	/** The dashboard's address. */
	readonly url: string;
	/** Open the dashboard. */
	readonly onOpen?: () => void;
}

export function StatsNotice(props: StatsNoticeProps): JSXNode {
	return (
		<row
			role="omp.statsNotice"
			align="center"
			gap="md"
			wrap
			onAction={act => {
				if (act === "open") props.onOpen?.();
			}}
		>
			<text role="omp.stats" grow={1} wrap="word" spans={[{ t: props.message }]} />
			<ActionButton id="open" label="Open dashboard ↗" title={props.url} href={props.url || undefined} />
		</row>
	);
}
