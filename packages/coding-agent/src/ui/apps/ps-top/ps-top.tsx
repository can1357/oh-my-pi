/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `omp ps` as a live monitor: a head (title, counts, the scope control,
 * freshness, quit), one section per unit scope with a selectable process
 * list, the transient status, and an action bar that mirrors the keys. Info
 * and logs replace the list.
 *
 * The terminal shows the classic btop-style table (the `omp.app.ps` look).
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import {
	collapseCommand,
	flagsCell,
	formatCommand,
	idleCell,
	pidsCell,
	scopeId,
	scopeTitle,
	TERMINAL_STATES,
	unitLabel,
	unitName,
} from "../../../cli/ps-model";
import type { UnitScope, UnitSnapshot } from "../../../daemon/daemon-types";
import { formatTooltipKey } from "../../keys/hints";
import { stableKey } from "../../overlays/pickers/format";
import "../../styles/apps/ps-top/look";
import type { PsRow, PsTopModel } from "./model";
import { ActionButton, IconButton, segmentedVariant } from "../../overlays/panels/common";

/** Native key of a unit row. */
export const unitKey = (row: PsRow): string => stableKey(row.unit.id);

/** Semantic tone of a unit state. */
export function unitTone(unit: UnitSnapshot): TspTone {
	if (unit.state === "ready" || unit.state === "running") return "success";
	if (unit.state === "failed") return "error";
	return TERMINAL_STATES[unit.state] ? "muted" : "warning";
}

/** A state as the table shows it: `ready`, `exited(143)`. */
export function stateLabel(unit: UnitSnapshot): string {
	return TERMINAL_STATES[unit.state] && unit.exitCode !== undefined ? `${unit.state}(${unit.exitCode})` : unit.state;
}

const STATE_ICON: Record<TspTone, string> = {
	success: "check",
	error: "x",
	muted: "stop",
	warning: "clock",
	neutral: "activity",
	accent: "activity",
	info: "activity",
	pending: "clock",
	user: "user",
};

/** An action-bar button: label, optional key, tone and title. */
function Button(props: {
	readonly act: string;
	readonly label: string;
	readonly keys?: string;
	readonly tone?: TspTone;
	readonly title?: string;
}): JSXNode {
	const hint = props.keys && formatTooltipKey(props.keys);
	return (
		<ActionButton
			id={props.act}
			label={props.label}
			title={props.title ?? (hint ? `${props.label}  ${hint}` : props.label)}
			tone={props.tone}
			keys={props.keys ? [props.keys] : undefined}
		/>
	);
}

function scopeSpans(scope: UnitScope): TspSpan[] {
	const { kind, name } = scopeTitle(scope);
	if (!name) return [{ s: "strong", t: kind }];
	return [{ t: `${kind} ` }, { s: scope.kind === "project" ? "strong path" : "strong mono", t: name }];
}

export interface PsTopProps {
	readonly model: PsTopModel;
}

export function PsTop(props: PsTopProps): JSXNode {
	const model = props.model;
	return (
		<col
			role="omp.app.ps"
			gap="md"
			term={{ ps: model }}
			onKey={key => model.key(key.id)}
			onSelect={item => model.select(item, false, unitKey)}
			onActivate={item => model.select(item, true, unitKey)}
			onAction={act => model.action(act)}
		>
			{() => head(model)}
			{() => {
				const view = model.view();
				return view === "info" ? info(model) : view === "logs" ? logs(model) : table(model);
			}}
			{() => {
				const status = model.status();
				return (
					model.statusVisible() &&
					status && (
						<text key="status" spans={[{ s: status.tone, t: status.text }]} wrap="word" role="omp.app.status" />
					)
				);
			}}
			{() => actions(model)}
		</col>
	);
}

