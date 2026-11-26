/**
 * The MCP wizard's terminal look: a rounded box titled "Add MCP Server"
 * holding the step: its title (with the phase count), what it asks or shows,
 * the field or the choices, and its key hint, one blank row between parts.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { inputLine } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import {
	type AsyncLine,
	displayText,
	type MCPAddWizardModel,
	PHASES,
} from "../../overlays/panels/mcp-add-wizard-model";
import { bindingGlyph, boxRows, keyGlyph, selectNavGlyphs, termOf } from "./common";

function lines(theme: Theme, entries: readonly AsyncLine[], width: number, frame: string): string[] {
	return entries.flatMap(entry => {
		const text = entry.spinner ? `${frame} ${entry.text}` : entry.text;
		if (text === "") return [""];
		return wrap(entry.tone ? theme.fg(entry.tone, text) : text, width);
	});
}

/** The step's parts (heading, intro, content, footer), each a list of rows. */
function stepParts(model: MCPAddWizardModel, theme: Theme, width: number): string[][] {
	const view = model.view;
	const heading = (title: string, tone: string) => [
		`${theme.fg(tone, title)}${theme.fg("dim", `  ${view.phase + 1}/${PHASES.length}`)}`,
	];
	const cancel = keyGlyph(model.cancelKey);
	switch (view.kind) {
		case "input": {
			const field: string[] = [...wrap(view.lead, width)];
			if (view.placeholder) field.push(...wrap(theme.fg("muted", `e.g. ${view.placeholder}`), width));
			const value = view.secret ? "•".repeat(Array.from(model.field.text).length) : model.field.text;
			field.push("", inputLine(value, model.field.cursor, width), "");
			if (view.error) field.push(...wrap(theme.fg("error", `✗ ${displayText(view.error)}`), width), "");
			const keys =
				view.escape === undefined
					? `[Press ${bindingGlyph("tui.input.submit", "enter")} to skip or continue]`
					: `[${bindingGlyph("tui.input.submit", "enter")} to continue, ${cancel} to ${view.escape}]`;
			if (view.note) field.push(...wrap(theme.fg("muted", `[${view.note}]`), width));
			field.push(...wrap(theme.fg("muted", keys), width));
			return [heading(view.title, "accent"), field];
		}
		case "choice": {
			const intro = view.intro ? lines(theme, view.intro, width, "") : wrap(view.lead, width);
			const list = view.choices.flatMap((choice, index) => {
				const label = choice.tag ? `${choice.label} (${choice.tag})` : choice.label;
				if (index === model.selected)
					return wrap(theme.fg("accent", `${theme.symbols.symbol("nav.cursor")} ${label}`), width);
				const rows = wrap(`  ${label}`, width);
				if (choice.description) rows.push(...wrap(`    ${theme.fg("dim", choice.description)}`, width));
				return rows;
			});
			const footer = wrap(
				theme.fg(
					"muted",
					`[${selectNavGlyphs()} to navigate, ${bindingGlyph("tui.select.confirm", "enter")} to select, ${bindingGlyph("tui.select.cancel", "escape")} to ${view.escape}]`,
				),
				width,
			);
			return [heading(view.title, view.tone), intro, list, footer];
		}
		case "confirm": {
			const summary = model
				.summary()
				.flatMap(row =>
					wrap(`${row.key}: ${row.key === "Name" ? theme.fg("accent", row.value) : row.value}`, width),
				);
			summary.push("", "Save this configuration?");
			return [
				heading(view.title, "accent"),
				summary,
				wrap(
					theme.fg(
						"muted",
						`[${bindingGlyph("tui.select.confirm", "enter")} to save, ${bindingGlyph("tui.select.cancel", "escape")} to go back]`,
					),
					width,
				),
			];
		}
		case "async": {
			const frames = theme.symbols.spinnerFrames;
			const frame = frames.length > 0 ? frames[Math.max(0, model.ticks - 1) % frames.length]! : "|";
			const parts = [heading(view.title, view.tone), lines(theme, view.lines, width, frame)];
			if (view.footer === "go back")
				parts.push(
					wrap(theme.fg("muted", `[Press ${bindingGlyph("tui.select.cancel", "escape")} to go back]`), width),
				);
			else if (view.footer === "cancel")
				parts.push(
					wrap(theme.fg("muted", `(Press ${bindingGlyph("tui.select.cancel", "escape")} to cancel)`), width),
				);
			return parts;
		}
	}
}

defineRolePainter("col", "omp.mcpAddWizard", (node, cx): Block => {
	const model = termOf<{ wizard: MCPAddWizardModel }>(node).wizard;
	if (!model || cx.width <= 0) return { rows: [] };
	model.rev();
	const inner = Math.max(1, cx.width - 4);
	const content: string[] = [""];
	stepParts(model, cx.theme, inner)
		.filter(part => part.length > 0)
		.forEach((part, index) => {
			if (index > 0) content.push("");
			content.push(...part);
		});
	content.push("");
	return { rows: boxRows(cx.theme, "Add MCP Server", content, cx.width) };
});
