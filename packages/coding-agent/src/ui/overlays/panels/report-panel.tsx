/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A titled report (changelog, stats, diagnostics) over the transcript: a
 * scrolling body and a Close button. Scroll keys (page, line, home/end) move
 * the body; natively they are forwarded to the body's scroller, and the sheet
 * around the panel is the frame and carries the title (the `omp.report` role
 * is the terminal box, so it is not sent).
 */
import { type Accessor, type JSXNode, nativeRendering, type ScrollRequest, signal, untrack } from "@oh-my-pi/pi-tui";
import "../../styles/panels/report-panel";
import type { ReportGeometry } from "../../styles/panels/report-panel";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { actionKeyId, cancelKbd } from "../../keys/hints";
import { bindingGlyph, keyTitle } from "../../styles/panels/common";
import { ActionButton } from "./common";

export interface ReportPanelProps {
	readonly title: string;
	readonly body: JSXNode;
	/** The close key as the hint names it (`Esc`, `Ctrl+C`). */
	readonly closeKey: string;
	/** Most rows the panel may take; absent: as tall as its body. */
	readonly maxRows?: Accessor<number | undefined>;
	/** The panel holds keyboard focus (hints then show key glyphs). */
	readonly focused?: Accessor<boolean>;
	onClose(): void;
}

/** Rows of the panel's chrome around its body (borders, blank rows, the hint). */
export const REPORT_CHROME_ROWS = 5;

const SCROLL_KEYS: Readonly<Record<string, ScrollRequest["by"]>> = {
	pageDown: "page-down",
	pageUp: "page-up",
	down: "line-down",
	up: "line-up",
	end: "end",
	home: "start",
};

export function ReportPanel(props: ReportPanelProps): JSXNode {
	const request = signal<ScrollRequest | undefined>(undefined);
	/** First body row shown. */
	const offset = signal(0);
	/** Unbounded until the first terminal paint; scrolling past the end must not bank rows an upward scroll pays back. */
	const geometry: ReportGeometry = { maxOffset: Number.POSITIVE_INFINITY };
	const viewport = () => Math.max(1, (props.maxRows?.() ?? Number.POSITIVE_INFINITY) - REPORT_CHROME_ROWS);
	const scroll = (by: ScrollRequest["by"]) => {
		const page = Math.max(1, untrack(viewport) - 1);
		const at = untrack(offset);
		const moves: Record<ScrollRequest["by"], number> = {
			"page-down": at + page,
			"page-up": at - page,
			"line-down": at + 1,
			"line-up": at - 1,
			end: Number.MAX_SAFE_INTEGER,
			start: 0,
		};
		offset.set(Math.max(0, Math.min(moves[by], geometry.maxOffset)));
		request.set({ by, n: (untrack(request)?.n ?? 0) + 1 });
	};
	return (
		<col
			role={() => (nativeRendering() ? undefined : "omp.report")}
			gap="md"
			term={() => ({
				title: props.title,
				closeKey: props.focused?.() ? bindingGlyph("tui.select.cancel", "escape") : props.closeKey,
				offset: offset(),
				maxRows: props.maxRows?.(),
				geometry,
			})}
			onKey={key => {
				const by = SCROLL_KEYS[selectKeyId(key)];
				if (by) {
					scroll(by);
					return true;
				}
				if (!matchesSelectCancel(key)) return false;
				props.onClose();
				return true;
			}}
			onAction={act => {
				if (act === "close") props.onClose();
			}}
		>
			<col key="body" role="omp.report.body" scroll={request}>
				{props.body}
			</col>
			<row key="actions" role="omp.actions" align="center" gap="sm">
				<spacer grow={1} />
				<ActionButton
					id="close"
					label="Close"
					title={`Close  ${keyTitle(actionKeyId("tui.select.cancel", "escape"))}`}
					keys={cancelKbd()}
				/>
			</row>
		</col>
	);
}
