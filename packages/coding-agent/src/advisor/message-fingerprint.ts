import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/**
 * Field-selective identity hash for an advisor-visible message.
 *
 * Hashes every top-level field the advisor renderer actually reads (mirrors
 * `AppendOnlyContextManager.#messageDigest`, issue #3406). Unrendered metadata
 * (timestamp, usage, provider internals, message id) churns on provider
 * round-trips and re-deliveries, so it is deliberately excluded: two messages
 * with the same rendered content hash equal even when their ids/timestamps
 * differ.
 *
 * Two consumers depend on this equality:
 * - {@link AdvisorRuntime} tracks the delivered-prefix identity so an
 *   equivalent clone does not trigger a full-transcript replay.
 * - {@link AdvisorTranscriptRecorder} skips re-persisting a replayed
 *   "session update" batch that carries no new content.
 *
 * Returns `undefined` when the payload cannot be serialized; callers treat that
 * as "no identity" and fall back to always delivering/persisting.
 */
export function fingerprintMessage(message: AgentMessage): bigint | undefined {
	try {
		// Rendered fields (from session-history-format.ts): role, content,
		// customType, display, isError, toolResult: cancelled/exitCode/output,
		// custom: details, plus the execution/branch/compaction/file-mention fields
		// the formatter reads: excludeFromContext, command (bashExecution), code
		// (pythonExecution), summary + fromId (branch/compaction), files
		// (fileMention).
		const m = message as unknown as Record<string, unknown>;
		const payload = JSON.stringify({
			r: m.role ?? null,
			c: m.content ?? null,
			toolCallId: m.toolCallId ?? null,
			toolName: m.toolName ?? null,
			err: m.isError ?? null,
			ct: m.customType ?? null,
			disp: m.display ?? null,
			cancel: m.cancelled ?? null,
			exit: m.exitCode ?? null,
			out: m.output ?? null,
			det: m.details ?? null,
			xfc: m.excludeFromContext ?? null,
			cmd: m.command ?? null,
			code: m.code ?? null,
			sum: m.summary ?? null,
			from: m.fromId ?? null,
			files: m.files ?? null,
		});
		if (payload === undefined) return undefined;
		return Bun.hash.wyhash(payload);
	} catch {
		return undefined;
	}
}
