/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/debug raw-sse`: the raw provider stream. The page is the capture counters
 * over the SSE wire text (one `ansi` block that follows its tail until the
 * user scrolls away); the docked bar carries the copy status and the Copy
 * raw / Close buttons.
 *
 * The terminal shows the whole viewer in the bar's place: a framed,
 * scrolling stream with the counters above and the key hints below (the
 * `omp.debug.bar` look).
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { formatRawSseIsoTime } from "../../../debug/raw-sse-buffer";
import { formatTooltipKey } from "../../keys/hints";
import "../../styles/apps/raw-sse/look";
import type { RawSseViewerModel } from "./model";
import { ActionButton } from "../../overlays/panels/common";

/** The docked bar (see the module docs). */
export function RawSseViewer(props: { readonly model: RawSseViewerModel }): JSXNode {
	const model = props.model;
	return (
		<col
			role="omp.debug.bar"
			gap="sm"
			term={{ viewer: model }}
			onKey={key => model.key(key.id)}
			onAction={act => {
				if (act === "copy-raw") model.copy();
				else if (act === "close") model.close();
			}}
		>
			{() => {
				const status = model.status();
				return (
					status && (
						<text
							key="status"
							spans={[{ s: status.failed ? "error" : "success", t: status.text }]}
							wrap="word"
							role="omp.app.status"
						/>
					)
				);
			}}
			<row key="actions" role="omp.actions" gap="sm" align="center">
				<ActionButton
					id="copy-raw"
					label="Copy raw"
					title={`Copy raw  ${formatTooltipKey("ctrl+c")}`}
					tone="accent"
					keys={["ctrl", "c"]}
				/>
				<spacer grow={1} />
				<ActionButton id="close" label="Close" title="Close  esc" keys={["escape"]} />
			</row>
		</col>
	);
}

/** The stream page: the counters, then the wire text or what fills it. */
export function RawSseMain(props: { readonly model: RawSseViewerModel }): JSXNode {
	const model = props.model;
	const head = (): JSXNode => {
		const snapshot = model.snapshot();
		const stats: TspSpan[] = [
			{ s: "num", t: `${snapshot.totalEvents} events` },
			{ s: "dim", t: " · " },
			{ s: "num", t: `${snapshot.records.length} records` },
		];
		if (snapshot.droppedRecords > 0) {
			stats.push({ s: "dim", t: " · " }, { s: "warning", t: `${snapshot.droppedRecords} dropped` });
		}
		stats.push(
			{ s: "dim", t: " · " },
			snapshot.lastUpdatedAt
				? { s: "muted", t: `last ${formatRawSseIsoTime(snapshot.lastUpdatedAt)}` }
				: { s: "muted", t: "waiting for first frame" },
		);
		return (
			<row key="head" role="omp.app.head" gap="sm" align="center">
				<text text="Raw provider stream" role="omp.app.title" />
				<text spans={stats} truncate="end" />
			</row>
		);
	};
	const body = (): JSXNode => {
		const snapshot = model.snapshot();
		if (snapshot.records.length === 0) {
			return (
				<col key="empty" role="omp.app.empty" gap="xs" align="center">
					<text text="No raw SSE frames captured yet" role="omp.app.empty-title" />
					<text
						spans={[
							{ s: "muted", t: "HTTP SSE providers populate this view while a model response is streaming." },
						]}
					/>
				</col>
			);
		}
		const theme = currentTheme();
		let text = "";
		for (const record of snapshot.records) {
			for (const line of model.recordLines(record)) text += `${line}\n`;
			if (record.kind === "event" && record.truncated) {
				text += `${theme.fg("warning", `: omp-debug-event-truncated originalChars=${record.originalChars}`)}\n`;
			}
			text += "\n";
		}
		return <ansi key="stream" text={text} follow role="omp.debug.stream" max={{ h: 1 }} scroll={model.scroll} />;
	};
	return [head, body];
}
