/**
 * User-facing wording for credentials the auth layer tore down on its own.
 *
 * `AuthStorage` soft-disables a credential when its OAuth grant dies
 * (`invalid_grant`, upstream invalidation, …) and emits `credential_disabled`;
 * without these notices a plain interactive or print session never mentions it
 * and the pool silently degrades to whatever sibling account remains.
 */
import {
	type AuthStorage,
	type CredentialDisabledEvent,
	credentialAccountLabel,
	type DisabledCredentialSummary,
	summarizeDisableCause,
} from "@oh-my-pi/pi-ai";
import { formatDuration, logger } from "@oh-my-pi/pi-utils";

/** One-line warning for a credential torn down while this session was running. */
export function formatCredentialDisabledNotice(event: CredentialDisabledEvent): string {
	const account = event.credentialType === "api_key" ? "API key" : credentialAccountLabel(event);
	return `Signed out of ${event.provider} ${account}: ${summarizeDisableCause(event.disabledCause)}. Sign in again with /login ${event.provider}.`;
}

/** Startup replay for a tombstone the user has not acted on yet (see `AuthStorage.listActionableDisabledCredentials`). */
export function formatDisabledCredentialReplayNotice(summary: DisabledCredentialSummary, nowMs: number): string {
	const ago = summary.disabledAtMs !== undefined ? ` ${formatDuration(nowMs - summary.disabledAtMs)} ago` : "";
	return `${summary.provider} ${credentialAccountLabel(summary)} was signed out${ago}: ${summarizeDisableCause(summary.cause)}. Sign in again with /login ${summary.provider}.`;
}

/**
 * Notices for accounts that were signed out automatically and have not been
 * signed in again, replayed once when a session starts. Best-effort: a broker
 * that predates the tombstone endpoint, or a failed listing, must not delay
 * or break startup.
 */
export async function collectDisabledCredentialNotices(authStorage: AuthStorage, nowMs: number): Promise<string[]> {
	try {
		const disabled = await authStorage.listActionableDisabledCredentials();
		return disabled.map(summary => formatDisabledCredentialReplayNotice(summary, nowMs));
	} catch (error) {
		logger.debug("Disabled credential replay skipped", { error: String(error) });
		return [];
	}
}
