import type {
	ByteOffset,
	FactId,
	Sequence,
	ToolAttachment,
	ToolCallPresentation,
	ToolDisplayOutput,
	ToolFact,
	ToolOutcome,
	ToolPresentationEvent,
} from "@oh-my-pi/pi-agent-core/presentation";
import { byteLengthOf } from "@oh-my-pi/pi-agent-core/presentation";
import type { NonEmptyArray } from "@oh-my-pi/pi-utils/types";
import {
	factsFor,
	fenceBlock,
	outputSegmentSeparator,
	renderDisplayOutput,
	renderExitNotice,
	renderFact,
	renderFactText,
	renderSettlementReason,
	renderToolOutputSegments,
	type ToolOutputSegment,
} from "../../../presentation/projections";
import { utf8PrefixWithin } from "../../../presentation/utf8";
import type {
	AcpStatusChange,
	AcpToolDiagnostic,
	AcpToolFrame,
	AcpToolKind,
	NonTerminalContent,
	TerminalMetaCap,
	TerminalOutputMeta,
} from "./frames";
import {
	buildTerminalControlMeta,
	nonTerminalContent,
	statusChangeForOutcome,
	statusChanges,
	terminalExitForOutcome,
} from "./frames";

/**
 * `reduceAcpToolView` — one state machine that owns every ACP tool frame.
 *
 * The exclusive frame union alone cannot guarantee that every fact lands on *some*
 * channel in *each* capability mode; that was the "a branch dropped a fact" class
 * (eval-image fallback, notice drops). Here a single reducer owns start, progress
 * and settlement plus every legal channel transition, and assigns each fact a
 * delivery receipt or an explicit typed suppression reason.
 *
 * Continuity is *asserted*, not inferred: sequences must be strictly increasing
 * and `startByte` must equal the reducer's own cursor. Byte offsets make a missing
 * or duplicated event observable even when its text repeats, which is exactly what
 * no overlap search over re-rendered snapshot windows could ever do.
 * There is no overlap scan, no watermark, and no re-render classifier in this file.
 */

/** Terminal capability during replay: never a live client-owned terminal. */
export type ReplayTerminalCapability =
	| { readonly kind: "none" }
	| { readonly kind: "meta_only"; readonly cap: TerminalMetaCap };

/** Terminal capability during live execution. */
export type LiveTerminalCapability =
	| ReplayTerminalCapability
	| { readonly kind: "real"; readonly metaCap: TerminalMetaCap | undefined };

/**
 * Render context: a phase crossed with a terminal capability.
 *
 * Replay is a *phase*, not a render mode — replay can still use a meta terminal or
 * plain content, but can never hold a live client-owned terminal, which is why its
 * capability type excludes `real`.
 */
export type AcpRenderContext =
	| {
			readonly phase: "live";
			readonly terminal: LiveTerminalCapability;
			readonly cwd?: string;
			/** Whether plain content should be fenced (a client that renders Markdown). */
			readonly fence: boolean;
	  }
	| {
			readonly phase: "replay";
			readonly terminal: ReplayTerminalCapability;
			readonly cwd?: string;
			readonly fence: boolean;
	  };

/**
 * The channel a call renders through, as one discriminant.
 *
 * `meta_terminal` is a *display-only* terminal keyed by the tool call's own id;
 * `plain` accumulates and delivers content at settlement. A real client-owned
 * terminal is not a third mode here — it arrives as a `live_terminal_attached`
 * event and transitions whichever mode was chosen, which is why the capability
 * type and the mode are different things.
 */
export type AcpToolRenderMode =
	| { readonly mode: "meta_terminal"; readonly cap: TerminalMetaCap }
	| { readonly mode: "plain" };

/**
 * The terminal-meta witness this context carries, whatever kind of terminal
 * capability it describes.
 *
 * A terminal-capable client that also negotiated `_meta.terminal_output` has
 * *both*: `#buildRenderContext` reports `{kind:"real", metaCap}`, and forgetting
 * that `metaCap` is how a fact on a live-terminal call ended up suppressed as
 * having "no capable channel" on a client that had one.
 */
