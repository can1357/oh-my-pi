/**
 * Card of the `sandbox_request` tool: the agent asking for a path to write or
 * read, or a host to reach. The head names the kind and the target; the body
 * carries the agent's intent and, once answered, the decision as a badge with
 * the user's instructions or the refusal reason. Pending while the dialog is
 * open. All model and user text is sanitized and bounded.
 */
import type { TspTone } from "@oh-my-pi/pi-wire";
import { compact } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import { plainLine } from "../native/spans";
import { sanitizeDisplayLines, shortenPath, truncateToWidth } from "../render/render-utils";
import { renderStatusLine } from "../render/status-line";
import { framedToolCard } from "../render/tool-card";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import { noteText, resultText } from "./native-view";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

export type SandboxRequestKind = "write" | "read" | "host";

/** The tool's arguments, as streamed. */
export interface SandboxRequestRenderArgs {
	kind?: SandboxRequestKind;
	target?: string;
	intent?: string;
	command?: string;
	alternative?: string;
}

/** The request's outcome (structurally the runtime's `SandboxAccessOutcome`) plus what was asked. */
export type SandboxRequestToolDetails = {
	kind?: SandboxRequestKind;
	intent?: string;
	command?: string;
	alternative?: string;
} & (
	| { status: "granted"; scope: "session" | "always"; target: string }
	| { status: "already-allowed"; target: string }
	| { status: "denied"; target: string }
	| { status: "instructed"; target: string; instructions: string }
	| { status: "refused"; reason: string }
);

const KIND_VERBS: Record<SandboxRequestKind, string> = { write: "write to", read: "read", host: "connect to" };
/** Rows a model- or user-written field wraps to before it is cut. */
const MAX_TEXT_ROWS = 4;
/** Characters kept of a model- or user-written field. */
const MAX_TEXT_CHARS = 1000;

/** The decision badge: label and tone. */
function decision(details: SandboxRequestToolDetails): { label: string; tone: TspTone & ThemeColor } {
	switch (details.status) {
		case "granted":
			return { label: details.scope === "always" ? "always allowed" : "allowed this session", tone: "success" };
		case "already-allowed":
			return { label: "already allowed", tone: "muted" };
		case "denied":
			return { label: "denied", tone: "error" };
		case "instructed":
			return { label: "instructed", tone: "warning" };
		case "refused":
			return { label: "refused", tone: "warning" };
	}
}

/** `verb target` for the head: the kind's verb and the cleaned (paths: home-shortened) target. */
function describeTarget(kind: SandboxRequestKind | undefined, target: string | undefined): string {
	const clean = plainLine(target ?? "");
	const shown = kind === "host" ? clean : shortenPath(clean);
	// Streamed or invalid args may carry any kind: only a known one names a verb.
	const verb = kind !== undefined && Object.hasOwn(KIND_VERBS, kind) ? KIND_VERBS[kind] : undefined;
	return verb ? `${verb} ${shown}`.trim() : shown;
}

/** One model- or user-written field as single-spaced plain text, bounded. */
function cleanText(value: string | undefined): string {
	if (!value) return "";
	return sanitizeDisplayLines(value.slice(0, MAX_TEXT_CHARS))
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.join(" ");
}

/** The body's facts: the intent, then the user's instructions or the refusal reason. */
function bodyFacts(
	args: SandboxRequestRenderArgs | undefined,
	details: SandboxRequestToolDetails | undefined,
): { intent: string; note?: { label: string; text: string } } {
	const intent = cleanText(details?.intent ?? args?.intent);
	if (details?.status === "instructed")
		return { intent, note: { label: "Instructions", text: cleanText(details.instructions) } };
	if (details?.status === "refused") return { intent, note: { label: "Reason", text: cleanText(details.reason) } };
	return { intent };
}

function wrapRows(content: string, width: number): string[] {
	const rows = Bun.wrapAnsi(content, Math.max(1, width), { hard: true }).split("\n");
	if (rows.length <= MAX_TEXT_ROWS) return rows;
	return [...rows.slice(0, MAX_TEXT_ROWS - 1), truncateToWidth(`${rows[MAX_TEXT_ROWS - 1]}…`, width)];
}

