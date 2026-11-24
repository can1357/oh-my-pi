/**
 * `omp.app.ps`: the `omp ps` monitor in the terminal (`term.ps`), btop
 * style, filling the screen: a head line (`omp ps · 4 units in 2 scopes`
 * with the refresh age at the right), the view's body in a scrolling window
 * (a scrollbar in the last column while it overflows), the status line and
 * the key hints.
 *
 * - table: the daemon line, then per scope its head and a fixed-column unit
 *   table (exited units dimmed, the selected unit an inverse bar kept in view);
 * - info: the unit's summary and its fields;
 * - logs: the log tail.
 *
 * Colors are the terminal's own palette slots (green/red/yellow, whatever
 * the theme says) with bold, faint and inverse, like the CLI's other
 * plain-text output.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatDuration } from "@oh-my-pi/pi-utils";
import {
	collapseCommand,
	flagsCell,
	formatCommand,
	idleCell,
	pidsCell,
	TABLE_HEADER,
	TERMINAL_STATES,
	unitLabel,
	unitName,
} from "../../../../cli/ps-model";
import type { UnitScope, UnitSnapshot } from "../../../../daemon/daemon-types";
import type { PsStatusTone, PsTopModel } from "../../../apps/ps-top/model";

/** Terminal palette slots of the status tones. */
const GREEN = 2;
const RED = 1;
const YELLOW = 3;

interface Pen {
	bold(text: string): string;
	dim(text: string): string;
	inverse(text: string): string;
	color(slot: number, text: string): string;
}

const penOf = (theme: Theme): Pen => ({
	bold: text => theme.style("strong", text),
	dim: text => theme.style("faint", text),
	inverse: text => theme.style("inverse", text),
	// The terminal's own slot, not the theme's mapping of it.
	color: (slot, text) => `\x1b[3${slot}m${text}\x1b[39m`,
});

function toneText(pen: Pen, tone: PsStatusTone, text: string): string {
	if (tone === "success") return pen.color(GREEN, text);
	if (tone === "warning") return pen.color(YELLOW, text);
	if (tone === "error") return pen.color(RED, text);
	return pen.dim(text);
}

function stateCell(pen: Pen, unit: UnitSnapshot): string {
	const terminal = TERMINAL_STATES[unit.state];
	const text = terminal && unit.exitCode !== undefined ? `${unit.state}(${unit.exitCode})` : unit.state;
	if (unit.state === "ready" || unit.state === "running") return pen.color(GREEN, text);
	if (unit.state === "failed") return pen.color(RED, text);
	return terminal ? pen.dim(text) : pen.color(YELLOW, text);
}

function scopeHeader(pen: Pen, scope: UnitScope): string {
	if (scope.kind === "global") return pen.bold("global");
	return `${scope.kind} ${pen.bold(scope.kind === "project" ? scope.dir : scope.id)}`;
}

/** A window of `height` rows over `lines` from `top`, with a scrollbar column while they overflow. */
function window(lines: readonly string[], top: number, height: number, width: number): string[] {
	const out: string[] = [];
	const total = lines.length;
	if (total <= height) {
		for (let i = 0; i < height; i++) out.push(truncate(lines[i] ?? "", width));
		return out;
	}
	const size = Math.max(1, Math.min(Math.floor((height * height) / total), height));
	const max = total - height;
	const start = Math.round((top / max) * (height - size));
	for (let i = 0; i < height; i++) {
		const bar = i >= start && i < start + size ? "█" : "│";
		out.push(`${padTo(truncate(lines[top + i] ?? "", width - 1), width - 1)}${bar}`);
	}
	return out;
}

