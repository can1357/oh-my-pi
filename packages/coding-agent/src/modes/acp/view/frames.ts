import type { ToolOutcome } from "@oh-my-pi/pi-agent-core/presentation";
import { outcomeExitCode, outcomeFailed, outcomeSignal } from "@oh-my-pi/pi-agent-core/presentation";
import type { NonEmptyArray } from "@oh-my-pi/pi-utils/types";

/**
 * The exclusive ACP tool-frame union.
 *
 * Three review-finding classes are closed by *representation* here rather than by
 * a check after assembly:
 *
 * 1. **Terminal plus sibling content.** Zed's `has_terminals` drops every sibling
 *    `content` item beside a terminal item, so a frame that carries both is a
 *    silent data loss. The `terminal` variant's content is a one-element tuple of
 *    exactly one `TerminalContent`; there is no way to put anything next to it.
 * 2. **Ungated `_meta.terminal_*`.** Any {@link TerminalControlMeta} requires a
 *    {@link TerminalMetaCap} witness, minted only from capability negotiation.
 * 3. **Empty/no-op frames.** `changes` is a non-empty tuple, so a `status` frame
 *    that changes nothing is unrepresentable.
 *
 * Status is *computed*: {@link statusChangeForOutcome} is the only place
 * `completed`/`failed` comes from, and it reads the typed outcome. Paired with
 * `NonZeroExitCode` (which cannot be zero), "completed above a nonzero exit code"
 * stops being a runtime invariant and becomes a theorem.
 */

/** ACP tool-call status. */
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** ACP tool kind. */
export type AcpToolKind =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "think"
	| "fetch"
	| "switch_mode"
	| "other";

/** An absolute file location reported with a tool call. */
export interface AcpFrameLocation {
	readonly path: string;
	readonly line?: number;
}

/**
 * A scalar field change.
 *
 * An empty `locations` value is deliberately legal: it means "clear the existing
 * locations", which is a real operation, not a no-op.
 */
export type AcpStatusChange =
	| { readonly kind: "status"; readonly value: AcpToolStatus }
	| { readonly kind: "title"; readonly value: string }
	| { readonly kind: "tool_kind"; readonly value: AcpToolKind }
	| { readonly kind: "locations"; readonly value: readonly AcpFrameLocation[] };

/** The sole content item a terminal-bearing frame may carry. */
export interface TerminalContent {
	readonly type: "terminal";
	readonly terminalId: string;
}

/** An embedded resource's payload: text or binary, per the ACP `EmbeddedResourceResource` union. */
export type NonTerminalEmbeddedResource =
	| { readonly uri: string; readonly text: string; readonly mimeType?: string }
	| { readonly uri: string; readonly blob: string; readonly mimeType?: string };

/** Content a non-terminal frame may carry. */
export type NonTerminalContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string }
	| { readonly type: "audio"; readonly data: string; readonly mimeType: string }
	| { readonly type: "resource_link"; readonly uri: string; readonly name: string; readonly mimeType?: string }
	| { readonly type: "resource"; readonly resource: NonTerminalEmbeddedResource }
	| {
			readonly type: "diff";
			readonly path: string;
			readonly oldText: string | null;
			readonly newText: string | null;
	  };

declare const terminalMetaCapBrand: unique symbol;

/**
 * Proof that the client negotiated `_meta.terminal_output`.
 *
 * Minted only by {@link negotiateTerminalMetaCap} from the capability the client
 * advertised at `initialize`. Every terminal-meta constructor demands one, so an
 * ungated `_meta.terminal_*` write is a type error rather than something a
 * runtime invariant catches later.
 */
export interface TerminalMetaCap {
	readonly [terminalMetaCapBrand]: true;
}

/** Mint a {@link TerminalMetaCap} iff the client actually advertised the capability. */
export function negotiateTerminalMetaCap(capable: boolean): TerminalMetaCap | undefined {
	return capable ? ({} as TerminalMetaCap) : undefined;
}

