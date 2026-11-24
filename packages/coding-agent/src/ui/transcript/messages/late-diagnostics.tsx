/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Late LSP diagnostics (arrived after an edit or write returned): a
 * severity-toned card with one line per diagnostic, clamped while collapsed;
 * the terminal draws the same diagnostics tree the edit and write tools do.
 * Tool activity: hidden with it.
 *
 * Terminal look: `omp.diagnostics.late` (`src/ui/styles/messages/diagnostics.ts`).
 */
import { type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { LateDiagnosticsFile } from "../../../session/transcript/late-diagnostics-message";
import type { FileDiagnostics } from "../../tools/file-common";
import { cardExpansion } from "../expansion";

/** Diagnostics the collapsed card shows. */
const COLLAPSED_DIAGNOSTICS = 5;

/** The files' diagnostics as one report; undefined when none carries a message. */
export function lateDiagnostics(files: readonly LateDiagnosticsFile[]): FileDiagnostics | undefined {
	const messages: string[] = [];
	const summaries: string[] = [];
	let errored = false;
	for (const file of files) {
		if (file.messages?.length) messages.push(...file.messages);
		if (file.summary) summaries.push(file.summary);
		if (file.errored) errored = true;
	}
	return messages.length === 0 ? undefined : { errored, summary: summaries.join(", "), messages };
}

/** Late diagnostics of `files`. */
export function LateDiagnostics(props: {
	files: readonly LateDiagnosticsFile[];
	expanded: Reactive<boolean>;
	visible?: Reactive<boolean>;
	onToggle?: (expanded: boolean) => void;
}): JSXNode {
	const { expanded, toggle } = cardExpansion(props.expanded, props.onToggle);
	const report = lateDiagnostics(props.files);
	const errored = report?.errored === true;
	const icon = currentTheme().symbols.icon(errored ? "status.error" : "status.warning");
	const head: TspSpan[] = [
		{ t: `${icon} `, s: errored ? "error" : "warning" },
		{ t: "Late diagnostics", s: "toolTitle" },
	];
	if (report?.summary) head.push({ t: ` (${stripEscapes(report.summary)})`, s: "dim" });
	return (
		<card
			role="omp.diagnostics.late"
			tone={errored ? "error" : "warning"}
			head={head}
			collapsible
			collapsed={() => !expanded()}
			preview={{ lines: COLLAPSED_DIAGNOSTICS }}
			hidden={() => (props.visible === undefined || read(props.visible) ? undefined : true)}
			term={{ diagnostics: report }}
			onToggle={toggle}
		>
			{(report?.messages ?? []).map((message, index) => (
				<text propKey={`d${index}`} spans={[{ t: stripEscapes(message), s: "mono" }]} wrap="word" />
			))}
		</card>
	);
}