/** The head row (read inside a region: it follows the model). */
function head(model: PsTopModel): JSXNode {
	const view = model.view();
	const row = model.current();
	let where: JSXNode;
	if (view === "table") {
		const rows = model.rows();
		const running = rows.filter(r => !TERMINAL_STATES[r.unit.state]).length;
		const stopped = rows.length - running;
		const scopes = model.reports().length;
		const daemon = model.board()?.daemon;
		const spans: TspSpan[] = [{ s: running > 0 ? "success" : "muted", t: `${running} running` }];
		if (stopped > 0) spans.push({ s: "muted", t: ` · ${stopped} stopped` });
		spans.push({ s: "muted", t: ` · ${scopes} scope${scopes === 1 ? "" : "s"}` });
		spans.push(daemon ? { s: "muted", t: ` · daemon pid ${daemon.pid}` } : { s: "dim", t: " · daemon not running" });
		where = [<text text="Processes" role="omp.app.title" />, <text spans={spans} truncate="end" />];
	} else {
		const name = row ? unitName(row.unit) : "?";
		const unit = view === "info" ? model.info()?.unit : row?.unit;
		const state = model.logsState();
		where = [
			<IconButton name="back" act="back" title="Back  esc" aria="Back" />,
			<text text={view === "logs" ? `Logs · ${name}` : name} role="omp.app.title" truncate="end" />,
			unit && <badge text={stateLabel(unit)} tone={unitTone(unit)} />,
			view === "logs" && state && <text spans={[{ s: "muted", t: state }]} />,
		];
	}
	const last = model.lastRefresh();
	return (
		<row key="head" role="omp.app.head" justify="between" align="center">
			<row role="omp.app.where" gap="sm" align="center">
				{where}
			</row>
			<row role="omp.app.tools" gap="md" align="center">
				{view === "table" && (
					<tabs
						key="scope"
						items={[
							{ id: "current", label: model.target.dir !== undefined ? "Target" : "This project" },
							{ id: "all", label: "All scopes" },
						]}
						active={model.all() ? "all" : "current"}
						role="omp.app.seg"
						variant={segmentedVariant}
					/>
				)}
				{last ? (
					<row role="omp.app.fresh" gap="xs" align="center">
						<text spans={[{ s: "dim", t: "updated" }]} />
						<elapsed age={Date.now() - last} format="short" />
						<text spans={[{ s: "dim", t: "ago" }]} />
					</row>
				) : (
					<row role="omp.app.fresh" gap="xs" align="center">
						<spinner style="dots" />
						<text spans={[{ s: "dim", t: "updating" }]} />
					</row>
				)}
				<IconButton name="x" act="quit" title="Quit  q" aria="Quit" />
			</row>
		</row>
	);
}

function table(model: PsTopModel): JSXNode {
	const reports = model.reports();
	if (reports.length === 0) {
		const all = model.all();
		const hint: TspSpan[] = [
			{
				s: "muted",
				t: model.board()?.daemon ? "The omp daemon runs nothing here. " : "The omp daemon is not running. ",
			},
			{ s: "muted", t: all ? "Nothing runs anywhere." : "Show every scope with " },
		];
		if (!all) hint.push({ s: "key", t: "a" }, { s: "muted", t: "." });
		return (
			<col key="empty" role="omp.app.empty" gap="xs" align="center">
				<text text="No units" role="omp.app.empty-title" />
				<text spans={hint} />
			</col>
		);
	}
	const selected = model.current();
	return (
		<col key="scopes" role="omp.app.ps.scopes" gap="lg" grow={1}>
			{reports.map(report => (
				<section key={stableKey(scopeId(report.scope))} head={scopeSpans(report.scope)} role="omp.app.ps.scope">
					<list
						selected={selected && scopeId(selected.scope) === scopeId(report.scope) ? unitKey(selected) : null}
						empty="No units"
						role="omp.ps.processes"
					>
						{report.units.map(unit => (
							<UnitItem scope={report.scope} unit={unit} />
						))}
					</list>
				</section>
			))}
		</col>
	);
}

/** One selectable unit: name, state with its facts, the launch command. */
function UnitItem(props: { readonly scope: UnitScope; readonly unit: UnitSnapshot }): JSXNode {
	const unit = props.unit;
	const terminal = TERMINAL_STATES[unit.state] === true;
	const pids = pidsCell(unit);
	const idle = idleCell(unit);
	const meta = [
		unit.kind,
		pids === "-" ? undefined : `pid ${pids}`,
		terminal ? undefined : formatDuration(Date.now() - unit.startedAt),
		unit.leases > 0 ? `${unit.leases} lease${unit.leases === 1 ? "" : "s"}` : undefined,
		idle === "-" ? undefined : `idle ${idle}`,
		unit.restartCount > 0 ? `${unit.restartCount} restart${unit.restartCount === 1 ? "" : "s"}` : undefined,
		flagsCell(unit) || undefined,
	].filter(part => part !== undefined);
	const command = collapseCommand(unit.command);
	const tone = unitTone(unit);
	return (
		<item
			key={unitKey(props)}
			label={[{ s: terminal ? "dim" : "strong", t: unitName(unit) }]}
			detail={command ? [{ s: "mono muted", t: command }] : undefined}
			value={[
				{ s: tone === "muted" ? "dim" : tone, t: stateLabel(unit) },
				{ s: "muted", t: ` · ${meta.join(" · ")}` },
			]}
			icon={STATE_ICON[tone]}
			tone={tone}
			title={unitLabel(unit)}
		/>
	);
}

