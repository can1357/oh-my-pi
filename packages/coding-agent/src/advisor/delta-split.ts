// Candidate 4 (multi-message split) pure renderer, extracted for direct unit
// testing. Renders an advisor delta as MULTIPLE user messages — one per source
// message — instead of one ever-growing user message, so the provider prompt
// cache can incrementally hit each appended message. Provider caches are
// prefix-based: a single user message whose text keeps growing invalidates the
// whole message on every turn, pinning cache_read at the instructions/tools
// boundary (observed 14491 in production, 11066 in tests). Splitting into
// per-source user messages grows cache_read with the session (verified
// experimentally: 11066 → 11091 → 11112).
//
// Each source message is rendered INDEPENDENTLY via formatSessionHistoryMarkdown
// in chunked mode (shared toolResultIndex + consumedToolCallIds + watchedRoleState
// over the WHOLE delta), so toolCall/toolResult pairings resolve across chunk
// boundaries and consecutive same-role collapsing is byte-identical to the old
// single-block render. Concatenating the chunk texts reproduces the old advisor
// context exactly (equivalence-tested).
//
// The heading stays on the FIRST chunk; the WIP marker stays on the LAST chunk
// (candidate 3) so a wip/final flip never changes the stable prefix.
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";

/**
 * Obfuscation surface the split renderer needs: a single text redaction pass.
 * Narrowed from the full SecretObfuscator class to the method actually
 * consumed, so tests can satisfy the contract with a typed helper instead of
 * an `as any` escape. A SecretObfuscator instance is structurally assignable.
 */
export interface AdvisorObfuscator {
	obfuscate(text: string, sharedRegexSecretValues?: ReadonlySet<string>): string;
}

/** Render options shared by the advisor single-block and multi-message paths. */
export const ADVISOR_RENDER_OPTIONS = {
	includeToolIntent: true,
	watchedRoles: true,
	expandPrimaryContext: true,
	expandEditDiffs: true,
} as const;

export interface RenderAdvisorDeltaChunksOptions {
	wip: boolean;
	includeThinking: boolean;
	obfuscator?: AdvisorObfuscator;
	advisorRegexSecretValues: ReadonlySet<string>;
}

export function renderAdvisorDeltaChunks(
	delta: AgentMessage[],
	opts: RenderAdvisorDeltaChunksOptions,
): AgentMessage[] | null {
	if (delta.length === 0) return null;

	const resultsByCallId = new Map<string, ToolResultMessage>();
	for (const msg of delta) {
		if (msg.role === "toolResult") resultsByCallId.set(msg.toolCallId, msg);
	}
	const consumed = new Set<string>();
	const watchedRoleState = { lastLabel: undefined as string | undefined };

	const renderChunk = (chunk: AgentMessage[]): string =>
		formatSessionHistoryMarkdown(chunk, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: opts.includeThinking,
			toolResultIndex: resultsByCallId,
			consumedToolCallIds: consumed,
			watchedRoleState,
		});

	const heading = "### Session update";
	// Concrete local chunk type: content blocks are minted here, so the WIP
	// marker append below is a plain field access (no double-cast).
	const chunks: { role: "user"; content: TextContent[]; timestamp: number }[] = [];
	for (let i = 0; i < delta.length; i++) {
		const text = renderChunk([delta[i]]);
		if (!text.trim()) continue;
		chunks.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}
	if (chunks.length === 0) return null;
	if (opts.obfuscator) {
		const fullText = chunks.map(chunk => chunk.content[0].text).join("\n");
		const individuallyObfuscated = chunks.map(chunk =>
			opts.obfuscator!.obfuscate(chunk.content[0].text, opts.advisorRegexSecretValues),
		);
		if (opts.obfuscator.obfuscate(fullText, opts.advisorRegexSecretValues) !== individuallyObfuscated.join("\n")) {
			return null;
		}
		for (let i = 0; i < chunks.length; i++) chunks[i].content[0].text = individuallyObfuscated[i];
	}
	chunks[0].content[0].text = `${heading}\n\n${chunks[0].content[0].text}`;
	if (chunks.length === 0) return null;
	if (opts.wip) {
		const last = chunks[chunks.length - 1];
		last.content[0].text += `\n\n---\n\n[in progress — more steps follow]`;
	}
	return chunks as AgentMessage[];
}
