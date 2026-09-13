/**
 * User-facing wording for credentials the auth layer tore down on its own.
 *
 * `AuthStorage` soft-disables a credential when its OAuth grant dies
 * (`invalid_grant`, upstream invalidation, …) and emits `credential_disabled`;
 * without these notices a plain interactive or print session never mentions it
 * and the pool silently degrades to whatever sibling account remains.
 *
 * Every part of a notice except the fixed wording is provider-controlled text
 * (disable cause, email, organization): each part is bounded and the whole
 * line goes through the same display sanitizer as other startup warnings
 * before it reaches a renderer, whichever path renders it.
 */
import {
	type AuthStorage,
	type CredentialDisabledEvent,
	credentialAccountLabel,
	type DisabledCredentialSummary,
	summarizeDisableCause,
} from "@oh-my-pi/pi-ai";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, logger } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayWarning, TRUNCATE_LENGTHS } from "../tools/render-utils";

/**
 * Startup budget for the tombstone replay. A broker client otherwise inherits
 * the HTTP client's 10 s timeout plus a retry, and a stalled broker must not
 * hold every interactive or scripted start for that long.
 */
const REPLAY_LOOKUP_BUDGET_MS = 2_000;

/** Account label bounded like other TUI titles; the cause is already capped by `summarizeDisableCause`. */
function accountLabel(identity: Pick<DisabledCredentialSummary, "email" | "accountId" | "orgId" | "orgName">): string {
	return truncateToWidth(credentialAccountLabel(identity), TRUNCATE_LENGTHS.TITLE);
}

/** One-line warning for a credential torn down while this session was running. */
export function formatCredentialDisabledNotice(event: CredentialDisabledEvent): string {
	const account = event.credentialType === "api_key" ? "API key" : accountLabel(event);
	return sanitizeDisplayWarning(
		`Signed out of ${event.provider} ${account}: ${summarizeDisableCause(event.disabledCause)}. Sign in again with /login ${event.provider}.`,
	);
}

/** Startup replay for a tombstone the user has not acted on yet (see `AuthStorage.listActionableDisabledCredentials`). */
export function formatDisabledCredentialReplayNotice(summary: DisabledCredentialSummary, nowMs: number): string {
	const ago = summary.disabledAtMs !== undefined ? ` ${formatDuration(nowMs - summary.disabledAtMs)} ago` : "";
	return sanitizeDisplayWarning(
		`${summary.provider} ${accountLabel(summary)} was signed out${ago}: ${summarizeDisableCause(summary.cause)}. Sign in again with /login ${summary.provider}.`,
	);
}

/**
 * Notices for accounts that were signed out automatically and have not been
 * signed in again, replayed once when a session starts. Best-effort and
 * bounded: a broker that predates the tombstone endpoint, is unreachable, or
 * does not answer within {@link REPLAY_LOOKUP_BUDGET_MS} yields no notices
 * instead of delaying or breaking startup.
 */
export async function collectDisabledCredentialNotices(authStorage: AuthStorage, nowMs: number): Promise<string[]> {
	try {
		const disabled = await authStorage.listActionableDisabledCredentials(
			undefined,
			AbortSignal.timeout(REPLAY_LOOKUP_BUDGET_MS),
		);
		return disabled.map(summary => formatDisabledCredentialReplayNotice(summary, nowMs));
	} catch (error) {
		logger.debug("Disabled credential replay skipped", { error: String(error) });
		return [];
	}
}