function info(model: PsTopModel): JSXNode {
	const info = model.info();
	if (!info) {
		return (
			<row key="info" gap="sm">
				<spinner style="dots" />
				<text spans={[{ s: "muted", t: "Loading…" }]} />
			</row>
		);
	}
	const { unit, proc } = info;
	const command = collapseCommand(formatCommand(proc) ?? unit.command);
	const cwd = proc?.cwd ?? unit.cwd;
	const items: { k: string; v: TspText }[] = [
		{ k: "Kind", v: unit.kind },
		{ k: "Key", v: [{ s: "mono", t: unit.key }] },
		{ k: "Id", v: [{ s: "mono", t: unit.id }] },
	];
	if (command) items.push({ k: "Command", v: [{ s: "mono", t: command }] });
	if (cwd) items.push({ k: "Directory", v: [{ s: "path", t: cwd }] });
	const pids = pidsCell(unit);
	if (pids !== "-") items.push({ k: "PID", v: [{ s: "num", t: pids }] });
	if (unit.exitReason) items.push({ k: "Exit", v: [{ s: "error", t: unit.exitReason }] });
	items.push({ k: "Restarts", v: `${unit.restartCount} (policy ${unit.policy.restart})` });
	items.push({ k: "Leases", v: String(unit.leases) });
	items.push({ k: "Idle", v: idleCell(unit) });
	items.push({ k: "Owner", v: unit.owner ?? "—" });
	const flags = [proc?.pty && "pty", `hold ${unit.policy.hold}`, `survive ${unit.policy.survive}`].filter(Boolean);
	items.push({ k: "Flags", v: flags.join(" · ") });
	return (
		<col key="info" role="omp.ps.info" gap="md">
			{!TERMINAL_STATES[unit.state] && (
				<row role="omp.app.fresh" gap="xs">
					<text spans={[{ s: "muted", t: "Up for" }]} />
					<elapsed age={Date.now() - unit.startedAt} format="short" />
				</row>
			)}
			<kv items={items} layout="grid" />
		</col>
	);
}

function logs(model: PsTopModel): JSXNode {
	const error = model.logsError();
	if (error) return <text key="logs" spans={[{ s: "error mono", t: error }]} wrap="word" role="omp.ps.logs" />;
	return <ansi key="logs" text={model.logsLines().join("\n")} follow role="omp.ps.logs" grow={1} />;
}

function actions(model: PsTopModel): JSXNode {
	const view = model.view();
	const row = model.current();
	const confirm = model.killConfirm();
	if (view === "table" && row && confirm !== undefined && confirm === row.unit.id) {
		const pids = pidsCell(row.unit);
		return (
			<row key="actions" role="omp.app.confirm" tone="error" gap="sm" align="center">
				<text
					spans={[
						{ s: "strong", t: `Kill ${unitName(row.unit)}${pids === "-" ? "" : ` (pid ${pids})`}?` },
						{ s: "muted", t: "  It stops at once, without cleanup." },
					]}
					truncate="end"
					grow={1}
				/>
				<Button act="kill-cancel" label="Cancel" />
				<Button act="kill-confirm" label="Kill" tone="error" />
			</row>
		);
	}
	let buttons: JSXNode;
	if (view !== "table") {
		buttons = [
			<Button act="back" label="Back" keys="escape" tone="accent" />,
			view === "info" && <Button act="logs" label="Logs" />,
		];
	} else if (!row) {
		buttons = [<spacer grow={1} />, <Button act="quit" label="Quit" keys="q" />];
	} else {
		buttons = [
			<Button act="info" label="Info" keys="enter" tone="accent" />,
			<Button act="logs" label="Logs" keys="l" />,
			<Button act="restart" label="Restart" keys="r" />,
			<Button act="stop" label="Stop" keys="s" />,
			<Button act="kill" label="Kill" keys="x" tone="error" title="Kill the process (asks first)" />,
			<spacer grow={1} />,
			<Button act="quit" label="Quit" keys="q" />,
		];
	}
	return (
		<row key="actions" role="omp.actions" gap="sm" align="center">
			{buttons}
		</row>
	);
}
