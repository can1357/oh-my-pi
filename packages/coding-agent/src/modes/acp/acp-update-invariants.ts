/**
 * Wire-level postcondition checks for every outbound `session/update`.
 *
 * Three ACP invariants (the "Enforced invariants" table in
 * `docs/acp-development.md`) are properties of the *emitted frame*, not of any
 * one code path that builds it:
 *
 * 1. For a client that negotiated `clientCapabilities._meta.terminal_output`
 *    (Zed always does — `agent_servers/acp.rs:757`), a terminal-bearing
 *    `content` array renders exclusively through Zed's terminal card
 *    (`has_terminals` in `conversation_view/thread_view.rs`), silently
 *    dropping every sibling `content` item — so for that client the terminal
 *    item must be the array's only item. A client that hasn't negotiated the
 *    extension has no such renderer quirk (the ACP schema itself imposes no
 *    exclusivity — `docs/protocol/v1/tool-calls.mdx`), so the mapper's
 *    best-effort sibling-content fallback for that case is legitimate and
 *    exempt from this rule.
 * 2. A `_meta.terminal_*` key requires the negotiated capability above,
 *    unconditionally — an unnegotiated `_meta` extension is meaningless to
 *    every client.
 * 3. A frame must not claim `status: "completed"` while reporting a nonzero
 *    `_meta.terminal_exit.exit_code`: the card's status and its terminal's
 *    exit line are two derivations of the same result, and a user reads them
 *    together.
 *
 * All three were previously enforced by remembering to grep, which is why each
 * was rediscovered several times over in review: the violating shape usually
 * only exists after `content` arrays from different builders are merged
 * (`mergeToolUpdateContent`, image/notice spreads), or after two independent
 * derivations of the same fact drift apart, so no single source location is
 * wrong to look at. Checking the finished notification at the one
 * chokepoint every frame passes through (`AcpAgent`'s `#sendUpdate`) covers
 * dynamically assembled content, code paths not yet written, and frames the
 * mapper never produced — and makes every existing ACP test and `acp-probe`
 * run a regression test for all three rules at no authoring cost.
 *
 * The check never rewrites the frame: masking a violation on the wire would
 * hide the bug it exists to surface. Under `bun test` it throws; in a real
 * session it logs and lets the frame through, so a guard bug can never kill a
 * live connection.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { SessionNotification } from "@oh-my-pi/pi-utils/acp";

export interface AcpInvariantContext {
	/** `clientCapabilities._meta.terminal_output === true` for this connection. */
	terminalMetaCapable: boolean;
}

/** `_meta` keys belonging to Zed's display-only terminal extension. */
const TERMINAL_META_KEY = /^terminal_/;

let strict = process.env.NODE_ENV === "test";

/**
 * Throw instead of logging on a violation. On by default under `bun test`
 * (which sets `NODE_ENV=test`), so the existing ACP suites enforce both rules
 * without opting in individually.
 */
export function setStrictAcpInvariantsForTesting(value: boolean): void {
	strict = value;
}

export function getStrictAcpInvariantsForTesting(): boolean {
	return strict;
}

/**
 * Describe every invariant violation in `notification`, or an empty array when
 * it is well-formed. Pure — never mutates the notification.
 */
export function checkAcpUpdateInvariants(notification: SessionNotification, context: AcpInvariantContext): string[] {
	const update = notification.update;
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
		return [];
	}
	const violations: string[] = [];
	const toolCallId = update.toolCallId;
	const content = update.content;

	if (context.terminalMetaCapable && Array.isArray(content) && content.length > 1) {
		const terminalIds = content
			.filter(item => item?.type === "terminal")
			.map(item => (item.type === "terminal" ? item.terminalId : undefined));
		if (terminalIds.length > 0) {
			const siblings = content
				.filter(item => item?.type !== "terminal")
				.map(item =>
					item?.type === "content" ? `content/${item.content?.type ?? "unknown"}` : (item?.type ?? "unknown"),
				);
			violations.push(
				`tool call ${toolCallId} sends ${siblings.length} sibling content item(s) [${siblings.join(", ")}] ` +
					`alongside terminal item(s) [${terminalIds.join(", ")}] for a terminalMetaCapable client; Zed's ` +
					`has_terminals renders the terminal exclusively and drops the siblings. Deliver the extra facts as ` +
					`_meta.terminal_output bytes on the same terminal id instead.`,
			);
		}
	}

	if (!context.terminalMetaCapable && update._meta) {
		const ungated = Object.keys(update._meta).filter(key => TERMINAL_META_KEY.test(key));
		if (ungated.length > 0) {
			violations.push(
				`tool call ${toolCallId} emits ungated _meta key(s) [${ungated.join(", ")}]; the client never ` +
					`negotiated clientCapabilities._meta.terminal_output, so it must get the fenced-text fallback instead.`,
			);
		}
	}

	// A frame that reports a nonzero process exit while marking the call
	// `completed` contradicts itself: Zed renders the status from the tool call
	// and the exit line from the terminal, so the card shows a success check
	// above a terminal that says the command failed. Both are derived from the
	// same result (`isFailedToolResult`/`extractExitCode` in
	// `acp-event-mapper.ts`), so they can only disagree if one derivation is
	// taught about a producer's failure signal and the other isn't — exactly
	// how this shipped as a real bug: `eval` records a
	// nonzero exit only in `details`, so the frame claimed exit 0 and
	// `completed` for a failed cell. The reverse pairing is not checked:
	// `failed` with exit 0 is legitimate (a tool can fail for reasons the
	// process's own status code never expresses).
	if (update.sessionUpdate === "tool_call_update" && update.status === "completed") {
		const exitCode = terminalExitCode(update._meta);
		if (exitCode !== undefined && exitCode !== 0) {
			violations.push(
				`tool call ${toolCallId} reports _meta.terminal_exit.exit_code ${exitCode} with status "completed"; ` +
					`a nonzero process exit must be reported as status "failed" so the card and its terminal agree.`,
			);
		}
	}

	return violations;
}

/** `_meta.terminal_exit.exit_code`, when the frame carries one. */
function terminalExitCode(meta: unknown): number | undefined {
	if (typeof meta !== "object" || meta === null || !("terminal_exit" in meta)) return undefined;
	const exit = meta.terminal_exit;
	if (typeof exit !== "object" || exit === null || !("exit_code" in exit)) return undefined;
	return typeof exit.exit_code === "number" ? exit.exit_code : undefined;
}

/**
 * Report every violation in `notification`: throws under strict mode (tests),
 * logs otherwise. Callers emit the frame either way.
 */
export function assertAcpUpdateInvariants(notification: SessionNotification, context: AcpInvariantContext): void {
	const violations = checkAcpUpdateInvariants(notification, context);
	if (violations.length === 0) return;
	const message = `ACP update invariant violation: ${violations.join(" | ")}`;
	if (strict) {
		throw new Error(message);
	}
	logger.error(message, { sessionId: notification.sessionId });
}