export function terminalMetaCapOf(terminal: LiveTerminalCapability): TerminalMetaCap | undefined {
	switch (terminal.kind) {
		case "none":
			return undefined;
		case "meta_only":
			return terminal.cap;
		case "real":
			return terminal.metaCap;
		default: {
			const exhaustive: never = terminal;
			throw new Error(`Unhandled terminal capability: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/**
 * The **single** derivation of a call's render mode.
 *
 * A call that explicitly awaits a live terminal starts plain while its tool is
 * allocating that client-owned resource; only the typed `live_terminal_attached`
 * event may introduce it. All other execute routes preserve their display-only
 * meta-terminal frame design on clients that negotiated terminal metadata.
 */
export function selectAcpToolRenderMode(context: AcpRenderContext, call: ToolCallPresentation): AcpToolRenderMode {
	// The Bash client-terminal route is the only current caller that promises a
	// later live binding. Keep every other real-terminal route on its existing
	// display-only meta-terminal path; otherwise local Bash/PTY and eval would
	// silently change their initial literal frames just because a client advertises
	// terminal/create.
	if (call.awaitsLiveTerminal) return { mode: "plain" };
	const cap = terminalMetaCapOf(context.terminal);
	return cap !== undefined && call.kind === "execute" ? { mode: "meta_terminal", cap } : { mode: "plain" };
}

/** Where a fact, byte span, or attachment was delivered — or why it deliberately was not. */
export type DeliveryReceipt =
	| { readonly kind: "fact"; readonly factId: FactId; readonly channel: FactChannel }
	| { readonly kind: "fact_suppressed"; readonly factId: FactId; readonly reason: FactSuppressionReason }
	| { readonly kind: "attachment_suppressed"; readonly reason: FactSuppressionReason }
	| {
			readonly kind: "stream";
			readonly fromByte: ByteOffset;
			readonly toByte: ByteOffset;
			readonly channel: "terminal_output" | "content";
	  }
	| {
			readonly kind: "stream_suppressed";
			readonly fromByte: ByteOffset;
			readonly toByte: ByteOffset;
			readonly reason: FactSuppressionReason;
	  }
	| { readonly kind: "stream_gap"; readonly fromByte: ByteOffset; readonly toByte: ByteOffset };

/** Channels a fact can ride. */
export type FactChannel = "terminal_output" | "content" | "status";

/** The only legal reasons a fact is not delivered on a channel. */
export type FactSuppressionReason =
	/** Model-only audience and this is a human-facing wire. */
	| "audience_model_only"
	/** The client negotiated no channel that can carry it (no terminal, no content). */
	| "no_capable_channel";

/**
 * Head-window cap on the cumulative "process" (raw stream) text this reducer
 * retains in `segments` for the `plain`/`meta_terminal` states' eventual
 * settlement content — the shared feed `OutputSink` writes to is unbounded
 * now (every `terminal_append` reaches the wire live, in full — see
 * `streaming-output.ts#appendToPresentation`), but this reducer
 * still accumulates process text for later replay (a `plain` call's one
 * settlement content snapshot, a `meta_terminal` call's rare
 * attachment-transition snapshot — see `buildReplacementSnapshotContent`),
 * and an unbounded accumulation there would just relocate the memory hazard
 * removed from the feed. Bytes past the window are dropped from what's
 * retained; the live per-event frames this reducer emits (`reduceAppend`'s
 * `meta_terminal` arm) carry `event.data` directly, never `segments` — so
 * wire delivery itself stays uncapped.
 */
export const PROCESS_TEXT_HEAD_WINDOW_BYTES = 1024 * 1024; // 1 MiB

type RenderSegment = ToolOutputSegment & {
	readonly id: number;
	readonly delivery: "pending" | "terminal_output";
};

/** Result of one bounded {@link appendProcessSegment} call. */
interface ProcessSegmentAppendResult {
	readonly segments: readonly RenderSegment[];
	readonly bytes: number;
	readonly capped: boolean;
}

/**
 * Append `text` to the ordered segment timeline's retained process bytes, up
 * to {@link PROCESS_TEXT_HEAD_WINDOW_BYTES}. `bytes`/`capped` thread the
 * running retained-byte count and the once-latched head-window cut through
 * the reducer's otherwise-plain state — see the constant's own doc comment
 * for why this exists and what stays uncapped.
 */
function appendProcessSegment(
	segments: readonly RenderSegment[],
	nextId: number,
	bytes: number,
	capped: boolean,
	text: string,
	delivery: RenderSegment["delivery"],
	maxBytes: number = PROCESS_TEXT_HEAD_WINDOW_BYTES,
): ProcessSegmentAppendResult {
	if (capped) return { segments, bytes, capped };
	const remaining = maxBytes - bytes;
	const textBytes = byteLengthOf(text);
	const piece = textBytes <= remaining ? text : utf8PrefixWithin(text, remaining);
	const nextCapped = capped || textBytes > remaining;
	if (piece.length === 0) return { segments, bytes, capped: nextCapped };
	const pieceBytes = byteLengthOf(piece);
	const last = segments.at(-1);
	const nextSegments =
		last?.kind === "process" && last.delivery === delivery
			? [...segments.slice(0, -1), { ...last, text: last.text + piece }]
			: [...segments, { id: nextId, kind: "process" as const, text: piece, delivery }];
	return { segments: nextSegments, bytes: bytes + pieceBytes, capped: nextCapped };
}

function renderSegments(segments: readonly RenderSegment[]): string {
	return renderToolOutputSegments(segments);
}

function terminalSegmentPrefix(segments: readonly RenderSegment[], kind: ToolOutputSegment["kind"]): string {
	const previous = segments.at(-1);
	if (previous === undefined || (previous.kind === "process" && kind === "process")) return "";
	return outputSegmentSeparator(renderSegments(segments));
}

/** Reducer state. Channel is chosen at `started` and changed only by typed transitions. */
export type AcpToolViewState =
	| { readonly state: "unstarted" }
	| {
			readonly state: "plain";
			readonly call: ToolCallPresentation;
			readonly cursor: ByteOffset;
			readonly lastSequence: Sequence | undefined;
			readonly segments: readonly RenderSegment[];
			readonly nextSegmentId: number;
			/** Cumulative bytes retained across `segments`' "process" entries, up to {@link PROCESS_TEXT_HEAD_WINDOW_BYTES}. */
			readonly processTextBytes: number;
			/** Latched once the process-text head window fills; see {@link appendProcessSegment}. */
			readonly processTextCapped: boolean;
			/**
			 * Uncapped mirror of `segments`/`processTextBytes`/`nextSegmentId`.
			 * `reduceLiveTerminalAttached`'s one-shot catch-up frame is the ONLY
			 * delivery path for bytes buffered while a `plain` call had no live
			 * wire (`reduceAppend`'s `plain` arm emits no frame), so it must not
			 * read the capped `segments` above — that cap exists only to bound the
			 * settlement-snapshot replay in `buildReplacementSnapshotContent`,
			 * which stays capped by design and is the only
			 * other reader of `segments`.
			 *
			 * Only ever populated for `call.awaitsLiveTerminal === true` calls —
			 * the sole route `selectAcpToolRenderMode` ever sends a
			 * `live_terminal_attached` event to (bash's `client_terminal` route;
			 * see its own doc comment). Every other `plain` call (no negotiated
			 * terminal capability, or `kind !== "execute"`) stays `plain` for its
			 * entire lifetime and never reaches that catch-up frame, so
			 * `reduceAppend`/`reduceGap`/`reduceDisplayOutput` leave these three
			 * fields untouched for it — an unconditional mirror would grow
			 * unboundedly with nothing ever reading it.
			 */
			readonly rawSegments: readonly RenderSegment[];
			readonly rawNextSegmentId: number;
			readonly rawProcessTextBytes: number;
			readonly facts: readonly ToolFact[];
			readonly attachments: readonly ToolAttachment[];
			/**
			 * Producer-declared discontinuities (`terminal_gap`) accepted while
			 * plain. Their spans carry their own `stream_gap` receipts, so the
			 * attach transition must not claim them as delivered/suppressed
			 * stream bytes when it resolves the carried range.
			 */
			readonly gaps: readonly (readonly [from: ByteOffset, to: ByteOffset])[];
	  }
	| {
			readonly state: "meta_terminal";
			readonly call: ToolCallPresentation;
			readonly cap: TerminalMetaCap;
			readonly cursor: ByteOffset;
			readonly lastSequence: Sequence | undefined;
			readonly sourceEchoSent: boolean;
			readonly startedProgress: boolean;
			readonly segments: readonly RenderSegment[];
			readonly nextSegmentId: number;
			/** Cumulative bytes retained across `segments`' "process" entries, up to {@link PROCESS_TEXT_HEAD_WINDOW_BYTES}. */
			readonly processTextBytes: number;
			/** Latched once the process-text head window fills; see {@link appendProcessSegment}. */
			readonly processTextCapped: boolean;
			readonly facts: readonly ToolFact[];
			readonly attachments: readonly ToolAttachment[];
	  }
	| {
			readonly state: "live_terminal";
			readonly call: ToolCallPresentation;
			readonly terminalId: string;
			readonly metaCap: TerminalMetaCap | undefined;
			readonly cursor: ByteOffset;
			readonly lastSequence: Sequence | undefined;
			readonly facts: readonly ToolFact[];
			/**
			 * Attachments accepted in this mode have no byte form a client-owned
			 * terminal could replay, so each is suppressed with an explicit receipt —
			 * at acceptance time (see `reduceAttachment`), or at the transition that
			 * carried it here. Facts and bytes are resolved the same way: everything
			 * accepted before `live_terminal_attached` is delivered or explicitly
			 * suppressed at THAT transition (never at settlement), so no closing
			 * content snapshot ever replaces the live terminal item.
			 */
			readonly attachments: readonly ToolAttachment[];
	  }
	| { readonly state: "settled"; readonly call: ToolCallPresentation; readonly outcome: ToolOutcome };

/** Result of one reduction step. */
export interface AcpToolViewStep {
	readonly state: AcpToolViewState;
	readonly frames: readonly AcpToolFrame[];
	readonly receipts: readonly DeliveryReceipt[];
}

/** A violated stream invariant. Always a reducer/producer bug, never client data. */
export class AcpPresentationContinuityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcpPresentationContinuityError";
	}
}

/** Initial state. */
export const INITIAL_ACP_TOOL_VIEW: AcpToolViewState = { state: "unstarted" };

const TERMINAL_SEPARATOR = "─".repeat(48);

/** The one reduction step. Pure: no I/O, no wall-clock, no mutation of `state`. */
export function reduceAcpToolView(
	state: AcpToolViewState,
	event: ToolPresentationEvent,
	context: AcpRenderContext,
): AcpToolViewStep {
	switch (event.type) {
		case "started":
			return reduceStarted(state, event.call, context);
		case "terminal_append":
			return reduceAppend(state, event, context);
		case "terminal_gap":
			return reduceGap(state, event);
		case "live_terminal_attached":
			return reduceLiveTerminalAttached(state, event.binding.terminalId, context);
		case "fact":
			return reduceFact(state, event.fact, context);
		case "attachment":
			return reduceAttachment(state, event.attachment);
		case "display_output":
			return reduceDisplayOutput(state, event.display);
		case "settled":
			return reduceSettled(state, event.outcome, context);
		default: {
			const exhaustive: never = event;
			throw new Error(`Unhandled presentation event: ${JSON.stringify(exhaustive)}`);
		}
	}
}

function reduceStarted(
	state: AcpToolViewState,
	call: ToolCallPresentation,
	context: AcpRenderContext,
): AcpToolViewStep {
	if (state.state !== "unstarted") {
		throw new AcpPresentationContinuityError(`Tool call ${call.toolCallId} started twice (state=${state.state})`);
	}
	const changes = statusChanges([
		{ kind: "status", value: "pending" },
		{ kind: "title", value: call.title },
		{ kind: "tool_kind", value: toAcpToolKind(call.kind) },
		...(call.locations === undefined
			? []
			: [{ kind: "locations", value: call.locations.map(toFrameLocation) } as AcpStatusChange]),
	]);

	// Channel selection is one function shared with the rest of the ACP layer, so a
	// terminal-capable client cannot end up with a context that says one thing and a
	// reducer that picks another. A real client-owned terminal announces itself later
	// via `live_terminal_attached`, which transitions whichever mode was chosen.
	const route = selectAcpToolRenderMode(context, call);
	if (route.mode === "meta_terminal") {
		const cap = route.cap;
		return {
			state: {
				state: "meta_terminal",
				call,
				cap,
				cursor: 0 as ByteOffset,
				lastSequence: undefined,
				sourceEchoSent: false,
				startedProgress: false,
				segments: [],
				nextSegmentId: 1,
				processTextBytes: 0,
				processTextCapped: false,
				facts: [],
				attachments: [],
			},
			frames: [
				{
					channel: "terminal",
					toolCallId: call.toolCallId,
					announce: true,
					...(call.rawInput === undefined ? {} : { rawInput: call.rawInput }),
					content: [{ type: "terminal", terminalId: call.toolCallId }],
					...(changes === undefined ? {} : { changes }),
					meta: buildTerminalControlMeta(cap, {
						info: {
							terminal_id: call.toolCallId,
							...(call.cwd === undefined
								? context.cwd === undefined
									? {}
									: { cwd: context.cwd }
								: { cwd: call.cwd }),
						},
					}),
				},
			],
			receipts: [],
		};
	}

	const startContent = nonTerminalContent(
		call.sourceEcho === undefined ? [] : [{ type: "text", text: call.sourceEcho } as NonTerminalContent],
	);
	return {
		state: {
			state: "plain",
			call,
			cursor: 0 as ByteOffset,
			lastSequence: undefined,
			segments: [],
			nextSegmentId: 1,
			processTextBytes: 0,
			processTextCapped: false,
			rawSegments: [],
			rawNextSegmentId: 1,
			rawProcessTextBytes: 0,
			facts: [],
			attachments: [],
			gaps: [],
		},
		frames: [
			startContent === undefined
				? {
						channel: "status",
						toolCallId: call.toolCallId,
						announce: true,
						...(call.rawInput === undefined ? {} : { rawInput: call.rawInput }),
						changes: changes ?? [{ kind: "status", value: "pending" }],
					}
				: {
						channel: "content",
						toolCallId: call.toolCallId,
						announce: true,
						contentMode: "replacement_snapshot",
						...(call.rawInput === undefined ? {} : { rawInput: call.rawInput }),
						content: startContent,
						...(changes === undefined ? {} : { changes }),
					},
		],
		receipts: [],
	};
}

function reduceAppend(
	state: AcpToolViewState,
	event: Extract<ToolPresentationEvent, { type: "terminal_append" }>,
	context: AcpRenderContext,
): AcpToolViewStep {
	assertStreamContinuity(state, event.sequence, event.startByte);
	const nextByte = (event.startByte + byteLengthOf(event.data)) as ByteOffset;

	switch (state.state) {
		case "meta_terminal": {
			// The source echo rides the *first* payload for this terminal id and never
			// again — `eval`'s source has nowhere else to render once the frame carries
			// a terminal item. `bash`'s title is the command, so it sets no echo.
			const echo = !state.sourceEchoSent && state.call.sourceEcho !== undefined;
			const processPrefix = terminalSegmentPrefix(state.segments, "process");
			const data = echo
				? `${state.call.sourceEcho}\n${TERMINAL_SEPARATOR}\n${processPrefix}${event.data}`
				: `${processPrefix}${event.data}`;
			const changes = state.startedProgress ? undefined : statusChanges([{ kind: "status", value: "in_progress" }]);
			const appended = appendProcessSegment(
				state.segments,
				state.nextSegmentId,
				state.processTextBytes,
				state.processTextCapped,
				event.data,
				"terminal_output",
			);
			return {
				state: {
					...state,
					cursor: nextByte,
					lastSequence: event.sequence,
					sourceEchoSent: true,
					startedProgress: true,
					segments: appended.segments,
					processTextBytes: appended.bytes,
					processTextCapped: appended.capped,
					nextSegmentId:
						appended.segments.length > state.segments.length ? state.nextSegmentId + 1 : state.nextSegmentId,
				},
				frames: [
					{
						channel: "terminal_control",
						toolCallId: state.call.toolCallId,
						announce: false,
						...(changes === undefined ? {} : { changes }),
						meta: buildTerminalControlMeta(state.cap, {
							output: { terminal_id: state.call.toolCallId, data },
						}),
					},
				],
				receipts: [{ kind: "stream", fromByte: event.startByte, toByte: nextByte, channel: "terminal_output" }],
			};
		}
		case "live_terminal": {
			// The client's own terminal already received these bytes over
			// `terminal/output`; the reducer only tracks the cursor so later facts and
			// the exit frame stay correlated with the same stream identity.
			return {
				state: { ...state, cursor: nextByte, lastSequence: event.sequence },
				frames: [],
				receipts: [{ kind: "stream", fromByte: event.startByte, toByte: nextByte, channel: "terminal_output" }],
			};
		}
		case "plain": {
			// No terminal channel exists, so ordered segments accumulate and go out at
			// settlement. Adjacent process chunks coalesce without crossing a display.
			void context;
			const appended = appendProcessSegment(
				state.segments,
				state.nextSegmentId,
				state.processTextBytes,
				state.processTextCapped,
				event.data,
				"pending",
			);
			// Uncapped mirror — see the `rawSegments` field doc on the `plain` state.
			// Only worth building for a call that can actually reach
			// `reduceLiveTerminalAttached`'s catch-up frame (`awaitsLiveTerminal`);
			// every other plain-routed call (no negotiated terminal, or `kind !==
			// "execute"`) never receives that event and stays `plain` for its whole
			// lifetime, so an unconditional mirror would just grow unbounded with
			// nothing ever reading it.
			const rawAppended = state.call.awaitsLiveTerminal
				? appendProcessSegment(
						state.rawSegments,
						state.rawNextSegmentId,
						state.rawProcessTextBytes,
						false,
						event.data,
						"pending",
						Number.POSITIVE_INFINITY,
					)
				: undefined;
			return {
				state: {
					...state,
					cursor: nextByte,
					lastSequence: event.sequence,
					segments: appended.segments,
					processTextBytes: appended.bytes,
					processTextCapped: appended.capped,
					nextSegmentId:
						appended.segments.length > state.segments.length ? state.nextSegmentId + 1 : state.nextSegmentId,
					...(rawAppended === undefined
						? {}
						: {
								rawSegments: rawAppended.segments,
								rawProcessTextBytes: rawAppended.bytes,
								rawNextSegmentId:
									rawAppended.segments.length > state.rawSegments.length
										? state.rawNextSegmentId + 1
										: state.rawNextSegmentId,
							}),
				},
				frames: [],
				receipts: [{ kind: "stream", fromByte: event.startByte, toByte: nextByte, channel: "content" }],
			};
		}
		case "unstarted":
		case "settled":
			throw new AcpPresentationContinuityError(
				`terminal_append arrived while the view was ${state.state} (stream ${event.streamId})`,
			);
		default: {
			const exhaustive: never = state;
			throw new Error(`Unhandled view state: ${JSON.stringify(exhaustive)}`);
		}
	}
}

function reduceGap(
	state: AcpToolViewState,
	event: Extract<ToolPresentationEvent, { type: "terminal_gap" }>,
): AcpToolViewStep {
	assertStreamContinuity(state, event.sequence, event.fromByte);
	if (state.state !== "meta_terminal" && state.state !== "live_terminal" && state.state !== "plain") {
		throw new AcpPresentationContinuityError(`terminal_gap arrived while the view was ${state.state}`);
	}
	const dropped = event.toByte - event.fromByte;
	// A producer-*declared* discontinuity, with the exact byte range. This is the
	// only honest discontinuity notice: nothing here inferred it from text.
	const notice = `\n[terminal output discontinuity: ${dropped} bytes dropped before delivery]\n`;
	const receipts: readonly DeliveryReceipt[] = [
		{ kind: "stream_gap", fromByte: event.fromByte, toByte: event.toByte },
	];
	if (state.state === "meta_terminal") {
		const appended = appendProcessSegment(
			state.segments,
			state.nextSegmentId,
			state.processTextBytes,
			state.processTextCapped,
			notice,
			"terminal_output",
		);
		return {
			state: {
				...state,
				cursor: event.toByte,
				lastSequence: event.sequence,
				segments: appended.segments,
				processTextBytes: appended.bytes,
				processTextCapped: appended.capped,
				nextSegmentId:
					appended.segments.length > state.segments.length ? state.nextSegmentId + 1 : state.nextSegmentId,
			},
			frames: [
				{
					channel: "terminal_control",
					toolCallId: state.call.toolCallId,
					announce: false,
					meta: buildTerminalControlMeta(state.cap, {
						output: { terminal_id: state.call.toolCallId, data: notice },
					}),
				},
			],
			receipts,
		};
	}
	if (state.state === "plain") {
		const appended = appendProcessSegment(
			state.segments,
			state.nextSegmentId,
			state.processTextBytes,
			state.processTextCapped,
			notice,
			"pending",
		);
		// Uncapped mirror — see the `rawSegments` field doc on the `plain` state.
		// See `reduceAppend`'s matching guard: only a call that can actually reach
		// `reduceLiveTerminalAttached`'s catch-up frame needs this mirror built.
		const rawAppended = state.call.awaitsLiveTerminal
			? appendProcessSegment(
					state.rawSegments,
					state.rawNextSegmentId,
					state.rawProcessTextBytes,
					false,
					notice,
					"pending",
					Number.POSITIVE_INFINITY,
				)
			: undefined;
		return {
			state: {
				...state,
				cursor: event.toByte,
				lastSequence: event.sequence,
				segments: appended.segments,
				processTextBytes: appended.bytes,
				processTextCapped: appended.capped,
				nextSegmentId:
					appended.segments.length > state.segments.length ? state.nextSegmentId + 1 : state.nextSegmentId,
				...(rawAppended === undefined
					? {}
					: {
							rawSegments: rawAppended.segments,
							rawProcessTextBytes: rawAppended.bytes,
							rawNextSegmentId:
								rawAppended.segments.length > state.rawSegments.length
									? state.rawNextSegmentId + 1
									: state.rawNextSegmentId,
						}),
				gaps: [...state.gaps, [event.fromByte, event.toByte] as const],
			},
			frames: [],
			receipts,
		};
	}
	return {
		state: { ...state, cursor: event.toByte, lastSequence: event.sequence },
		frames: [],
		receipts,
	};
}
/**
 * The sub-spans of `[from, to)` that no producer-declared discontinuity
 * covers, in order. A plain-era cursor range can interleave appends with
 * declared gaps; the attach transition's stream receipts must claim only the
 * bytes that were actually appended, never the gap ranges whose delivery
 * state `stream_gap` receipts already record.
 */
function deliveredSpans(
	from: ByteOffset,
	to: ByteOffset,
	gaps: readonly (readonly [from: ByteOffset, to: ByteOffset])[],
): readonly (readonly [ByteOffset, ByteOffset])[] {
	const spans: (readonly [ByteOffset, ByteOffset])[] = [];
	let cursor = from;
	for (const [gapFrom, gapTo] of [...gaps].sort((a, b) => a[0] - b[0])) {
		if (gapFrom >= to || gapTo <= cursor) continue;
		if (gapFrom > cursor) spans.push([cursor, gapFrom]);
		cursor = gapTo > cursor ? gapTo : cursor;
		if (cursor >= to) return spans;
	}
	if (cursor < to) spans.push([cursor, to]);
	return spans;
}

function reduceLiveTerminalAttached(
	state: AcpToolViewState,
	terminalId: string,
	context: AcpRenderContext,
): AcpToolViewStep {
	if (state.state === "plain") {
		// From the same single source as the render mode. Hard-coding `undefined`
		// here suppressed every later fact as having "no capable channel" on a
		// client that had negotiated `_meta.terminal_output` alongside its own
		// terminal.
		const metaCap = terminalMetaCapOf(context.terminal);
		// Everything accepted while the view was plain resolves HERE, not at
		// settlement: pre-attach buffered bytes precede post-attach live bytes in
		// the client's terminal buffer, so ordering is preserved only at the
		// transition. `call.sourceEcho` is NOT replayed — the plain `started` frame
		// already delivered it as start content.
		const humanFacts = factsFor(state.facts, "human");
		// `rawSegments` is the uncapped mirror of `segments` — see its field doc.
		// This one-shot frame is the ONLY delivery path for bytes buffered while
		// plain (`reduceAppend`'s plain arm emits no frame), so it must read the
		// uncapped accumulator, never the settlement-bounded `segments`.
		const carriedData =
			renderSegments(state.rawSegments) + humanFacts.map(fact => `\n${renderFact(fact).text}\n`).join("");
		const frames: AcpToolFrame[] = [
			{
				channel: "terminal",
				toolCallId: state.call.toolCallId,
				announce: false,
				content: [{ type: "terminal", terminalId }],
				changes: [{ kind: "status", value: "in_progress" }],
			},
		];
		const receipts: DeliveryReceipt[] = [];
		// Declared gaps already carry their own `stream_gap` receipts; the
		// transition resolves only the byte spans that were actually appended.
		const carriedSpans = deliveredSpans(0 as ByteOffset, state.cursor, state.gaps);
		if (metaCap !== undefined && carriedData.length > 0) {
			frames.push({
				channel: "terminal_control",
				toolCallId: state.call.toolCallId,
				announce: false,
				meta: buildTerminalControlMeta(metaCap, {
					output: { terminal_id: terminalId, data: carriedData },
				}),
			});
			receipts.push(
				...carriedSpans.map(
					([fromByte, toByte]) => ({ kind: "stream", fromByte, toByte, channel: "terminal_output" }) as const,
				),
				...humanFacts.map(fact => ({ kind: "fact", factId: fact.id, channel: "terminal_output" }) as const),
			);
		} else {
			// No `_meta.terminal_output` witness (or nothing carried): record each
			// carried item's fate explicitly instead of silently dropping it.
			for (const fact of state.facts) {
				receipts.push(
					factsFor([fact], "human").length > 0
						? ({ kind: "fact_suppressed", factId: fact.id, reason: "no_capable_channel" } as const)
						: ({ kind: "fact_suppressed", factId: fact.id, reason: "audience_model_only" } as const),
				);
			}
			if (metaCap === undefined) {
				receipts.push(
					...carriedSpans.map(
						([fromByte, toByte]) =>
							({ kind: "stream_suppressed", fromByte, toByte, reason: "no_capable_channel" }) as const,
					),
				);
			}
		}
		// Attachments have no byte form a terminal can replay; they never ride
		// `_meta.terminal_output`, capable witness or not.
		for (const _attachment of state.attachments) {
			receipts.push({ kind: "attachment_suppressed", reason: "no_capable_channel" });
		}
		return {
			state: {
				state: "live_terminal",
				call: state.call,
				terminalId,
				metaCap,
				cursor: state.cursor,
				lastSequence: state.lastSequence,
				facts: [],
				attachments: [],
			},
			frames,
			receipts,
		};
	}
	if (state.state === "meta_terminal") {
		// A real terminal supersedes the display-only one: finalize the old id in its
		// own control frame so the two never sit in one content array.
		return {
			state: {
				state: "live_terminal",
				call: state.call,
				terminalId,
				metaCap: state.cap,
				cursor: state.cursor,
				lastSequence: state.lastSequence,
				facts: state.facts,
				attachments: state.attachments,
			},
			frames: [
				{
					channel: "terminal_control",
					toolCallId: state.call.toolCallId,
					announce: false,
					meta: buildTerminalControlMeta(state.cap, {
						exit: { terminal_id: state.call.toolCallId, exit_code: null, signal: null },
					}),
				},
				{
					channel: "terminal",
					toolCallId: state.call.toolCallId,
					announce: false,
					content: [{ type: "terminal", terminalId }],
					changes: [{ kind: "status", value: "in_progress" }],
				},
			],
			// Meta-terminal-era facts and segments already rode `terminal_output`
			// with their own receipts — nothing byte-shaped is carried undelivered.
			// Attachments accumulated on the display-only terminal have no byte form
			// a client-owned terminal could replay, so they are explicitly
			// suppressed here instead of vanishing silently at settlement.
			receipts: state.attachments.map(
				() => ({ kind: "attachment_suppressed", reason: "no_capable_channel" }) as const,
			),
		};
	}
	throw new AcpPresentationContinuityError(`live_terminal_attached arrived while the view was ${state.state}`);
}

function reduceFact(state: AcpToolViewState, fact: ToolFact, context: AcpRenderContext): AcpToolViewStep {
	const rendered = renderFact(fact);
	// The ACP wire is a human surface, so the central audience table decides whether
	// this fact belongs here at all. No built-in is model-only today; the branch exists
	// so a future model-only fact records an explicit typed suppression instead of
	// leaking onto a card.
	if (state.state !== "unstarted" && state.state !== "settled" && factsFor([fact], "human").length === 0) {
		return {
			state: { ...state, facts: [...state.facts, fact] },
			frames: [],
			receipts: [{ kind: "fact_suppressed", factId: fact.id, reason: "audience_model_only" }],
		};
	}
	switch (state.state) {
		case "meta_terminal": {
			// A terminal-bearing frame's `content` array is a dead letterbox for
			// anything but the terminal item, so a fact rides as extra
			// `_meta.terminal_output` bytes on the same terminal id. Zed's
			// `on_terminal_provider_event` writes them into whichever buffer owns the
			// id, display-only included.
			const data = `\n${rendered.text}\n`;
			const output: TerminalOutputMeta = { terminal_id: state.call.toolCallId, data };
			return {
				state: { ...state, facts: [...state.facts, fact] },
				frames: [
					{
						channel: "terminal_control",
						toolCallId: state.call.toolCallId,
						announce: false,
						meta: buildTerminalControlMeta(state.cap, { output }),
					},
				],
				receipts: [{ kind: "fact", factId: fact.id, channel: "terminal_output" }],
			};
		}
		case "live_terminal": {
			const metaCap = state.metaCap;
			if (metaCap === undefined) {
				// No channel can carry it right now: the client owns the terminal and
				// negotiated no terminal meta, and a sibling content item would be
				// dropped by the terminal renderer. Recorded as an explicit suppression
				// so the ledger can distinguish it from an accidental drop.
				return {
					state: { ...state, facts: [...state.facts, fact] },
					frames: [],
					receipts: [{ kind: "fact_suppressed", factId: fact.id, reason: "no_capable_channel" }],
				};
			}
			return {
				state: { ...state, facts: [...state.facts, fact] },
				frames: [
					{
						channel: "terminal_control",
						toolCallId: state.call.toolCallId,
						announce: false,
						meta: buildTerminalControlMeta(metaCap, {
							output: { terminal_id: state.terminalId, data: `\n${rendered.text}\n` },
						}),
					},
				],
				receipts: [{ kind: "fact", factId: fact.id, channel: "terminal_output" }],
			};
		}
		case "plain":
			// Facts accumulate and are delivered with the settlement content frame;
			// see `reduceSettled`. Streaming them separately would re-render the body.
			void context;
			return {
				state: { ...state, facts: [...state.facts, fact] },
				frames: [],
				receipts: [{ kind: "fact", factId: fact.id, channel: "content" }],
			};
		case "unstarted":
		case "settled":
			throw new AcpPresentationContinuityError(`fact arrived while the view was ${state.state}`);
		default: {
			const exhaustive: never = state;
			throw new Error(`Unhandled view state: ${JSON.stringify(exhaustive)}`);
		}
	}
}

function reduceAttachment(state: AcpToolViewState, attachment: ToolAttachment): AcpToolViewStep {
	if (state.state === "unstarted" || state.state === "settled") {
		throw new AcpPresentationContinuityError(`attachment arrived while the view was ${state.state}`);
	}
	// Accumulate only. An attachment on a meta-terminal call forces the explicit
	// `meta_terminal → content` transition, but that happens at settlement, where
	// the terminal's real exit status is known — emitting a synthetic early exit
	// would report an exit code nobody has yet.
	//
	// On a live terminal the client owns the card's single terminal item, and an
	// image/resource link has no byte form its buffer could replay — so the
	// attachment is accepted-and-suppressed with an explicit receipt rather than
	// silently dropped or allowed to erase the terminal item.
	const receipts: readonly DeliveryReceipt[] =
		state.state === "live_terminal" ? [{ kind: "attachment_suppressed", reason: "no_capable_channel" }] : [];
	return {
		state: { ...state, attachments: [...state.attachments, attachment] },
		frames: [],
		receipts,
	};
}

/**
 * Project structured display output into the appropriate channel.
 *
 * On a meta terminal, display text rides `terminal_output` data — the same
 * channel facts use — so it reaches a terminal-rendering client without
 * introducing a sibling content item. The text is the producer's own rendered
 * projection, so the wire and the model record never disagree.
 *
 * On plain, display groups join the ordered segment timeline and are delivered
 * at settlement with the same projection as process bytes.
 *
 * Display output does NOT advance the byte-stream cursor: it is not process
 * output and must not affect sequence/offset continuity assertions.
 */
function reduceDisplayOutput(state: AcpToolViewState, display: ToolDisplayOutput): AcpToolViewStep {
	if (state.state === "unstarted" || state.state === "settled") {
		throw new AcpPresentationContinuityError(`display_output arrived while the view was ${state.state}`);
	}
	const text = renderDisplayOutput(display);
	if (text.length === 0) {
		return { state, frames: [], receipts: [] };
	}
	switch (state.state) {
		case "meta_terminal": {
			// Source echo rides the first terminal delivery (append or display).
			// A display-only eval has no append, so the echo must precede the
			// display text — same rule as reduceAppend.
			const echo = !state.sourceEchoSent && state.call.sourceEcho !== undefined;
			const displayPrefix = terminalSegmentPrefix(state.segments, "display");
			const data = echo
				? `${state.call.sourceEcho}\n${TERMINAL_SEPARATOR}\n${displayPrefix}${text}`
				: `${displayPrefix}${text}`;
			return {
				state: {
					...state,
					segments: [
						...state.segments,
						{ id: state.nextSegmentId, kind: "display", display, delivery: "terminal_output" },
					],
					nextSegmentId: state.nextSegmentId + 1,
					sourceEchoSent: true,
				},
				frames: [
					{
						channel: "terminal_control",
						toolCallId: state.call.toolCallId,
						announce: false,
						meta: buildTerminalControlMeta(state.cap, {
							output: { terminal_id: state.call.toolCallId, data },
						}),
					},
				],
				receipts: [],
			};
		}
		case "live_terminal": {
			const metaCap = state.metaCap;
			if (metaCap === undefined) {
				return { state, frames: [], receipts: [] };
			}
			return {
				state,
				frames: [
					{
						channel: "terminal_control",
						toolCallId: state.call.toolCallId,
						announce: false,
						meta: buildTerminalControlMeta(metaCap, {
							output: { terminal_id: state.terminalId, data: text },
						}),
					},
				],
				receipts: [],
			};
		}
		case "plain":
			return {
				state: {
					...state,
					segments: [
						...state.segments,
						{ id: state.nextSegmentId, kind: "display", display, delivery: "pending" },
					],
					nextSegmentId: state.nextSegmentId + 1,
					// Display output was never subject to the process-text cap, so
					// this mirrors verbatim into the uncapped `rawSegments` too — see
					// its field doc on the `plain` state. Only worth building for a
					// call that can actually reach `reduceLiveTerminalAttached`'s
					// catch-up frame (`awaitsLiveTerminal`) — see `reduceAppend`'s
					// matching guard.
					...(state.call.awaitsLiveTerminal
						? {
								rawSegments: [
									...state.rawSegments,
									{ id: state.rawNextSegmentId, kind: "display", display, delivery: "pending" },
								],
								rawNextSegmentId: state.rawNextSegmentId + 1,
							}
						: {}),
				},
				frames: [],
				receipts: [],
			};
		default: {
			const exhaustive: never = state;
			throw new Error(`Unhandled view state: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/**
 * The `AcpToolDiagnostic` every settlement must carry on the frame that flips
 * the call's status (see `frames.ts` for the Zed compatibility audit that
 * requires a non-null `raw_output` on every completed/failed tool call:
 * without it Zed misclassifies refusals and truncates the visible turn).
 */
function settlementDiagnostic(call: ToolCallPresentation, outcome: ToolOutcome): AcpToolDiagnostic {
	return {
		kind: "tool_settlement",
		tool: call.toolName,
		outcome: outcome.kind === "succeeded" ? "completed" : "failed",
	};
}
/**
 * Settlement receipts for facts a closing content snapshot resolves: human-
 * audience facts ride the snapshot's text, model-only ones get the explicit
 * typed suppression instead of a false delivered-on-content receipt.
 */
function contentSnapshotReceipts(facts: readonly ToolFact[]): readonly DeliveryReceipt[] {
	return facts.map(fact =>
		factsFor([fact], "human").length > 0
			? ({ kind: "fact", factId: fact.id, channel: "content" } as const)
			: ({ kind: "fact_suppressed", factId: fact.id, reason: "audience_model_only" } as const),
	);
}

function reduceSettled(state: AcpToolViewState, outcome: ToolOutcome, context: AcpRenderContext): AcpToolViewStep {
	switch (state.state) {
		case "meta_terminal": {
			const statusChange = statusChangeForOutcome(outcome);
			if (state.attachments.length > 0) {
				// The explicit `meta_terminal → content` transition. Zed renders a
				// terminal-bearing call exclusively through the terminal, and an image
				// has no byte-stream equivalent — so the display-only terminal is
				// finalized in its own control frame and everything moves to content.
				const frames: AcpToolFrame[] = [];
				if (!state.sourceEchoSent && state.call.sourceEcho !== undefined) {
					frames.push({
						channel: "terminal_control",
						toolCallId: state.call.toolCallId,
						announce: false,
						meta: buildTerminalControlMeta(state.cap, {
							output: {
								terminal_id: state.call.toolCallId,
								data: `${state.call.sourceEcho}\n${TERMINAL_SEPARATOR}\n`,
							},
						}),
					});
				}
				frames.push({
					channel: "terminal_control",
					toolCallId: state.call.toolCallId,
					announce: false,
					changes: [statusChange],
					diagnostic: settlementDiagnostic(state.call, outcome),
					meta: buildTerminalControlMeta(state.cap, {
						exit: terminalExitForOutcome(state.call.toolCallId, outcome),
					}),
				});
				const content = buildReplacementSnapshotContent(state, outcome, context);
				if (content !== undefined) {
					frames.push({
						channel: "content",
						toolCallId: state.call.toolCallId,
						announce: false,
						contentMode: "replacement_snapshot",
						content,
					});
				} else {
					throw new AcpPresentationContinuityError("attachment transition produced no content");
				}
				return {
					state: { state: "settled", call: state.call, outcome },
					frames,
					receipts: contentSnapshotReceipts(state.facts),
				};
			}
			// Settlement status and `terminal_exit` are correlated state; they travel in
			// ONE frame so no client can observe a completed card above a still-running
			// terminal (or vice versa).
			//
			// Source echo is delivered exactly once in every render mode. On the
			// meta terminal it rides the first `terminal_append`; but a successful
			// no-output eval has no append, so the echo is prepended to the
			// settlement frame's terminal output here. This does NOT introduce a
			// terminal content sibling — the echo rides the same `terminal_output`
			// data as the exit notice, in the same frame as the exit, preserving the
			// one-terminal-item invariant.
			const exitNotice = renderExitNotice(outcome);
			// A call that failed before delivering a single byte has no body that
			// explains its failed status (the legacy tool_execution_end text is
			// suppressed for presentation calls): surface the bounded outcome
			// reason on the same settlement frame. A call that DID stream keeps
			// its own bytes as the explanation — a tool-reported failure's
			// message often is that body, and appending it again would duplicate it.
			const settlementNotice =
				exitNotice !== undefined ? exitNotice : state.cursor === 0 ? renderSettlementReason(outcome) : undefined;
			const echoPrefix =
				!state.sourceEchoSent && state.call.sourceEcho !== undefined
					? `${state.call.sourceEcho}\n${TERMINAL_SEPARATOR}\n`
					: "";
			const exitData = settlementNotice === undefined ? "" : `\n${settlementNotice}\n`;
			const settlementData = `${echoPrefix}${exitData}`;
			const output =
				settlementData.length === 0
					? undefined
					: ({ terminal_id: state.call.toolCallId, data: settlementData } as TerminalOutputMeta);
			return {
				state: { state: "settled", call: state.call, outcome },
				frames: [
					{
						channel: "terminal_control",
						toolCallId: state.call.toolCallId,
						announce: false,
						changes: [statusChange],
						diagnostic: settlementDiagnostic(state.call, outcome),
						meta: buildTerminalControlMeta(state.cap, {
							...(output === undefined ? {} : { output }),
							exit: terminalExitForOutcome(state.call.toolCallId, outcome),
						}),
					},
				],
				receipts: [],
			};
		}
		case "live_terminal": {
			// NEVER a content replacement here: the live terminal item IS the card's
			// content, and a snapshot would erase the item plus every byte displayed
			// after attachment (post-attach appends only advance the cursor — the
			// client's terminal already has those bytes). Everything accepted before
			// `live_terminal_attached` was delivered or explicitly suppressed at
			// that transition, so settlement carries only correlated status/exit
			// state in ONE frame.
			const metaCap = state.metaCap;
			return {
				state: { state: "settled", call: state.call, outcome },
				frames: [
					metaCap === undefined
						? {
								channel: "status",
								toolCallId: state.call.toolCallId,
								announce: false,
								changes: [statusChangeForOutcome(outcome)],
								diagnostic: settlementDiagnostic(state.call, outcome),
							}
						: {
								channel: "terminal_control",
								toolCallId: state.call.toolCallId,
								announce: false,
								changes: [statusChangeForOutcome(outcome)],
								diagnostic: settlementDiagnostic(state.call, outcome),
								meta: buildTerminalControlMeta(metaCap, {
									exit: terminalExitForOutcome(state.terminalId, outcome),
								}),
							},
				],
				receipts: [],
			};
		}
		case "plain": {
			const content = buildReplacementSnapshotContent(state, outcome, context);
			return {
				state: { state: "settled", call: state.call, outcome },
				frames: [
					content === undefined
						? {
								channel: "status",
								toolCallId: state.call.toolCallId,
								announce: false,
								changes: [statusChangeForOutcome(outcome)],
								diagnostic: settlementDiagnostic(state.call, outcome),
							}
						: {
								channel: "content",
								toolCallId: state.call.toolCallId,
								announce: false,
								contentMode: "replacement_snapshot",
								content,
								changes: [statusChangeForOutcome(outcome)],
								diagnostic: settlementDiagnostic(state.call, outcome),
							},
				],
				receipts: contentSnapshotReceipts(state.facts),
			};
		}
		case "unstarted":
			throw new AcpPresentationContinuityError("settled arrived before started");
		case "settled":
			throw new AcpPresentationContinuityError(`Tool call ${state.call.toolCallId} settled twice`);
		default: {
			const exhaustive: never = state;
			throw new Error(`Unhandled view state: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/**
 * ACP content updates are complete replacement snapshots. A transition away
 * from a display-only terminal therefore replays every ordered segment into
 * the snapshot exactly once, together with its attachments; terminal delivery
 * metadata determines that this is a replacement, never an additive body.
 */
function buildReplacementSnapshotContent(
	state: Extract<AcpToolViewState, { state: "plain" | "meta_terminal" }>,
	outcome: ToolOutcome,
	context: AcpRenderContext,
): NonEmptyArray<NonTerminalContent> | undefined {
	const sections: string[] = [];
	if (state.call.sourceEcho !== undefined) sections.push(state.call.sourceEcho);
	const body = renderSegments(state.segments);
	if (body.length > 0) sections.push(context.fence ? fenceBlock(body) : body);
	const factLines = factsFor(state.facts, "human")
		.map(fact => renderFact(fact).text)
		.filter(text => text.length > 0);
	if (state.processTextCapped) {
		factLines.push(
			renderFactText({
				kind: "truncation",
				meta: {
					direction: "head",
					totalBytes: state.cursor,
					retainedBytes: state.processTextBytes,
					truncatedBy: "bytes",
					maxBytes: PROCESS_TEXT_HEAD_WINDOW_BYTES,
				},
			}),
		);
	}
	const factText = factLines.join("\n");
	if (factText.length > 0) sections.push(factText);
	const exitNotice = renderExitNotice(outcome);
	if (exitNotice !== undefined) {
		sections.push(exitNotice);
	} else if (body.length === 0) {
		// No streamed body to explain a failed status — see reduceSettled's
		// meta-terminal settlement notice for the rationale and the duplication guard.
		const reason = renderSettlementReason(outcome);
		if (reason !== undefined) sections.push(reason);
	}

	const items: NonTerminalContent[] = [];
	if (sections.length > 0) items.push({ type: "text", text: sections.join("\n\n") });
	for (const attachment of state.attachments) {
		switch (attachment.kind) {
			case "image":
				items.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
				break;
			case "resource_link":
				items.push({
					type: "resource_link",
					uri: attachment.uri,
					name: attachment.name,
					...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
				});
				break;
			case "diff":
				items.push({
					type: "diff",
					path: attachment.path,
					oldText: attachment.oldText,
					newText: attachment.newText,
				});
				break;
			default: {
				const exhaustive: never = attachment;
				throw new Error(`Unhandled attachment: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	return nonTerminalContent(items);
}

function assertStreamContinuity(state: AcpToolViewState, seq: Sequence, startByte: ByteOffset): void {
	if (state.state === "unstarted" || state.state === "settled") return;
	if (state.lastSequence !== undefined && seq <= state.lastSequence) {
		throw new AcpPresentationContinuityError(
			`Presentation sequence went backwards for ${state.call.toolCallId}: ${state.lastSequence} then ${seq}`,
		);
	}
	if (startByte !== state.cursor) {
		throw new AcpPresentationContinuityError(
			`Presentation byte offset discontinuity for ${state.call.toolCallId}: expected ${state.cursor}, got ${startByte}`,
		);
	}
}

function toAcpToolKind(kind: ToolCallPresentation["kind"]): AcpToolKind {
	return kind;
}

function toFrameLocation(location: { readonly path: string; readonly line?: number }): {
	readonly path: string;
	readonly line?: number;
} {
	return location.line === undefined ? { path: location.path } : { path: location.path, line: location.line };
}