declare const terminalControlMetaBrand: unique symbol;

/** `_meta.terminal_info` payload. */
export interface TerminalInfoMeta {
	readonly terminal_id: string;
	readonly cwd?: string;
}

/** `_meta.terminal_output` payload. Append-only bytes for an existing terminal id. */
export interface TerminalOutputMeta {
	readonly terminal_id: string;
	readonly data: string;
}

/** `_meta.terminal_exit` payload. */
export interface TerminalExitMeta {
	readonly terminal_id: string;
	readonly exit_code: number | null;
	readonly signal: string | null;
}

/** A gated bundle of `_meta.terminal_*` payloads. */
export interface TerminalControlMeta {
	readonly info?: TerminalInfoMeta;
	readonly output?: TerminalOutputMeta;
	readonly exit?: TerminalExitMeta;
	readonly [terminalControlMetaBrand]: true;
}

/** Parts a caller may put in a {@link TerminalControlMeta}. */
export interface TerminalControlMetaParts {
	readonly info?: TerminalInfoMeta;
	readonly output?: TerminalOutputMeta;
	readonly exit?: TerminalExitMeta;
}

/**
 * The sole constructor for `_meta.terminal_*`.
 *
 * Requires the capability witness and at least one payload — an empty terminal
 * meta would be an invisible no-op frame.
 */
export function buildTerminalControlMeta(_cap: TerminalMetaCap, parts: TerminalControlMetaParts): TerminalControlMeta {
	if (parts.info === undefined && parts.output === undefined && parts.exit === undefined) {
		throw new Error("TerminalControlMeta requires at least one of info/output/exit");
	}
	return {
		...(parts.info !== undefined ? { info: parts.info } : {}),
		...(parts.output !== undefined ? { output: parts.output } : {}),
		...(parts.exit !== undefined ? { exit: parts.exit } : {}),
	} as TerminalControlMeta;
}

/**
 * `_meta` for a non-terminal frame.
 *
 * Every `terminal_*` key is typed `never`, so a non-terminal frame cannot smuggle
 * terminal metadata past the witness.
 */
export type NonTerminalMeta = { readonly [key: string]: unknown } & {
	readonly [K in `terminal_${string}`]?: never;
};

/**
 * The raw arguments a client may inspect on an announcement.
 *
 * Deliberately *not* the tool's output: this is the call's **input**, which the
 * client already sent and which every ACP agent echoes (`claude-agent-acp` does, and
 * the permission request carries it too). An index signature of `unknown`, so
 * nothing can hide a typed result object in here.
 */
export type AcpRawInput = { readonly [key: string]: unknown };

/**
 * The bounded, redacted settlement marker the encoder puts in ACP's `rawOutput`.
 *
 * This is a compatibility escape hatch, and *only* that: "Built-ins omit
 * it by default. If a compatibility audit finds a real consumer, `rawOutput`
 * becomes a bounded, redacted, typed diagnostic projection minted by the same
 * encoder; it never carries presentation facts and is never a raw result
 * pass-through or a second display authority."
 *
 * The audit found one. Zed's `acp_thread.rs` reads `raw_output` twice:
 *  - `matches!(tool_call.status, Completed) && tool_call.raw_output.is_some()`
 *    classifies a `StopReason::Refusal` as *tool-output* refusal. Without the
 *    field, Zed instead treats the refusal as a rejection of the user's prompt and
 *    **truncates the whole visible turn** back to before that message.
 *  - a last-resort markdown render when a call's `content` is empty.
 *
 * So the field must be present-and-non-null on settlement, and must stay useless
 * as a display authority. Hence a closed three-field marker: no result text, no
 * output bytes, no notices, nothing a projection is responsible for. Its arity is
 * fixed by the type, so "bounded" is structural rather than a truncation cap, and
 * a raw result object is not even assignable here.
 */
export interface AcpToolDiagnostic {
	readonly kind: "tool_settlement";
	readonly tool: string;
	readonly outcome: "completed" | "failed";
}

