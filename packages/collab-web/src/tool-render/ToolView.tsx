/**
 * Tool card chrome + per-tool dispatch. Works in the collab-web app and inside
 * the `<omp-tool-view>` web component embedded in HTML session exports.
 */
import { INTENT_FIELD, toolIntentLabel } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useState } from "react";
import { resolveToolRenderer } from "./registry";
import type { ToolRenderHost, ToolRenderProps, ToolResultLike } from "./types";
import { isRecord, replaceTabs, stripAnsi } from "./util";
import "./tool-render.css";

export interface ToolViewProps {
	name: string;
	args?: unknown;
	result?: ToolResultLike;
	/** Tool is still executing (live collab view). */
	running?: boolean;
	/** Model-provided intent (`i`), shown atop the body. */
	intent?: string;
	/** Streaming partial output tail while running. */
	partial?: string;
	defaultOpen?: boolean;
	/** Host capabilities (sub-session drill-down, …). */
	host?: ToolRenderHost;
}

function normalizeArgs(raw: unknown): { args: Record<string, unknown>; intent: string | undefined } {
	if (!isRecord(raw)) return { args: {}, intent: undefined };
	const rawIntent = raw[INTENT_FIELD];
	const intent = typeof rawIntent === "string" ? rawIntent.trim() : undefined;
	if (!(INTENT_FIELD in raw)) return { args: raw, intent };
	const args: Record<string, unknown> = {};
	for (const k in raw) {
		if (k !== INTENT_FIELD) args[k] = raw[k];
	}
	return { args, intent };
}

/** One tool-command invocation nested in a completed `bash` result. */
interface ToolCommandRecord {
	tool: string;
	mode: "help" | "execute";
	exitCode: number;
	args?: Record<string, unknown>;
	inner?: unknown;
}

/** `details.toolCommands` records of a bash result, in invocation order. */
function toolCommandRecords(result: ToolResultLike | undefined): ToolCommandRecord[] {
	if (!result || !isRecord(result.details)) return [];
	const raw = result.details.toolCommands;
	if (!Array.isArray(raw)) return [];
	const records: ToolCommandRecord[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		const { tool, mode, exitCode } = item;
		if (typeof tool !== "string" || typeof exitCode !== "number") continue;
		if (mode !== "help" && mode !== "execute") continue;
		records.push({
			tool,
			mode,
			exitCode,
			args: isRecord(item.args) ? item.args : undefined,
			inner: item.inner,
		});
	}
	return records;
}

export function ToolView(props: ToolViewProps): ReactNode {
	const [open, setOpen] = useState(props.defaultOpen ?? false);
	const { args, intent: argIntent } = normalizeArgs(props.args);
	const intent = props.intent?.trim() || argIntent;
	const label = intent ? toolIntentLabel(intent) : undefined;
	const renderer = resolveToolRenderer(props.name);
	const renderProps: ToolRenderProps = {
		name: props.name,
		args,
		result: props.result,
		running: props.running,
		host: props.host,
	};
	const commands = props.name === "bash" ? toolCommandRecords(props.result) : [];

	const isError = props.result?.isError === true;
	const status = props.running ? "run" : isError ? "err" : props.result ? "ok" : "pending";
	const partial = props.running && !props.result && props.partial ? stripAnsi(replaceTabs(props.partial)) : "";

	return (
		<>
			<div className={`tv-card${isError ? " tv-card--error" : ""}`}>
				<button
					type="button"
					className="tv-head"
					aria-expanded={open}
					onClick={() => setOpen(v => !v)}
					title={label}
				>
					{status === "run" ? (
						<span className="tv-spin" aria-label="running" />
					) : (
						<span className={`tv-status tv-status--${status}`} aria-hidden="true" />
					)}
					<span className="tv-name">{props.name}</span>
					<span className="tv-sum">
						<renderer.Summary {...renderProps} />
					</span>
					<span className="tv-chev" aria-hidden="true" />
				</button>
				{open && (
					<div className="tv-body">
						{label && <div className="tv-intent">{label}</div>}
						{renderer.Body ? <renderer.Body {...renderProps} /> : null}
					</div>
				)}
				{partial && (
					<pre className="tv-partial">{partial.length > 2048 ? `…${partial.slice(-2048)}` : partial}</pre>
				)}
			</div>
			{commands.length > 0 && (
				<div className="tv-cells">
					{commands.map((record, index) =>
						record.mode === "execute" ? (
							<ToolView
								key={index}
								name={record.tool}
								args={record.args ?? {}}
								result={{ content: [], details: record.inner, isError: record.exitCode !== 0 }}
								host={props.host}
							/>
						) : (
							<div className="tv-cmd" key={index}>
								<span className="tv-cmd-text">{`${record.tool} --help`}</span>
							</div>
						),
					)}
				</div>
			)}
		</>
	);
}
