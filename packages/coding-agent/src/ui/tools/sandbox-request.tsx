/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `sandbox_request`: the agent asking for a path to write or read, a host to
 * reach, or an action outside the sandbox. The head names the kind and the
 * target; the body carries the agent's intent and, once answered, the
 * decision as a badge with the user's instructions or the refusal reason.
 * Waiting while the access dialog is open. All model and user text is
 * sanitized and bounded.
 *
 * Terminal look: `sandbox_request` (`src/ui/styles/tools/sandbox-request.ts`), fed by {@link SandboxRequestTerm}.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { plainLine } from "../../extensibility/inventory/display-text";
import {
	SANDBOX_KIND_VERBS,
	type SandboxRequestKind,
	type SandboxRequestToolDetails,
} from "../../tools/sandbox-request";
import { shortenPath } from "../../utils/render-utils";
import type { ToolPresenter, ToolResult, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

/** The tool's arguments, as streamed. */
export interface SandboxRequestArgs {
	readonly kind?: SandboxRequestKind;
	readonly target?: string;
	readonly intent?: string;
	readonly command?: string;
	readonly alternative?: string;
}

/** Rows a model- or user-written field wraps to before it is cut. */
export const SANDBOX_REQUEST_TEXT_ROWS = 4;
/** Characters kept of a model- or user-written field. */
const MAX_TEXT_CHARS = 1000;
/** The head note while the user decides. */
const WAITING_NOTE = "waiting for your answer";

/** Terminal-only facts of a `sandbox_request` card (`term`). */
export interface SandboxRequestTerm {
	readonly look: "sandbox_request";
	/** `verb target`, plain. */
	readonly target: string;
	readonly intent: string;
	/** The decision badge; absent while the user decides. */
	readonly badge?: Decision;
	/** The user's instructions or the refusal reason. */
	readonly note?: { readonly label: string; readonly text: string };
	/** Settled outcome; absent while the user decides. */
	readonly outcome?: Outcome;
}

/** A decision as its badge: label and tone (a theme color too). */
export interface Decision {
	readonly label: string;
	readonly tone: "success" | "muted" | "error" | "warning";
}

/** The card's outcome: its icon and tone. */
export type Outcome = "success" | "warning" | "error";

/** The decision badge: label and tone. */
function decision(details: SandboxRequestToolDetails): Decision {
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
function describeTarget(kind: unknown, target: unknown): string {
	const clean = typeof target === "string" ? plainLine(target) : "";
	const shown = kind === "host" || kind === "exec" ? clean : shortenPath(clean);
	// Streamed or invalid args may carry any kind: only a known one names a verb.
	const verb =
		typeof kind === "string" && Object.hasOwn(SANDBOX_KIND_VERBS, kind)
			? SANDBOX_KIND_VERBS[kind as SandboxRequestKind]
			: undefined;
	return verb ? `${verb} ${shown}`.trim() : shown;
}

/** One model- or user-written field as single-spaced plain text, bounded. */
function cleanText(value: unknown): string {
	return typeof value === "string" && value ? plainLine(value.slice(0, MAX_TEXT_CHARS)) : "";
}

/** The card a request shows, asked (`details` absent) or answered. */
function requestView(
	args: SandboxRequestArgs | undefined,
	details: SandboxRequestToolDetails | undefined,
	failed: boolean,
): ToolView {
	const kind = details?.kind ?? args?.kind;
	const target = describeTarget(kind, details && "target" in details ? details.target : args?.target);
	const badge = details ? decision(details) : undefined;
	const intent = cleanText(details?.intent ?? args?.intent);
	const note =
		details?.status === "instructed"
			? { label: "Instructions", text: cleanText(details.instructions) }
			: details?.status === "refused"
				? { label: "Reason", text: cleanText(details.reason) }
				: undefined;
	// A thrown tool (no details) is an error; a denial errors, a refusal or the user's instructions warn.
	const outcome: Outcome | undefined = !details
		? undefined
		: failed
			? "error"
			: badge?.tone === "error" || badge?.tone === "warning"
				? badge.tone
				: "success";
	const body: JSXNode[] = [];
	if (intent)
		body.push(
			<text
				key="intent"
				spans={[{ t: intent, s: "muted" }]}
				wrap="word"
				lines={SANDBOX_REQUEST_TEXT_ROWS}
				role="omp.tool.sandbox_request.intent"
			/>,
		);
	if (note?.text)
		body.push(
			<text
				key="note"
				spans={[{ t: `${note.label}: ${note.text}`, s: badge?.tone ?? "muted" }]}
				wrap="word"
				lines={SANDBOX_REQUEST_TEXT_ROWS}
				role="omp.tool.sandbox_request.note"
			/>,
		);
	return {
		head: {
			title: "Sandbox request",
			...(target ? { target, targetKind: "text" as const } : {}),
			...(badge ? { badges: [{ text: badge.label, tone: badge.tone }] } : {}),
			...(details ? {} : { note: WAITING_NOTE }),
		},
		...(body.length > 0 ? { body } : {}),
		...(outcome && outcome !== "success" ? { tone: outcome } : {}),
		term: {
			look: "sandbox_request",
			target,
			intent,
			...(badge ? { badge } : {}),
			...(note?.text ? { note } : {}),
			...(outcome ? { outcome } : {}),
		} satisfies SandboxRequestTerm,
	};
}

export const sandboxRequestPresenter: ToolPresenter<SandboxRequestArgs, SandboxRequestToolDetails> = {
	merge: true,
	call(args): ToolView {
		return requestView(args, undefined, false);
	},
	result(result: ToolResult<SandboxRequestToolDetails>, _state, args): ToolView {
		// Without details (schema, runtime, abort) the result text stands as the reason; the error flag sets the tone.
		return requestView(
			args,
			result.details ?? { status: "refused", reason: resultText(result) || "No result" },
			result.isError === true,
		);
	},
};

registerToolPresenter("sandbox_request", sandboxRequestPresenter);
