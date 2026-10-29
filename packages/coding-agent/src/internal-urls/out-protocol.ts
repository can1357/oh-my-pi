/**
 * Protocol handler for `out://`: the agent's mid-turn reply channel.
 *
 * Markdown written to `out://` is shown to the user the way a response is shown,
 * without ending the agent's turn: it answers a question the user asked mid-task,
 * or posts a requested progress report, while work continues. Two transports:
 * - `write out://`: transcripts draw the call's `content` as assistant prose,
 *   streamed as the arguments arrive (`reply`-scoped writes).
 * - a shell redirect (`cmd > out://`): the shell filesystem hands the closed
 *   handle's text to the running tool, whose result carries it as a reply.
 *
 * The URL path is ignored and nothing is stored beyond the tool call, so the
 * scheme is write-only. On where it is {@link outRepliesActive} (by default the
 * top-level TUI session, terminal or Tern) and never for subagents.
 */
import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Settings } from "../config/settings";
import outPromptDoc from "../prompts/internal-urls/out.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { cfgOutEnabled } from "../tools/settings";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	SchemeHost,
	SchemeSpec,
	WriteContext,
} from "./types";

/** Largest reply `out://` accepts, in UTF-8 bytes. */
const MAX_REPLY_BYTES = 64 * 1024;
const DISABLED =
	"out:// is off in this session (`out.enabled`; by default on only in the interactive TUI); reply in your final message instead.";
const SUBAGENT = "Subagents cannot reply to the user through out://; report through your result instead.";

/**
 * Whether `out://` replies are on: an explicitly configured `out.enabled` wins; unset, they follow
 * `tuiTranscript` — on in the interactive TUI (terminal or Tern), off in print, RPC, ACP, and subagent
 * sessions, where no transcript draws them. Gates both the system-prompt entry and the writes.
 */
export function outRepliesActive(settings: Settings, tuiTranscript: boolean): boolean {
	return cfgOutEnabled.isConfigured(settings) ? cfgOutEnabled.get(settings) : tuiTranscript;
}

/** Why `session` may not reply through `out://`, or undefined when it may. */
function refusal(session: ToolSession | undefined): string | undefined {
	if (!session) return undefined;
	if ((session.taskDepth ?? 0) > 0) return SUBAGENT;
	if (!outRepliesActive(session.settings, session.tuiTranscript === true)) return DISABLED;
	return undefined;
}

/** Replies need no approval; sessions whose replies do not reach the user are refused at the gate. */
function replyTier(
	_url: InternalUrl,
	_content: string | undefined,
	session: ToolSession | undefined,
): ToolApprovalDecision {
	const reason = refusal(session);
	return reason ? { tier: "read", policy: "deny", reason } : "read";
}

export class OutProtocolHandler implements ProtocolHandler {
	readonly scheme = "out";
	readonly spec: SchemeSpec = {
		backing: "device",
		selectors: "none",
		immutable: true,
		write: { via: "handler", payload: "verbatim", scope: "reply", tier: replyTier, maxBytes: MAX_REPLY_BYTES },
	};

	/** Advertised only where replies reach the user; see {@link SchemeHost.outReplies}. */
	promptDoc(host: SchemeHost): string | undefined {
		return host.outReplies ? outPromptDoc.trim() : undefined;
	}

	async resolve(): Promise<InternalResource> {
		throw new ToolError(
			"out:// is write-only; reading it is not allowed. Write Markdown to it to show the user a reply.",
		);
	}

	/**
	 * Accept a reply; its transport draws it (see the module doc).
	 * @throws ToolError when replies are off for the caller ({@link outRepliesActive}) or it is a subagent, or the
	 *   content is blank or over 64 KiB.
	 */
	async write(_url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const reason = refusal(context?.session);
		if (reason) throw new ToolError(reason);
		if (content.trim().length === 0) throw new ToolError("out:// needs non-empty Markdown content.");
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_REPLY_BYTES) {
			throw new ToolError(
				`out:// replies are capped at ${MAX_REPLY_BYTES / 1024} KiB (got ${bytes} bytes); shorten it or split it up.`,
			);
		}
		return { content: [{ type: "text", text: "Shown to the user." }], useless: true };
	}
}
