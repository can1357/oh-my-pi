/**
 * The presentation event stream.
 *
 * Events are **deltas**, never cumulative snapshots: `terminal_append` carries
 * exactly the newly produced bytes with the absolute UTF-8 offset they start at.
 * That is what deletes the overlap/watermark class outright — continuity is a
 * declared property of the stream rather than something a consumer has to infer
 * from repeated text.
 *
 * Ownership: the **agent loop alone** emits `started` and `settled`. Tools get a
 * scoped producer handle (`ToolPresentationProducer`) which can only append,
 * declare facts, attach, and freeze. Duplicate settlement, append-after-settle
 * and missing settlement are therefore ownership errors rather than tool bugs.
 */

import type { ByteOffset, Sequence, StreamId } from "./brands";
import type { ToolFact } from "./facts";
import type { JsonValue } from "./json";
import type { ToolOutcome } from "./outcome";

/** ACP-ish tool classification, chosen once at `started`. */
export type ToolPresentationKind =
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

/** A file/range the call touches, in whatever form the producer knows it. */
export interface ToolPresentationLocation {
	readonly path: string;
	readonly line?: number;
}

/** The call descriptor. Owned by the surrounding execution record, not duplicated per event. */
export interface ToolCallPresentation {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly title: string;
	readonly kind: ToolPresentationKind;
	readonly locations?: readonly ToolPresentationLocation[];
	/**
	 * Source text to echo ahead of the stream, like a shell echoing the command
	 * it is about to run. `eval` needs this because its title is a short
	 * `[lang] label` and the source has nowhere else to render; `bash`'s title
	 * *is* the command, so it leaves this unset.
	 */
	readonly sourceEcho?: string;
	/** Working directory, when the call has one. */
	readonly cwd?: string;
	/**
	 * This call will attach a client-owned terminal after `started`. It must begin
	 * on the plain path so a display-only meta terminal is never announced before
	 * the real terminal id exists.
	 */
	readonly awaitsLiveTerminal?: boolean;
	/** Raw arguments for client-side inspection. An untyped boundary: `unknown`, never `any`. */
	readonly rawInput?: { readonly [key: string]: unknown };
}

/** Non-text output that cannot ride a byte stream. */
export type ToolAttachment =
	| { readonly kind: "image"; readonly data: string; readonly mimeType: string }
	| { readonly kind: "resource_link"; readonly uri: string; readonly name: string; readonly mimeType?: string }
	| {
			readonly kind: "diff";
			readonly path: string;
			readonly oldText: string | null;
			readonly newText: string | null;
	  };

/**
 * Structured human-visible output from an eval cell. The producer supplies
 * values and dimensions only; the central projection owns labels and layout.
 * Images remain typed attachments and never become text or base64.
 */
/** One structured human-visible value in an eval display sequence. */
export type ToolDisplayItem =
	| { readonly kind: "json"; readonly value: JsonValue }
	/** An untrusted backend value that cannot be represented as canonical JSON. */
	| { readonly kind: "invalid_json" }
	| {
			readonly kind: "image_dimensions";
			readonly originalWidth: number;
			readonly originalHeight: number;
			readonly width: number;
			readonly height: number;
	  };

/**
 * One ordered display group. Its projection assigns labels and separators;
 * producers provide values only.
 */
export type ToolDisplayOutput = { readonly kind: "sequence"; readonly items: readonly ToolDisplayItem[] };

declare const liveTerminalBindingBrand: unique symbol;

/**
 * A live, client-owned terminal.
 *
 * Deliberately branded and constructible only through
 * {@link createLiveTerminalBinding} (called by the client bridge), and
 * deliberately absent from every persisted schema: a terminal id from a previous
 * process is meaningless after `session/load`, so it must be impossible to
 * serialize one into a retained record.
 */
export interface LiveTerminalBinding {
	readonly terminalId: string;
	readonly [liveTerminalBindingBrand]: true;
}

