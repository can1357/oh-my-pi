/**
 * Tool card chrome + per-tool dispatch. Works in the collab-web app and inside
 * the `<omp-tool-view>` web component embedded in HTML session exports.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { useState } from "react";
import { ElidedImage, LoadFull } from "./parts";
import { resolveToolRenderer } from "./registry";
import type { ToolRenderHost, ToolRenderProps, ToolResultLike } from "./types";
import { elidedImagesOf, isRecord, replaceTabs, stripAnsi } from "./util";
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
	const intent = typeof raw[INTENT_FIELD] === "string" ? (raw[INTENT_FIELD] as string).trim() : undefined;
	if (!(INTENT_FIELD in raw)) return { args: raw, intent };
	const args: Record<string, unknown> = {};
	for (const k in raw) {
		if (k !== INTENT_FIELD) args[k] = raw[k];
	}
	return { args, intent };
}

interface XdevDispatch {
	tool: string;
	args: Record<string, unknown>;
	inner: unknown;
}

function executeXdevDispatch(props: ToolViewProps): XdevDispatch | null {
	if (props.name !== "write" || props.result?.isError === true || !isRecord(props.result?.details)) return null;
	const xdev = props.result.details.xdev;
	if (!isRecord(xdev) || xdev.mode !== "execute" || typeof xdev.tool !== "string") return null;
	return { tool: xdev.tool, args: isRecord(xdev.args) ? xdev.args : {}, inner: xdev.inner };
}

export function ToolView(props: ToolViewProps): ReactNode {
	const [open, setOpen] = useState(props.defaultOpen ?? false);
	const xdev = executeXdevDispatch(props);
	const { args, intent: argIntent } = normalizeArgs(props.args);
	const intent = props.intent?.trim() || argIntent;
	const name = xdev?.tool ?? props.name;
	const result = xdev ? { ...props.result!, details: xdev.inner } : props.result;
	const renderer = resolveToolRenderer(name);
	const renderProps: ToolRenderProps = {
		name,
		args: xdev?.args ?? args,
		result,
		running: props.running,
		host: props.host,
	};

	const isError = props.result?.isError === true;
	const status = props.running ? "run" : isError ? "err" : props.result ? "ok" : "pending";
	const partial = props.running && !props.result && props.partial ? stripAnsi(replaceTabs(props.partial)) : "";
	// The card, not each renderer, offers trimmed images, so every renderer's
	// results can load them; each gets its own tile (the renderer already shows
	// the host's text placeholder), and "load full output" covers the rest.
	const elidedImages = elidedImagesOf(result);
	const canLoad = props.host?.loadFull !== undefined && result?.entryId !== undefined;
	const trimmed = result?.collabElided?.filter(record => !elidedImages.includes(record)) ?? [];

	return (
		<div className={`tv-card${isError ? " tv-card--error" : ""}`}>
			<button
				type="button"
				className="tv-head"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
				title={intent || undefined}
			>
				{status === "run" ? (
					<span className="tv-spin" aria-label="running" />
				) : (
					<span className={`tv-status tv-status--${status}`} aria-hidden="true" />
				)}
				<span className="tv-name">{xdev ? `xd://${name}` : name}</span>
				<span className="tv-sum">
					<renderer.Summary {...renderProps} />
				</span>
				<span className="tv-chev" aria-hidden="true" />
			</button>
			{open && (
				<div className="tv-body">
					{intent && <div className="tv-intent">{intent}</div>}
					{renderer.Body ? <renderer.Body {...renderProps} /> : null}
					{canLoad && elidedImages.length > 0 && (
						<div className="tv-imgs">
							{elidedImages.map(elided => (
								<ElidedImage
									key={elided.path.join(".")}
									host={props.host}
									entryId={result?.entryId}
									elided={elided}
								/>
							))}
						</div>
					)}
					<LoadFull host={props.host} entryId={result?.entryId} records={trimmed} label="load full output" />
				</div>
			)}
			{partial && <pre className="tv-partial">{partial.length > 2048 ? `…${partial.slice(-2048)}` : partial}</pre>}
		</div>
	);
}
