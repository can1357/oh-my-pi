/**
 * `sandbox_request`: a rounded frame headed by the status glyph,
 * `Sandbox request: <verb target>`, the decision badge (or the dim
 * `waiting for your answer` while the dialog is open); the agent's intent
 * in muted text, then a labelled section with the user's instructions or
 * the refusal reason. Each text is cut at four rows.
 *
 * Reads {@link SandboxRequestTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { SANDBOX_REQUEST_TEXT_ROWS, type SandboxRequestTerm } from "../../tools/sandbox-request";
import { type FrameSection, frameInner, frameRows, statusIcon, statusLine } from "./frame";
import { defineToolLook, toolProps } from "./look";

/** `text` wrapped to `width` in `color`, cut at {@link SANDBOX_REQUEST_TEXT_ROWS} rows (the last ends in `…` when cut). */
function boundedRows(theme: Theme, text: string, color: string, width: number): string[] {
	const rows = wrap(text, Math.max(1, width));
	const kept =
		rows.length <= SANDBOX_REQUEST_TEXT_ROWS
			? rows
			: [
					...rows.slice(0, SANDBOX_REQUEST_TEXT_ROWS - 1),
					truncate(`${rows[SANDBOX_REQUEST_TEXT_ROWS - 1]}…`, Math.max(1, width)),
				];
	return kept.map(row => theme.fg(color, row));
}

function paintSandboxRequest(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = (props.term ?? {}) as Partial<SandboxRequestTerm>;
	const theme = cx.theme;
	const inner = frameInner(cx.width);
	const outcome = term.outcome;
	const glyph = statusIcon(cx, outcome ?? (props.status === "running" ? "running" : "pending"));
	const head = statusLine(theme, {
		glyph,
		title: "Sandbox request",
		...(term.target ? { description: term.target } : {}),
		...(term.badge ? { badge: { label: term.badge.label, color: term.badge.tone } } : {}),
		...(typeof props.note === "string" ? { meta: [props.note] } : {}),
	});
	const sections: FrameSection[] = [];
	if (term.intent) sections.push({ lines: boundedRows(theme, term.intent, "muted", inner) });
	if (term.note)
		sections.push({
			label: theme.fg("toolTitle", term.note.label),
			lines: boundedRows(theme, term.note.text, term.badge?.tone ?? "muted", inner),
		});
	return {
		rows: frameRows(theme, cx.width, {
			head,
			sections,
			border: outcome ? "dim" : "accent",
		}),
	};
}

defineToolLook("sandbox_request", { paint: paintSandboxRequest, margin: true, animated: true });