/** Fields every frame carries. */
interface AcpToolFrameBase {
	readonly toolCallId: string;
	/**
	 * `true` for the first frame of a call, which the encoder emits as a
	 * `tool_call` announcement rather than a `tool_call_update`.
	 */
	readonly announce: boolean;
	/**
	 * The call's raw arguments, for the announcement only.
	 *
	 * Structured on the frame rather than smuggled through `changes`, because it is a
	 * scalar announcement field the ACP schema already has. Carried through from
	 * `ToolCallPresentation.rawInput`, which the encoder previously dropped on the
	 * floor — so a migrated call's card lost the command/arguments a client shows next
	 * to it.
	 */
	readonly rawInput?: AcpRawInput;
	/**
	 * The settlement marker for ACP `rawOutput`. Set only on a frame that settles a
	 * call; see {@link AcpToolDiagnostic} for why it exists and why it is this small.
	 */
	readonly diagnostic?: AcpToolDiagnostic;
	readonly changes?: NonEmptyArray<AcpStatusChange>;
}

/**
 * One ACP tool frame.
 *
 * `terminal_control` exists for contentless terminal output/exit updates. It is
 * what makes the `meta_terminal → content` transition expressible: the old
 * display-only terminal receives its exit *without* a terminal item sitting
 * beside the newly-arrived attachment content in the same frame.
 */
export type AcpToolFrame =
	| (AcpToolFrameBase & {
			readonly channel: "terminal";
			readonly content: readonly [TerminalContent];
			readonly meta?: TerminalControlMeta;
	  })
	| (AcpToolFrameBase & {
			readonly channel: "content";
			/** ACP content updates replace the prior content array; this is a complete snapshot. */
			readonly contentMode: "replacement_snapshot";
			readonly content: NonEmptyArray<NonTerminalContent>;
			readonly meta?: NonTerminalMeta;
	  })
	| (AcpToolFrameBase & {
			readonly channel: "terminal_control";
			readonly content?: never;
			readonly meta: TerminalControlMeta;
	  })
	| (AcpToolFrameBase & {
			readonly channel: "status";
			readonly content?: never;
			readonly changes: NonEmptyArray<AcpStatusChange>;
			readonly meta?: NonTerminalMeta;
	  });

/**
 * The single derivation of terminal status from an outcome.
 *
 * A timeout is `failed` here; its softer human severity is a projection concern
 * (`presentationSeverity`), not a third wire status.
 */
export function statusChangeForOutcome(outcome: ToolOutcome): AcpStatusChange {
	return { kind: "status", value: outcomeFailed(outcome) ? "failed" : "completed" };
}

/** The `terminal_exit` payload for an outcome, on a given terminal id. */
export function terminalExitForOutcome(terminalId: string, outcome: ToolOutcome): TerminalExitMeta {
	const code = outcomeExitCode(outcome);
	const signal = outcomeSignal(outcome);
	return {
		terminal_id: terminalId,
		exit_code: code ?? null,
		signal: signal ?? null,
	};
}

/** Assemble a non-empty change list, rejecting duplicate scalar keys. */
export function statusChanges(changes: readonly AcpStatusChange[]): NonEmptyArray<AcpStatusChange> | undefined {
	if (changes.length === 0) return undefined;
	const seen = new Set<AcpStatusChange["kind"]>();
	for (const change of changes) {
		if (seen.has(change.kind)) {
			throw new Error(`Duplicate ${change.kind} change in one ACP tool frame`);
		}
		seen.add(change.kind);
	}
	const [first, ...rest] = changes;
	if (first === undefined) return undefined;
	return [first, ...rest];
}

/** Assemble a non-empty content list. */
export function nonTerminalContent(
	items: readonly NonTerminalContent[],
): NonEmptyArray<NonTerminalContent> | undefined {
	const [first, ...rest] = items;
	if (first === undefined) return undefined;
	return [first, ...rest];
}
