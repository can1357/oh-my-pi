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
import { redactUrlForLog } from "../mcp/json-rpc";
import { isManagedMCPOAuthCredentialId, mcpOAuthServerUrlFromCredentialId } from "../mcp/oauth-flow";
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

/**
 * The remedy is an executable command and `/login` matches its argument by
 * exact equality, so an id the title bound would cut is never advertised as
 * an argument; the argument-free selector reaches it instead.
 */
function loginRemedy(provider: string): string {
	return providerLabel(provider) === provider
		? `Sign in again with /login ${provider}.`
		: "Sign in again with /login and choose the provider.";
}

/**
 * What was signed out and how to get it back. A managed MCP OAuth credential
 * is stored under its own `mcp_oauth:*` id rather than a `/login` provider:
 * it is named by its server and recovered through `/mcp reauth`. The id keeps
 * the server URL's full query string, which can carry a key or token, so the
 * displayed URL goes through the same redaction as MCP request logging.
 */
function subjectAndRemedy(
	provider: string,
	credentialType: DisabledCredentialSummary["type"],
	identity: Pick<DisabledCredentialSummary, "email" | "accountId" | "orgId" | "orgName">,
): { subject: string; remedy: string } {
	if (isManagedMCPOAuthCredentialId(provider)) {
		const serverUrl = mcpOAuthServerUrlFromCredentialId(provider);
		return {
			subject: serverUrl
				? `MCP server ${truncateToWidth(redactUrlForLog(serverUrl), TRUNCATE_LENGTHS.TITLE)}`
				: "an MCP server",
			remedy: "Reauthorize it with /mcp reauth <name>.",
		};
	}
	const account = credentialType === "api_key" ? "API key" : accountLabel(identity);
	return { subject: `${providerLabel(provider)} ${account}`, remedy: loginRemedy(provider) };
}

/** One-line warning for a credential torn down while this session was running. */
export function formatCredentialDisabledNotice(event: CredentialDisabledEvent): string {
	const { subject, remedy } = subjectAndRemedy(event.provider, event.credentialType, event);
	return sanitizeDisplayWarning(`Signed out of ${subject}: ${causeSummary(event.disabledCause)}. ${remedy}`);
}

/** Startup replay for a tombstone the user has not acted on yet (see `AuthStorage.listActionableDisabledCredentials`). */
export function formatDisabledCredentialReplayNotice(summary: DisabledCredentialSummary, nowMs: number): string {
	const ago = summary.disabledAtMs !== undefined ? ` ${formatDuration(nowMs - summary.disabledAtMs)} ago` : "";
	const { subject, remedy } = subjectAndRemedy(summary.provider, summary.type, summary);
	return sanitizeDisplayWarning(`${subject} was signed out${ago}: ${causeSummary(summary.cause)}. ${remedy}`);
}

/**
 * Notices for accounts that were signed out automatically and have not been
 * signed in again, replayed once when a session starts. `announced` answers,
 * once the lookup has settled, whether a live `notice` already reached the
 * caller's listener for a credential — a teardown racing the lookup itself is
 * still told only once. Best-effort and bounded in time
 * and size: a broker that predates the tombstone endpoint, is unreachable, or
 * does not answer within {@link REPLAY_LOOKUP_BUDGET_MS} yields no notices
 * instead of delaying or breaking startup, and at most
 * {@link PREVIEW_LIMITS.COLLAPSED_ITEMS} accounts are named.
 */
export async function collectDisabledCredentialNotices(
	authStorage: AuthStorage,
	nowMs: number,
	announced: (credentialId: number) => boolean = () => false,
): Promise<string[]> {
	try {
		const disabled = (
			await authStorage.listActionableDisabledCredentials(undefined, AbortSignal.timeout(REPLAY_LOOKUP_BUDGET_MS))
		).filter(summary => !announced(summary.id));
		// Newest sign-out first, then bounded like other collapsed lists: the
		// account that just dropped out must be named, not the oldest leftovers;
		// `omp usage` has the full set.
		const notices = disabled
			.toSorted((a, b) => (b.disabledAtMs ?? 0) - (a.disabledAtMs ?? 0))
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
