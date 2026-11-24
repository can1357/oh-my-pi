/**
 * CLI handler for `omp ps`: the board of the per-user omp daemon, inspected
 * and controlled from outside the harness.
 *
 * A bare `omp ps` on a TTY opens the interactive alt-screen monitor
 * (`ui/apps/ps-top`); `--plain`, `--json`, and non-TTY outputs use the static
 * listing. Listing never starts the daemon (it reads the daemon's store when
 * none runs); actions (`info`, `logs`, `stop`, `kill`, `restart`, `send`,
 * `mode`) connect through the shared client, which starts the daemon so it can
 * re-adopt detached units before acting on them.
 */

import { truncateToWidth } from "../utils/text-width";
import {
	daemonHeader,
	formatCommand,
	type PsBoard,
	type PsScopeReport,
	scopeHeader,
	TABLE_HEADER,
	TERMINAL_STATES,
	tableCells,
	unitLabel,
	unitName,
} from "./ps-model";
import { PsTop, PsTopModel } from "../ui/apps/ps-top";
import { runStandalone } from "../ui/apps/fullscreen";
import { type PsTopHost } from "../modes/view-model/apps/ps-top";
import { formatDuration } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { closeDaemonClient, daemonClient, probeDaemon } from "../daemon/client";
import type { DaemonClient, DaemonSignal, UnitSnapshot } from "../daemon/protocol";
import { isSharedBrowserUnit, restartSharedBrowser } from "../tools/browser/shared-daemon";
import { collectBoard, KILL_GRACE_MS, resolveUnit } from "./ps-data";

export type PsAction = "list" | "info" | "logs" | "stop" | "kill" | "restart" | "send" | "mode";

