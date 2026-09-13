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
	type CredentialAccountIdentity,
	type CredentialDisabledEvent,
	credentialAccountLabel,
	type DisabledCredentialSummary,
	isActionableCredentialDisable,
	summarizeDisableCause,
} from "@oh-my-pi/pi-ai";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, logger, pluralize, redactSecrets, redactUrlSecrets } from "@oh-my-pi/pi-utils";
import { isManagedMCPOAuthCredentialId, mcpOAuthServerUrlFromCredentialId } from "../mcp/oauth-flow";
import { PREVIEW_LIMITS, sanitizeDisplayWarning, TRUNCATE_LENGTHS } from "../tools/render-utils";

/**
 * Startup budget for the tombstone replay. A broker client otherwise inherits
 * the HTTP client's 10 s timeout plus a retry, and a stalled broker must not
 * hold every interactive or scripted start for that long.
 */
export const REPLAY_LOOKUP_BUDGET_MS = 2_000;

/** Account label bounded like other TUI titles. */
function accountLabel(
	identity: Pick<DisabledCredentialSummary, "email" | "accountId" | "projectId" | "orgId" | "orgName">,
): string {
	return truncateToWidth(credentialAccountLabel(identity), TRUNCATE_LENGTHS.TITLE);
}

/** Disable cause bounded like other previews; `summarizeDisableCause` already picks the human-sized clause. */
function causeSummary(cause: string): string {
	return truncateToWidth(summarizeDisableCause(cause), TRUNCATE_LENGTHS.CONTENT);
}

/** Provider ids come from the registry or an extension; bound them like titles too. */
function providerLabel(provider: string): string {
	return truncateToWidth(redactUrlSecrets(provider), TRUNCATE_LENGTHS.TITLE);
}

/**
 * The remedy is an executable command and `/login` matches its argument by
 * exact equality, so an id the title bound would cut, or the display
 * sanitizer would alter (a tab, a control character, a home path), is never
 * advertised as an argument; the argument-free selector reaches it instead.
 */
function loginRemedy(provider: string): string {
	return sanitizeDisplayWarning(providerLabel(provider)) === provider
		? `Sign in again with /login ${provider}.`
		: "Sign in again with /login and choose the provider.";
}

/**
 * What was signed out and how to get it back. A managed MCP OAuth credential
 * is stored under its own `mcp_oauth:*` id rather than a `/login` provider:
 * it is named by its server and recovered through `/mcp reauth`. The id keeps
 * the server URL's full query string, which can carry a key or token, so the
 * displayed URL goes through the same redaction as the auth and MCP logs.
 */
function subjectAndRemedy(
	provider: string,
	credentialType: DisabledCredentialSummary["type"],
	identity: Pick<DisabledCredentialSummary, "email" | "accountId" | "projectId" | "orgId" | "orgName">,
): { subject: string; remedy: string } {
	if (isManagedMCPOAuthCredentialId(provider)) {
		const serverUrl = mcpOAuthServerUrlFromCredentialId(provider);
		return {
			subject: serverUrl
				? `MCP server ${truncateToWidth(redactUrlSecrets(serverUrl), TRUNCATE_LENGTHS.TITLE)}`
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

export interface RetainedCredentialDisable {
	event: CredentialDisabledEvent;
	disabledAtMs: number;
}

/**
 * Merge actionable tombstones and retained events by credential id before applying
 * the shared newest-first preview limit. Read live announcement membership after
 * both lookups settle, so a disable racing replay is still told only once.
 * Tombstone lookup and fallback recovery share one startup deadline; unreachable
 * or older stores still allow retained events to be replayed.
 */
export async function collectDisabledCredentialNotices(
	authStorage: AuthStorage,
	nowMs: number,
	announced: (credentialId: number) => boolean = () => false,
	retained?: Map<number, RetainedCredentialDisable>,
): Promise<string[]> {
	const deadline = performance.now() + REPLAY_LOOKUP_BUDGET_MS;
	const disabled = new Map<number, DisabledCredentialSummary | RetainedCredentialDisable>();
	try {
		for (const summary of await authStorage.listActionableDisabledCredentials(
			undefined,
			AbortSignal.timeout(REPLAY_LOOKUP_BUDGET_MS),
		)) {
			disabled.set(summary.id, summary);
		}
	} catch (error) {
		logger.debug("Disabled credential replay skipped", { error: redactSecrets(String(error)) });
	}
	let needsFallback = false;
	if (retained) {
		for (const id of retained.keys()) {
			if (!disabled.has(id) && !announced(id)) {
				needsFallback = true;
				break;
			}
		}
	}
	if (retained && needsFallback) {
		// Empty tombstone listings skip revalidation. A sibling login can still
		// recover retained events; failed refresh cannot prove recovery from cache.
		const activeAccounts: CredentialAccountIdentity[] = [];
		const remainingMs = Math.ceil(deadline - performance.now());
		if (remainingMs > 0) {
			try {
				await authStorage.revalidateCredentials(AbortSignal.timeout(remainingMs));
				for (const [provider, value] of Object.entries(authStorage.getAll())) {
					for (const credential of Array.isArray(value) ? value : [value]) {
						if (credential.type !== "oauth") continue;
						const { type, email, accountId, projectId, orgId } = credential;
						activeAccounts.push({ provider, type, email, accountId, projectId, orgId });
					}
				}
			} catch {
				// Retain warnings rather than infer recovery from an unreachable store.
			}
		}
		for (const [id, notice] of retained) {
			if (disabled.has(id) || announced(id)) continue;
			disabled.set(id, notice);
		}
		// This refresh is newer than the tombstone lookup: a sibling login can
		// recover either source, including an account already in the stored set.
		for (const [id, notice] of disabled) {
			const summary =
				"event" in notice
					? { ...notice.event, id, type: notice.event.credentialType, cause: notice.event.disabledCause }
					: notice;
			if (!isActionableCredentialDisable(summary, activeAccounts)) {
				disabled.delete(id);
				retained.delete(id);
			}
		}
	}
	for (const id of disabled.keys()) {
		if (announced(id)) disabled.delete(id);
	}
	// Reverse insertion order breaks equal-timestamp ties in favor of the
	// latest retained event. Format only the accounts that will be displayed.
	const notices = [...disabled.values()]
		.reverse()
		.sort((a, b) => (b.disabledAtMs ?? 0) - (a.disabledAtMs ?? 0))
		.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS)
		.map(notice =>
			"event" in notice
				? formatCredentialDisabledNotice(notice.event)
				: formatDisabledCredentialReplayNotice(notice, nowMs),
		);
	const hidden = disabled.size - notices.length;
	if (hidden > 0) notices.push(`… ${hidden} more signed-out ${pluralize("account", hidden)}; see omp usage.`);
	return notices;
}
