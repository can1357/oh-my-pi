/**
 * What the sandbox access dialog shows: the agent's request (a path to write
 * or read, a host to reach, or an action omp performs outside the sandbox)
 * as a title and labeled fields, and the choices it offers.
 *
 * The intent, command and alternative are the model's text: every line is
 * sanitized (escapes and controls removed, tabs expanded) and bounded here;
 * the views wrap them to {@link MAX_INTENT_ROWS}, {@link MAX_EFFECT_ROWS} and
 * {@link MAX_ALTERNATIVE_ROWS} rows and clip the command to one row.
 */
import { sanitizeDisplayLine } from "../../../extensibility/inventory/display-text";
import type { SandboxAccessRequest } from "../../../sandbox/types";
import { SANDBOX_KIND_VERBS } from "../../../tools/sandbox-request";
import { sanitizeDisplayLines, shortenPath } from "../../../utils/render-utils";

/** The request as the dialog shows it; `effect` is omp's own statement (never the agent's text). */
export type SandboxAccessView = Pick<
	SandboxAccessRequest,
	"kind" | "target" | "intent" | "command" | "alternative" | "effect" | "canAlways"
>;

/** A choice the dialog offers. */
export type SandboxAccessChoice = "session" | "always" | "deny" | "instruct";

export const SANDBOX_ACCESS_CHOICE_LABELS: Readonly<Record<SandboxAccessChoice, string>> = {
	session: "Allow for this session",
	always: "Always allow (saved to global config)",
	deny: "Deny",
	instruct: "Reply with instructions…",
};

/** Characters kept of one model-written field before it is cut. */
const MAX_FIELD_CHARS = 2000;
/** Rows the intent wraps to before it is cut. */
export const MAX_INTENT_ROWS = 6;
/** Rows the effect wraps to before it is cut. */
export const MAX_EFFECT_ROWS = 5;
/** Rows the alternative wraps to before it is cut. */
export const MAX_ALTERNATIVE_ROWS = 3;

/** The request's displayed fields: every line clean, trailing blank lines dropped. */
interface SandboxAccessFields {
	/** `Sandbox request: <verb> <target>` (paths home-shortened). */
	readonly title: string;
	readonly intent: readonly string[];
	/** The command as one line; undefined when none was given. */
	readonly command?: string;
	readonly effect: readonly string[];
	readonly alternative: readonly string[];
}

/** Model text as display lines: control characters and escapes removed, tabs expanded, bounded. */
function cleanLines(value: string | undefined): string[] {
	if (!value) return [];
	const lines = sanitizeDisplayLines(value.slice(0, MAX_FIELD_CHARS)).map(line => line.trimEnd());
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return lines;
}

export function sandboxAccessFields(view: SandboxAccessView): SandboxAccessFields {
	const target = sanitizeDisplayLine(view.target);
	const shown = view.kind === "host" || view.kind === "exec" ? target : shortenPath(target);
	const command = cleanLines(view.command).join(" ").trim();
	return {
		title: `Sandbox request: ${SANDBOX_KIND_VERBS[view.kind]} ${shown}`,
		intent: cleanLines(view.intent),
		...(command ? { command } : {}),
		effect: cleanLines(view.effect),
		alternative: cleanLines(view.alternative),
	};
}

/** The choices in order; Always allow only when the backing list can be saved. */
export function sandboxAccessChoices(canAlways: boolean): readonly SandboxAccessChoice[] {
	return canAlways ? ["session", "always", "deny", "instruct"] : ["session", "deny", "instruct"];
}