const SIGNALS: readonly DaemonSignal[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL"];
const MODES = ["persist", "session", "detached"] as const;

export interface PsCommandArgs {
	action: PsAction;
	/** Unit id, key, or label; required for every action except `list`. */
	name?: string;
	/** send: input written to the unit's stdin; mode: `persist`, `session`, or `detached`. */
	value?: string;
	flags: {
		/** list: every scope (other projects and sessions) instead of the current project and global units. */
		all: boolean;
		json: boolean;
		/** list: force the static listing instead of the interactive monitor. */
		plain: boolean;
		/** Target another project directory instead of the current one. */
		dir?: string;
		/** logs: keep streaming new output. */
		follow: boolean;
		/** logs: read from the beginning instead of the tail. */
		head: boolean;
		/** logs: number of lines. */
		lines?: number;
		/** logs: regex filter. */
		grep?: string;
		/** stop: grace period in seconds before hard kill. */
		timeout?: number;
		/** send: signal delivered to the unit instead of (or after) stdin input. */
		signal?: string;
	};
}

/**
 * Restart a unit. The project-shared browsers restart through their profile
 * claim so Chromium does not reopen the previous process's pages.
 */
async function restartUnit(client: DaemonClient, unit: UnitSnapshot): Promise<UnitSnapshot> {
	if (isSharedBrowserUnit(unit)) return restartSharedBrowser(unit);
	return (await client.request({ op: "restart", unit: unit.id })).unit;
}

/** Stop the listed generation; the daemon leaves a newer one running, which is reported rather than printed as stopped. */
async function stopUnit(client: DaemonClient, unit: UnitSnapshot, timeoutMs: number): Promise<UnitSnapshot> {
	const current = (await client.request({ op: "stop", unit: unit.id, timeoutMs, generation: unit.generation })).unit;
	if (current.generation !== unit.generation && !TERMINAL_STATES[current.state]) {
		throw new Error(`${unitName(unit)} was restarted since it was listed and was left running; list it again`);
	}
	return current;
}

/** Monitor host: listing over a non-spawning probe connection, actions over the shared client. */
function createPsTopHost(): PsTopHost {
	let probe: DaemonClient | undefined;
	let unwatch: (() => void) | undefined;
	let onChange: (() => void) | undefined;
	let closed = false;
	const dropProbe = (): void => {
		unwatch?.();
		unwatch = undefined;
		probe?.close();
		probe = undefined;
	};
	const liveProbe = async (): Promise<DaemonClient | undefined> => {
		if (probe) return probe;
		const client = await probeDaemon();
		if (!client) return undefined;
		if (closed) {
			client.close();
			return undefined;
		}
		probe = client;
		if (onChange) unwatch = client.onUnit(onChange);
		return client;
	};
	return {
		async collectBoard(all, target) {
			const client = await liveProbe();
			try {
				return await collectBoard(client, all, target);
			} catch (error) {
				if (!client) throw error;
				// The daemon went away mid-query; show its stored units instead.
				dropProbe();
				return collectBoard(undefined, all, target);
			}
		},
		watch(sink) {
			onChange = sink;
			if (probe && !unwatch) unwatch = probe.onUnit(sink);
			return () => {
				onChange = undefined;
				unwatch?.();
				unwatch = undefined;
			};
		},
		async act(unit, verb) {
			const client = await daemonClient();
			if (verb === "restart") return restartUnit(client, unit);
			return stopUnit(client, unit, verb === "kill" ? KILL_GRACE_MS : 5_000);
		},
		async describe(unit) {
			const client = await daemonClient();
			return client.request({ op: "describe", unit: unit.id });
		},
		async logs(unit, lines) {
			const client = await daemonClient();
			const result = await client.request({
				op: "logs",
				unit: unit.id,
				lines,
				head: false,
				follow: false,
				timeoutMs: 10_000,
			});
			return { text: result.text, terminalOutput: result.terminalOutput, state: result.unit.state };
		},
		close() {
			closed = true;
			dropProbe();
		},
	};
}

/** The interactive monitor (`omp ps` on a TTY) until the user quits. */
function runPsTop(flags: PsCommandArgs["flags"], host: PsTopHost): Promise<void> {
	return runStandalone({ title: "omp ps" }, screen => {
		const done = Promise.withResolvers<void>();
		const model = new PsTopModel(host, {
			all: flags.all,
			dir: flags.dir,
			rows: screen.rows,
			onQuit: () => done.resolve(),
		});
		model.run();
		return { view: () => PsTop({ model }), done: done.promise, dispose: () => model.dispose() };
	});
}

/** Run the board listing or a unit action. */
export async function runPsCommand(cmd: PsCommandArgs): Promise<void> {
	try {
		if (cmd.action === "list") {
			const interactive =
				!cmd.flags.json && !cmd.flags.plain && process.stdout.isTTY === true && process.stdin.isTTY === true;
			if (interactive) await runPsTop(cmd.flags, createPsTopHost());
			else await runList(cmd);
			return;
		}
		if (!cmd.name) {
			console.error(chalk.red(`${cmd.action} requires a unit name or id. Run \`omp ps\` to list units.`));
			process.exitCode = 1;
			return;
		}
		await runAction(cmd, cmd.name);
	} finally {
		await closeDaemonClient();
	}
}

// ---------------------------------------------------------------------------
// Static list
// ---------------------------------------------------------------------------

async function runList(cmd: PsCommandArgs): Promise<void> {
	const probe = await probeDaemon();
	let board: PsBoard;
	try {
		board = await collectBoard(probe, cmd.flags.all, cmd.flags);
	} finally {
		probe?.close();
	}
	if (cmd.flags.json) {
		console.log(JSON.stringify(board, null, 2));
		return;
	}
	console.log(daemonHeader(board.daemon));
	if (board.reports.length === 0) {
		console.log(chalk.dim("\nNo units."));
	}
	for (const report of board.reports) {
		console.log("");
		console.log(scopeHeader(report.scope));
		printTable(report);
	}
	if (!cmd.flags.all) {
		console.log(chalk.dim("\nUse --all to include other projects and sessions."));
	}
}

function printTable(report: PsScopeReport): void {
	// Truncate to the terminal on a TTY; keep full lines when piped.
	const maxWidth = process.stdout.isTTY ? (process.stdout.columns ?? 120) : Number.POSITIVE_INFINITY;
	const cells = report.units.map(tableCells);
	const widths = TABLE_HEADER.map((title, column) =>
		Math.max(title.length, ...cells.map(row => Bun.stringWidth(row[column]))),
	);
	const render = (row: string[]): string => {
		const line =
			`  ${row.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - Bun.stringWidth(cell)))).join("  ")}`.trimEnd();
		return Number.isFinite(maxWidth) ? truncateToWidth(line, maxWidth) : line;
	};
	console.log(chalk.dim(render([...TABLE_HEADER])));
	for (const [index, row] of cells.entries()) {
		const line = render(row);
		console.log(TERMINAL_STATES[report.units[index].state] ? chalk.dim(line) : line);
	}
}

// ---------------------------------------------------------------------------
// Unit actions
// ---------------------------------------------------------------------------

async function runAction(cmd: PsCommandArgs, name: string): Promise<void> {
	try {
		const client = await daemonClient();
		const unit = await resolveUnit(client, name, cmd.flags);
		switch (cmd.action) {
			case "info": {
				const { unit: current, proc } = await client.request({ op: "describe", unit: unit.id });
				if (cmd.flags.json) {
					console.log(JSON.stringify({ ...current, proc }, null, 2));
					return;
				}
				console.log(unitLabel(current));
				console.log(`  id:       ${current.id}`);
				console.log(`  scope:    ${scopeHeader(current.scope)}`);
				const command = formatCommand(proc) ?? current.command;
				if (command) console.log(`  command:  ${command}`);
				const cwd = proc?.cwd ?? current.cwd;
				if (cwd) console.log(`  cwd:      ${cwd}`);
				if (!TERMINAL_STATES[current.state])
					console.log(`  uptime:   ${formatDuration(Date.now() - current.startedAt)}`);
				if (current.exitReason) console.log(`  exit:     ${current.exitReason}`);
				console.log(`  restarts: ${current.restartCount} (policy: ${current.policy.restart})`);
				console.log(
					`  hold: ${current.policy.hold}  survive: ${current.policy.survive}  leases: ${current.leases}  pty: ${proc?.pty ?? false}  owner: ${current.owner ?? "-"}`,
				);
				if (current.idleAt !== undefined)
					console.log(`  idle:     stops in ${formatDuration(Math.max(0, current.idleAt - Date.now()))}`);
				return;
			}
			case "logs":
				await runLogs(cmd, client, unit);
				return;
			case "stop":
			case "kill": {
				const timeoutMs = cmd.action === "kill" ? KILL_GRACE_MS : Math.round((cmd.flags.timeout ?? 5) * 1000);
				printUnitResult(cmd, cmd.action === "kill" ? "Killed" : "Stopped", await stopUnit(client, unit, timeoutMs));
				return;
			}
			case "restart":
				printUnitResult(cmd, "Restarted", await restartUnit(client, unit));
				return;
			case "send": {
				const signalName = cmd.flags.signal?.toUpperCase();
				const signal = SIGNALS.find(candidate => candidate === signalName);
				if (signalName !== undefined && signal === undefined)
					throw new Error(`Signal must be one of ${SIGNALS.join(", ")}`);
				if (cmd.value === undefined && signal === undefined)
					throw new Error("send requires input text or --signal");
				const result = await client.request({
					op: "send",
					unit: unit.id,
					data: cmd.value,
					signal,
				});
				printUnitResult(cmd, "Sent to", result.unit);
				return;
			}
			case "mode": {
				const mode = MODES.find(candidate => candidate === cmd.value);
				if (!mode) throw new Error(`mode requires one of ${MODES.join(", ")}`);
				printUnitResult(cmd, `Mode ${mode}:`, (await client.request({ op: "mode", unit: unit.id, mode })).unit);
				return;
			}
			default:
				throw new Error(`Unhandled action ${cmd.action}`);
		}
	} catch (error) {
		console.error(chalk.red(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

function printUnitResult(cmd: PsCommandArgs, verb: string, unit: UnitSnapshot): void {
	if (cmd.flags.json) console.log(JSON.stringify(unit, null, 2));
	else console.log(`${verb} ${unitLabel(unit)}`);
}

async function runLogs(cmd: PsCommandArgs, client: DaemonClient, unit: UnitSnapshot): Promise<void> {
	const lines = Math.max(1, Math.min(1_000, Math.floor(cmd.flags.lines ?? 100)));
	// Follow mode reads the full 1000-line window on every request so overlap
	// trimming sees a stable, sliding tail; the initial print is cut to `lines`.
	const first = await client.request({
		op: "logs",
		unit: unit.id,
		lines: cmd.flags.follow ? 1_000 : lines,
		head: cmd.flags.head,
		grep: cmd.flags.grep,
		follow: false,
		timeoutMs: 30_000,
	});
	const name = unit.key;
	if (!cmd.flags.follow) {
		const text = (first.terminalOutput || first.text).replace(/\n$/, "");
		if (text) console.log(text);
		console.log(chalk.dim(`[${name}: ${first.unit.state}]`));
		return;
	}
	const initial = first.text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
	if (initial) process.stdout.write(`${initial}\n`);
	let previous = first.text;
	let cursor = first.cursor;
	let state = first.unit.state;
	while (!TERMINAL_STATES[state]) {
		const next = await client.request({
			op: "logs",
			unit: unit.id,
			lines: 1_000,
			head: false,
			grep: cmd.flags.grep,
			follow: true,
			cursor,
			timeoutMs: 30_000,
		});
		// The daemon always returns the tail window (cursor is only a wait
		// watermark), so trim the part we already printed.
		const fresh = next.text.slice(overlapLength(previous, next.text));
		if (fresh) process.stdout.write(fresh.endsWith("\n") ? fresh : `${fresh}\n`);
		previous = next.text;
		cursor = next.cursor;
		state = next.unit.state;
	}
	console.log(chalk.dim(`[${name}: ${state}]`));
}

/** Longest suffix of `previous` that is a prefix of `next` — the already-printed portion of a tail window. */
function overlapLength(previous: string, next: string): number {
	for (let k = Math.min(previous.length, next.length); k > 0; k--) {
		const offset = previous.length - k;
		let match = true;
		for (let i = 0; i < k; i++) {
			if (previous.charCodeAt(offset + i) !== next.charCodeAt(i)) {
				match = false;
				break;
			}
		}
		if (match) return k;
	}
	return 0;
}