/** `text` filled with spaces to `width` cells (never cut). */
const padRight = (text: string, width: number) => `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;

const clampTop = (top: number, total: number, height: number) => Math.max(0, Math.min(top, total - height));

defineRolePainter("col", "omp.app.ps", (node, cx): Block => {
	const model = (node.props() as { term?: { ps?: PsTopModel } }).term?.ps;
	if (!model) return { rows: [] };
	const pen = penOf(cx.theme);
	const width = cx.width;
	const height = Math.max(6, model.screenRows());
	const now = cx.now();
	const last = model.lastRefresh();

	const header = (title: string): string => {
		const left = ` ${pen.bold("omp ps")} ${pen.dim("·")} ${title}`;
		const right = pen.dim(last ? `updated ${formatDuration(now - last)} ago` : "updating…");
		const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 1);
		return truncate(`${left}${" ".repeat(pad)}${right}`, width);
	};
	const status = model.status();
	const footer = (hints: string): string[] => [
		truncate(` ${model.statusVisible() && status ? toneText(pen, status.tone, status.text) : ""}`, width),
		truncate(pen.dim(` ${hints}`), width),
	];
	const bodyHeight = height - 3;
	const view = model.view();

	if (view === "info") {
		const info = model.info();
		const body = [""];
		if (info) {
			const { unit, proc } = info;
			body.push(` ${pen.bold(unitLabel(unit))}`, "");
			const fields: [string, string][] = [
				["id:", unit.id],
				["scope:", scopeHeader(pen, unit.scope)],
			];
			const command = formatCommand(proc) ?? unit.command;
			if (command) fields.push(["command:", collapseCommand(command)]);
			const cwd = proc?.cwd ?? unit.cwd;
			if (cwd) fields.push(["cwd:", cwd]);
			if (!TERMINAL_STATES[unit.state]) fields.push(["uptime:", formatDuration(now - unit.startedAt)]);
			if (unit.exitReason) fields.push(["exit:", unit.exitReason]);
			fields.push(["restarts:", `${unit.restartCount} (policy: ${unit.policy.restart})`]);
			fields.push(["leases:", `${unit.leases}  idle: ${idleCell(unit)}`]);
			fields.push(["owner:", unit.owner ?? "-"]);
			for (const [label, value] of fields) body.push(`   ${padTo(label, 9)} ${value}`);
			body.push(`   pty: ${proc?.pty ?? false}  hold: ${unit.policy.hold}  survive: ${unit.policy.survive}`);
		} else {
			body.push(pen.dim(" loading…"));
		}
		model.infoTop = clampTop(model.infoTop, body.length, bodyHeight);
		return {
			rows: [header("unit info"), ...window(body, model.infoTop, bodyHeight, width), ...footer("⎋ back · q back")],
		};
	}

	if (view === "logs") {
		const row = model.current();
		const state = model.logsState();
		const title = `logs ${pen.bold(row ? unitName(row.unit) : "?")}${state ? pen.dim(` · ${state}`) : ""}`;
		const error = model.logsError();
		const lines = model.logsLines().map(line => ` ${error ? pen.color(RED, line) : line}`);
		const top = Math.max(0, lines.length - bodyHeight);
		return {
			rows: [
				header(title),
				...window(lines, top, bodyHeight, width),
				...footer("⎋ back · q back · view refreshes live"),
			],
		};
	}

	const rows = model.rows();
	const reports = model.reports();
	const all = model.all();
	const scopeKind = all ? "(all)" : model.target.dir !== undefined ? "(target + global)" : "(current + global)";
	const title = `${rows.length} unit${rows.length === 1 ? "" : "s"} in ${reports.length} scope${reports.length === 1 ? "" : "s"} ${pen.dim(scopeKind)}`;
	const cellsOf = (unit: UnitSnapshot): string[] => [
		unit.kind,
		unitName(unit),
		stateCell(pen, unit),
		pidsCell(unit),
		TERMINAL_STATES[unit.state] ? "-" : formatDuration(now - unit.startedAt),
		String(unit.leases),
		idleCell(unit),
		String(unit.restartCount),
		flagsCell(unit),
		collapseCommand(unit.command),
	];
	const cells = rows.map(row => cellsOf(row.unit));
	const widths = TABLE_HEADER.map((head, column) =>
		Math.max(head.length, ...cells.map(row => visibleWidth(row[column]!))),
	);
	const tableRow = (row: readonly string[]): string =>
		`   ${row.map((cell, column) => padTo(cell, widths[column]!)).join("  ")}`.trimEnd();
	const daemon = model.board()?.daemon;
	const body: { text: string; unit?: number }[] = [
		{
			text: ` ${daemon ? `${pen.color(GREEN, `daemon pid ${daemon.pid}`)} ${pen.dim(`· ${daemon.build}`)}` : pen.dim("daemon not running — showing stored units")}`,
		},
		{ text: "" },
	];
	let index = 0;
	for (const report of reports) {
		body.push({ text: ` ${scopeHeader(pen, report.scope)}` });
		if (report.units.length === 0) body.push({ text: pen.dim("   no units") });
		else {
			body.push({ text: pen.dim(tableRow(TABLE_HEADER)) });
			for (const unit of report.units) {
				const line = tableRow(cells[index]!);
				body.push({ text: TERMINAL_STATES[unit.state] ? pen.dim(line) : line, unit: index });
				index++;
			}
		}
		body.push({ text: "" });
	}
	if (reports.length === 0) body.push({ text: pen.dim(" No units.") });
	const selected = model.selected();
	const lines = body.map(entry =>
		entry.unit === selected
			? truncate(pen.inverse(padRight(` ❯${stripEscapes(entry.text).slice(2)}`, width)), width)
			: truncate(entry.text, width),
	);
	const selectedLine = body.findIndex(entry => entry.unit === selected);
	let top = model.tableTop;
	if (selectedLine >= 0) {
		if (selectedLine < top) top = selectedLine;
		else if (selectedLine >= top + bodyHeight) top = selectedLine - bodyHeight + 1;
	}
	model.tableTop = clampTop(top, lines.length, bodyHeight);
	return {
		rows: [
			header(title),
			...window(lines, model.tableTop, bodyHeight, width),
			...footer("↑/↓ select · ⏎ info · l logs · s stop · x kill · r restart · a all scopes · q quit"),
		],
	};
});