function ansiCard(
	uiTheme: Theme,
	args: SandboxRequestRenderArgs | undefined,
	details: SandboxRequestToolDetails | undefined,
	pending: { spinnerFrame?: number } | undefined,
): Component {
	const kind = details?.kind ?? args?.kind;
	const target = details && "target" in details ? details.target : args?.target;
	const badge = details ? decision(details) : undefined;
	const header = renderStatusLine(
		{
			icon: pending
				? pending.spinnerFrame !== undefined
					? "running"
					: "pending"
				: badge?.tone === "error"
					? "error"
					: "success",
			spinnerFrame: pending?.spinnerFrame,
			title: "Sandbox request",
			description: describeTarget(kind, target),
			badge: badge ? { label: badge.label, color: badge.tone } : undefined,
			meta: pending ? ["waiting for your answer"] : undefined,
		},
		uiTheme,
	);
	const facts = bodyFacts(args, details);
	return framedToolCard(uiTheme, ({ contentWidth }) => {
		const sections: { label?: string; content: string[] }[] = [];
		if (facts.intent)
			sections.push({ content: wrapRows(facts.intent, contentWidth).map(row => uiTheme.fg("muted", row)) });
		if (facts.note?.text) {
			sections.push({
				label: uiTheme.fg("toolTitle", facts.note.label),
				content: wrapRows(facts.note.text, contentWidth).map(row => uiTheme.fg(badge?.tone ?? "muted", row)),
			});
		}
		return {
			header,
			sections,
			phase: pending ? "partial" : badge?.tone === "error" ? "error" : "success",
			applyBg: false,
			borderColor: pending ? undefined : "dim",
		};
	});
}

function nativeView(
	args: SandboxRequestRenderArgs | undefined,
	details: SandboxRequestToolDetails | undefined,
): NativeToolView {
	const kind = details?.kind ?? args?.kind;
	const target = details && "target" in details ? details.target : args?.target;
	const badge = details ? decision(details) : undefined;
	const facts = bodyFacts(args, details);
	return {
		tool: {
			title: "Sandbox request",
			target: describeTarget(kind, target) || undefined,
			targetKind: "text",
			badges: badge ? [{ text: badge.label, tone: badge.tone }] : undefined,
			note: details ? undefined : "waiting for your answer",
		},
		body: compact([
			facts.intent ? noteText(facts.intent, "muted", MAX_TEXT_ROWS) : undefined,
			facts.note?.text
				? {
						...noteText(`${facts.note.label}: ${facts.note.text}`, badge?.tone ?? "muted", MAX_TEXT_ROWS),
						key: "note",
					}
				: undefined,
		]),
		tone: badge?.tone === "error" ? "error" : undefined,
	};
}

const callMemo = new OwnerMemo<NativeToolView>();
const resultMemo = new OwnerMemo<NativeToolView>();

/** Renders `sandbox_request` calls (pending while the user decides) and their outcome. */
export const sandboxRequestToolRenderer = {
	renderCall(args: SandboxRequestRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		return ansiCard(uiTheme, args, undefined, { spinnerFrame: options.spinnerFrame });
	},

	renderResult(
		result: ToolRenderResult<SandboxRequestToolDetails>,
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: SandboxRequestRenderArgs,
	): Component {
		const details = result.details;
		if (!details) {
			const fallback = { status: "refused", reason: resultText(result) || "No result" } as const;
			return ansiCard(uiTheme, args, fallback, undefined);
		}
		return ansiCard(uiTheme, args, details, undefined);
	},

	describeCall(args: SandboxRequestRenderArgs): NativeToolView {
		return callMemo.get(args, [args.kind, args.target, args.intent], () => nativeView(args, undefined));
	},

	describeResult(
		result: ToolRenderResult<SandboxRequestToolDetails>,
		_options: RenderResultOptions,
		args?: SandboxRequestRenderArgs,
	): NativeToolView {
		return resultMemo.get(result, [args], () =>
			nativeView(args, result.details ?? { status: "refused", reason: resultText(result) || "No result" }),
		);
	},

	mergeCallAndResult: true,
} satisfies ToolRenderer<SandboxRequestRenderArgs, SandboxRequestToolDetails>;
