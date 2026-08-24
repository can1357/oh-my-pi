import type { SessionNotification, SessionUpdate, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import type {
	AcpStatusChange,
	AcpToolDiagnostic,
	AcpToolFrame,
	AcpToolKind,
	AcpToolStatus,
	NonTerminalContent,
} from "./frames";

/**
 * The tool-frame encoder — the only place an {@link AcpToolFrame} becomes an SDK
 * `SessionNotification`.
 *
 * Scope is deliberately narrow: this
 * encoder owns **tool** notifications. Assistant/thought chunks, plans,
 * configuration, session info and usage keep their existing typed SDK
 * construction and the general `#sendUpdate` path — the tool-frame encoder cannot
 * construct them, so widening the brand to all notifications would have made the
 * prohibition unsatisfiable rather than stronger.
 *
 * One deliberate behaviour change: `rawOutput` is never the tool's raw untyped
 * result **on this encoder's frames**. The old mapper put `rawOutput:
 * event.result` verbatim on every update, leaking the whole result object onto
 * the wire as a side channel; frames that pass through here can only ever carry
 * the bounded {@link AcpToolDiagnostic} below, never a raw result. But
 * `rawOutput` is an ACP-standard field a real client reads (Zed's
 * `acp_thread.rs` gates tool-output-refusal classification on
 * `raw_output.is_some()` for the completed call, and uses it as a last-resort
 * render when `content` is empty) — an intentional compatibility escape hatch
 * exists for exactly this. So a frame that settles a call may carry an
 * {@link AcpToolDiagnostic}, and only the encoder turns that into `rawOutput`;
 * every other frame omits the field entirely.
 *
 * Scope note: the permanently-`legacy_snapshot` mapper arms still send a
 * verbatim `rawOutput` through the generic `#sendUpdate` fallback. These are
 * reached only by external/MCP tools — command-named `bash`/`shell`/`exec`/
 * `eval`, or a result whose content carries a live terminal/rich resource_link
 * shape the frame union does not model (see the 2026-08-23 plan amendment).
 * Pre-v4 replay never reaches them: its dedicated builders send status and
 * content only (reachability corrected 2026-08-24). The "never a raw
 * pass-through" guarantee holds for every reduced/migrated frame, i.e. anything
 * encoded here; it does not hold on those legacy arms.
 */

declare const checkedToolNotificationBrand: unique symbol;

/**
 * A tool notification that provably came from {@link encodeToolFrame}.
 *
 * `AcpAgent#sendToolUpdate` accepts only this brand, so no hand-rolled tool
 * `SessionUpdate` can reach the wire.
 */
export interface CheckedToolNotification {
	readonly notification: SessionNotification;
	readonly [checkedToolNotificationBrand]: true;
}

/** The wire payload of a checked notification. */
export function checkedNotificationPayload(checked: CheckedToolNotification): SessionNotification {
	return checked.notification;
}

interface ScalarFields {
	status?: AcpToolStatus;
	title?: string;
	kind?: AcpToolKind;
	locations?: ToolCallLocation[];
}

function applyChanges(changes: readonly AcpStatusChange[] | undefined): ScalarFields {
	const fields: ScalarFields = {};
	for (const change of changes ?? []) {
		switch (change.kind) {
			case "status":
				fields.status = change.value;
				break;
			case "title":
				fields.title = change.value;
				break;
			case "tool_kind":
				fields.kind = change.value;
				break;
			case "locations":
				fields.locations = change.value.map(location => ({
					path: location.path,
					...(location.line === undefined ? {} : { line: location.line }),
				}));
				break;
			default: {
				const exhaustive: never = change;
				throw new Error(`Unhandled ACP status change: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	return fields;
}

function encodeNonTerminalContent(item: NonTerminalContent): ToolCallContent {
	switch (item.type) {
		case "text":
			return { type: "content", content: { type: "text", text: item.text } };
		case "image":
			return { type: "content", content: { type: "image", data: item.data, mimeType: item.mimeType } };
		case "audio":
			return { type: "content", content: { type: "audio", data: item.data, mimeType: item.mimeType } };
		case "resource_link":
			return {
				type: "content",
				content: {
					type: "resource_link",
					uri: item.uri,
					name: item.name,
					...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
				},
			};
		case "resource":
			return { type: "content", content: { type: "resource", resource: item.resource } };
		case "diff":
			return {
				type: "diff",
				path: item.path,
				oldText: item.oldText,
				newText: item.newText ?? "",
			};
		default: {
			const exhaustive: never = item;
			throw new Error(`Unhandled non-terminal content: ${JSON.stringify(exhaustive)}`);
		}
	}
}

function encodeMeta(frame: AcpToolFrame): { [key: string]: unknown } | undefined {
	if (frame.channel === "terminal" || frame.channel === "terminal_control") {
		const meta = frame.meta;
		if (meta === undefined) return undefined;
		const encoded: { [key: string]: unknown } = {};
		if (meta.info !== undefined) encoded.terminal_info = meta.info;
		if (meta.output !== undefined) encoded.terminal_output = meta.output;
		if (meta.exit !== undefined) encoded.terminal_exit = meta.exit;
		return Object.keys(encoded).length > 0 ? encoded : undefined;
	}
	const meta = frame.meta;
	if (meta === undefined) return undefined;
	const encoded: { [key: string]: unknown } = { ...meta };
	return Object.keys(encoded).length > 0 ? encoded : undefined;
}

function encodeContent(frame: AcpToolFrame): ToolCallContent[] | undefined {
	switch (frame.channel) {
		case "terminal":
			return [{ type: "terminal", terminalId: frame.content[0].terminalId }];
		case "content":
			return frame.content.map(encodeNonTerminalContent);
		case "terminal_control":
		case "status":
			return undefined;
		default: {
			const exhaustive: never = frame;
			throw new Error(`Unhandled ACP frame channel: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/**
 * Rebuild `rawOutput` as a fresh three-key literal from the frame's
 * diagnostic, rather than forwarding the caller's object by reference.
 *
 * `AcpToolDiagnostic`'s type alone does not enforce boundedness at this
 * boundary: TypeScript's excess-property check only fires at an object
 * literal's own construction site, not when a wider-but-assignable value
 * flows through a variable, so a frame built elsewhere could carry a
 * `diagnostic` with extra fields (e.g. a stray `content` key holding real
 * output) and still satisfy the type. Reading each field individually here,
 * rather than spreading or returning the object itself, makes the encoder —
 * not the type checker — the actual place that guarantees only these three
 * keys ever reach the wire, matching the "only the encoder may mint these
 * keys" invariant literally.
 */
function encodeDiagnostic(diagnostic: AcpToolDiagnostic): AcpToolDiagnostic {
	return { kind: diagnostic.kind, tool: diagnostic.tool, outcome: diagnostic.outcome };
}

/** Encode one frame into a branded tool notification. */
export function encodeToolFrame(sessionId: string, frame: AcpToolFrame): CheckedToolNotification {
	const fields = applyChanges(frame.changes);
	const content = encodeContent(frame);
	const meta = encodeMeta(frame);

	if (frame.announce) {
		// `tool_call` is the announcement; the ACP schema requires a title and a
		// kind on it, so a start frame that omitted either is a construction bug.
		if (fields.title === undefined || fields.kind === undefined) {
			throw new Error(`ACP tool_call announcement for ${frame.toolCallId} needs both a title and a kind`);
		}
		const update: SessionUpdate = {
			sessionUpdate: "tool_call",
			toolCallId: frame.toolCallId,
			title: fields.title,
			kind: fields.kind,
			status: fields.status ?? "pending",
			...(content === undefined ? {} : { content }),
			...(fields.locations === undefined ? {} : { locations: fields.locations }),
			// The call's own arguments; every reference agent echoes them.
			...(frame.rawInput === undefined ? {} : { rawInput: frame.rawInput }),
			// `rawOutput` is never the raw result — see the module doc and
			// `AcpToolDiagnostic`. Omitted unless this frame settles a call.
			...(frame.diagnostic === undefined ? {} : { rawOutput: encodeDiagnostic(frame.diagnostic) }),
			...(meta === undefined ? {} : { _meta: meta }),
		};
		return { notification: { sessionId, update } } as CheckedToolNotification;
	}

	if (content === undefined && meta === undefined && frame.changes === undefined && frame.diagnostic === undefined) {
		throw new Error(`ACP tool_call_update for ${frame.toolCallId} would change nothing`);
	}
	const update: SessionUpdate = {
		sessionUpdate: "tool_call_update",
		toolCallId: frame.toolCallId,
		...(fields.status === undefined ? {} : { status: fields.status }),
		...(fields.title === undefined ? {} : { title: fields.title }),
		...(fields.kind === undefined ? {} : { kind: fields.kind }),
		...(fields.locations === undefined ? {} : { locations: fields.locations }),
		...(content === undefined ? {} : { content }),
		...(frame.diagnostic === undefined ? {} : { rawOutput: encodeDiagnostic(frame.diagnostic) }),
		...(meta === undefined ? {} : { _meta: meta }),
	};
	return { notification: { sessionId, update } } as CheckedToolNotification;
}

/** Encode a whole frame batch, preserving order. */
export function encodeToolFrames(
	sessionId: string,
	frames: readonly AcpToolFrame[],
): readonly CheckedToolNotification[] {
	return frames.map(frame => encodeToolFrame(sessionId, frame));
}
