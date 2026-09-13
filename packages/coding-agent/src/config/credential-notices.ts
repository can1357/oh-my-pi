/**
 * User-facing wording for credentials the auth layer tore down on its own.
 *
 * `AuthStorage` soft-disables a credential when its OAuth grant dies
 * (`invalid_grant`, upstream invalidation, …) and emits `credential_disabled`;
 * without these notices a plain interactive or print session never mentions it
 * and the pool silently degrades to whatever sibling account remains.
 *
 * Every part of a notice except the fixed wording is provider-controlled text
 * (disable cause, email, organization): each part is bounded with the shared
 * `TRUNCATE_LENGTHS` limits — the fixed remedy at the end is never cut — and
 * the whole line goes through the same display sanitizer as other startup
 * warnings before it reaches a renderer, whichever path renders it.
 */
import {
	type AuthStorage,
	type CredentialDisabledEvent,
	credentialAccountLabel,
	type DisabledCredentialSummary,
	summarizeDisableCause,
} from "@oh-my-pi/pi-ai";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, logger, pluralize } from "@oh-my-pi/pi-utils";
import { PREVIEW_LIMITS, sanitizeDisplayWarning, TRUNCATE_LENGTHS } from "../tools/render-utils";

/**
 * Startup budget for the tombstone replay. A broker client otherwise inherits
 * the HTTP client's 10 s timeout plus a retry, and a stalled broker must not
 * hold every interactive or scripted start for that long.
 */
const REPLAY_LOOKUP_BUDGET_MS = 2_000;

/** Account label bounded like other TUI titles. */
function accountLabel(identity: Pick<DisabledCredentialSummary, "email" | "accountId" | "orgId" | "orgName">): string {
	return truncateToWidth(credentialAccountLabel(identity), TRUNCATE_LENGTHS.TITLE);
}

/** Disable cause bounded like other previews; `summarizeDisableCause` already picks the human-sized clause. */
function causeSummary(cause: string): string {
	return truncateToWidth(summarizeDisableCause(cause), TRUNCATE_LENGTHS.CONTENT);
}

/** Provider ids come from the registry or an extension; bound them like titles too. */
function providerLabel(provider: string): string {
	return truncateToWidth(provider, TRUNCATE_LENGTHS.TITLE);
}

/** One-line warning for a credential torn down while this session was running. */
export function formatCredentialDisabledNotice(event: CredentialDisabledEvent): string {
	const account = event.credentialType === "api_key" ? "API key" : accountLabel(event);
	const provider = providerLabel(event.provider);
	return sanitizeDisplayWarning(
		`Signed out of ${provider} ${account}: ${causeSummary(event.disabledCause)}. Sign in again with /login ${provider}.`,
	);
}

/** Startup replay for a tombstone the user has not acted on yet (see `AuthStorage.listActionableDisabledCredentials`). */
export function formatDisabledCredentialReplayNotice(summary: DisabledCredentialSummary, nowMs: number): string {
	const ago = summary.disabledAtMs !== undefined ? ` ${formatDuration(nowMs - summary.disabledAtMs)} ago` : "";
	const provider = providerLabel(summary.provider);
	return sanitizeDisplayWarning(
		`${provider} ${accountLabel(summary)} was signed out${ago}: ${causeSummary(summary.cause)}. Sign in again with /login ${provider}.`,
	);
}

/**
 * Notices for accounts that were signed out automatically and have not been
 * signed in again, replayed once when a session starts. Best-effort and
 * bounded in time and size: a broker that predates the tombstone endpoint,
 * is unreachable, or does not answer within {@link REPLAY_LOOKUP_BUDGET_MS}
 * yields no notices instead of delaying or breaking startup, and at most
 * {@link PREVIEW_LIMITS.COLLAPSED_ITEMS} accounts are named.
 */
export async function collectDisabledCredentialNotices(authStorage: AuthStorage, nowMs: number): Promise<string[]> {
	try {
		const disabled = await authStorage.listActionableDisabledCredentials(
			undefined,
			AbortSignal.timeout(REPLAY_LOOKUP_BUDGET_MS),
		);
		// Bounded like other collapsed lists: `omp usage` has the full set.
		const notices = disabled
			.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS)
			.map(summary => formatDisabledCredentialReplayNotice(summary, nowMs));
		const hidden = disabled.length - notices.length;
		if (hidden > 0) notices.push(`… ${hidden} more signed-out ${pluralize("account", hidden)}; see omp usage.`);
		return notices;
	} catch (error) {
		logger.debug("Disabled credential replay skipped", { error: String(error) });
		return [];
	}
}
