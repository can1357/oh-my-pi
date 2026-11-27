/**
 * The `debug` look: a pending call is one line (`⏳ Debug: launch ./a.out`);
 * a result is a card (`╭─── 🐞 Debug continue ───╮`) with the session
 * snapshot and the output (three lines collapsed under `… N more lines`,
 * twelve expanded).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { DebugTerm } from "../../tools/debug";
import { expandHint, type FrameSection, frameBlock, spinnerGlyph } from "./frame";
import { defineToolLook, toolProps } from "./look";

/** Output lines shown collapsed / expanded. */
const COLLAPSED_LINES = 3;
const EXPANDED_LINES = 12;

function paintDebug(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as DebugTerm | undefined;
	if (!term) return { rows: [] };
	const theme = cx.theme;
	if (!term.result) {
		const glyph = theme.fg("muted", theme.symbols.symbol("status.pending"));
		return {
			rows: wrap(`${glyph} ${theme.fg("accent", "Debug")}: ${theme.fg("muted", term.description)}`, cx.width),
		};
	}
	const failed = props.tone === "error";
	const glyph =
		props.status === "running"
			? spinnerGlyph(cx)
			: failed
				? theme.fg("error", theme.symbols.symbol("status.error"))
				: theme.fg("accent", theme.symbols.symbol("tool.debug"));
	const sections: FrameSection[] = [];
	if (term.session && term.session.length > 0) {
		sections.push({
			label: "Session",
			lines: term.session.map(fact =>
				fact.label === "Session" ? `Session ${fact.value}` : `${fact.label}: ${fact.value}`,
			),
		});
	}
	const expanded = props.collapsed === false;
	let lines: string[];
	if (!term.output) lines = ["No output"];
	else {
		const all = term.output.split("\n").map(line => replaceTabs(line));
		const limit = expanded ? EXPANDED_LINES : COLLAPSED_LINES;
		lines = all.slice(0, limit);
		const hidden = all.length - lines.length;
		if (hidden > 0) {
			const more = `${theme.symbols.ellipsis} ${hidden} more lines`;
			lines.push(`${theme.fg("muted", `${more} `)}${expanded ? "" : expandHint(theme)}`);
		}
	}
	sections.push({ label: "Output", lines });
	return frameBlock(theme, cx.width, {
		head: `${glyph} Debug ${term.action}`,
		sections,
		border: failed ? "error" : props.status === "running" ? "accent" : "dim",
	});
}

defineToolLook("debug", { paint: paintDebug, margin: true, animated: true });