/** Sole constructor for {@link LiveTerminalBinding}. */
export function createLiveTerminalBinding(terminalId: string): LiveTerminalBinding {
	if (terminalId.length === 0) throw new Error("LiveTerminalBinding requires a terminal id");
	return { terminalId } as LiveTerminalBinding;
}

/**
 * One presentation event.
 *
 * `terminal_gap` is first-class data, not a heuristic conclusion: only an
 * explicitly bounded presentation queue that actually dropped undelivered live
 * bytes may emit one, and it declares the exact missing byte range. Model/record
 * head-tail retention is **not** a gap — those raw chunks were already emitted
 * live, so retention produces a truncation *fact* on the retained record instead.
 */
export type ToolPresentationEvent =
	| { readonly type: "started"; readonly call: ToolCallPresentation }
	| {
			readonly type: "terminal_append";
			readonly streamId: StreamId;
			readonly sequence: Sequence;
			readonly startByte: ByteOffset;
			readonly data: string;
	  }
	| {
			readonly type: "terminal_gap";
			readonly streamId: StreamId;
			readonly sequence: Sequence;
			readonly fromByte: ByteOffset;
			readonly toByte: ByteOffset;
	  }
	| { readonly type: "live_terminal_attached"; readonly binding: LiveTerminalBinding }
	| { readonly type: "fact"; readonly fact: ToolFact }
	| { readonly type: "attachment"; readonly attachment: ToolAttachment }
	| { readonly type: "display_output"; readonly display: ToolDisplayOutput }
	| {
			readonly type: "settled";
			readonly outcome: ToolOutcome;
			/**
			 * The exact model-facing content this call contributed to LLM history,
			 * as the dispatcher's final post-`afterToolCall` result carried it.
			 *
			 * Supplied beside {@link ToolOutcome} for the same reason the outcome is:
			 * the agent loop owns settlement and already holds the authoritative
			 * value, so no consumer has to re-derive it. Re-deriving it from the
			 * retained presentation record is **not** equivalent — a client-owned
			 * terminal route streams no `terminal_append` at all (the client owns the
			 * bytes), and a capped/spilled result's model body is deliberately
			 * narrower than the bytes that went over the stream. The persisted frozen
			 * model projection needs the former, not a display
			 * reconstruction of the latter.
			 *
			 * Optional because a *reconstructed* event stream has no such authority to
			 * offer: `hydrate.ts`'s replay adapter and the ACP mapper's legacy
			 * compatibility adapters synthesize `settled` for the reducer, which never
			 * reads this field. Absent therefore means "not produced by the agent
			 * loop", never "the model saw nothing" — a consumer that needs the real
			 * content must treat absence as missing data, not as empty content.
			 */
			readonly modelContent?: readonly ToolModelContentBlock[];
	  };

/**
 * One model-facing content block.
 *
 * Structurally mirrors `TextContent`/`ImageContent` from `@oh-my-pi/pi-ai`
 * rather than importing them, for the same reason
 * `coding-agent/src/presentation/schemas/content.ts` mirrors them: this module
 * is the deliberately owned presentation boundary (its own strict
 * `tsconfig.presentation.json` project) and importing the provider-facing type
 * algebra into it would dissolve that boundary. Parity in both directions is
 * pinned by a type test, so a rename upstream fails the type check instead of
 * silently drifting.
 */
export type ToolModelContentBlock =
	| { readonly type: "text"; readonly text: string; readonly textSignature?: string }
	| {
			readonly type: "image";
			readonly data: string;
			readonly mimeType: string;
			readonly detail?: "auto" | "low" | "high" | "original";
	  };

/** Discriminant of {@link ToolPresentationEvent}. */
export type ToolPresentationEventType = ToolPresentationEvent["type"];

/** Sink the producer handle writes into. Owned by the dispatcher. */
export type ToolPresentationEmitter = (event: ToolPresentationEvent) => void;
