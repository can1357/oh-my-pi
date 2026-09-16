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
	coalesceDisabledCredentialWarnings,
	type CredentialAccountIdentity,
	type CredentialDisabledEvent,
	credentialAccountLabel,
	type DisabledCredentialSummary,
	isActionableCredentialDisable,
	isAutomaticDisableCause,
	providerIdForDisplay,
	summarizeDisableCause,
} from "@oh-my-pi/pi-ai";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, pluralize } from "@oh-my-pi/pi-utils";
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
	return truncateToWidth(sanitizeDisplayWarning(credentialAccountLabel(identity)), TRUNCATE_LENGTHS.TITLE);
}

/** Disable cause bounded like other previews; `summarizeDisableCause` already picks the human-sized clause. */
function causeSummary(cause: string): string {
	return truncateToWidth(sanitizeDisplayWarning(summarizeDisableCause(cause)), TRUNCATE_LENGTHS.CONTENT);
}

/** Provider ids come from the registry or an extension; bound them like titles too. */
function providerLabel(provider: string): string {
	return truncateToWidth(sanitizeDisplayWarning(providerIdForDisplay(provider)), TRUNCATE_LENGTHS.TITLE);
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
				? `MCP server ${truncateToWidth(sanitizeDisplayWarning(providerIdForDisplay(serverUrl)), TRUNCATE_LENGTHS.TITLE)}`
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
	/**
	 * API-key rows of the provider that were live when the teardown was
	 * announced. An API key has no identity, so only a row outside this set is a
	 * replacement; an untouched sibling just means the pool lost a key.
	 */
	siblingApiKeyIds?: ReadonlySet<number>;
}

/**
 * Merge raw history and retained events under one startup deadline. Only a
 * supported history lookup can retire events whose rows were removed; OAuth
 * recovery filtering alone cannot prove physical absence (API keys are excluded).
 */
export async function collectDisabledCredentialNotices(
	authStorage: AuthStorage,
	nowMs: number,
	announced: (credentialId: number) => boolean = () => false,
	retained?: Map<number, RetainedCredentialDisable>,
): Promise<string[]> {
	const deadline = performance.now() + REPLAY_LOOKUP_BUDGET_MS;
	const signal = AbortSignal.timeout(REPLAY_LOOKUP_BUDGET_MS);
	const retainedAtStart = retained?.size ? new Map(retained) : undefined;
	const disabled = new Map<number, DisabledCredentialSummary | RetainedCredentialDisable>();
	// Store hooks may ignore cancellation, so the signal alone cannot bound
	// replay. One revalidated read covers both stored and retained notices;
	// with nothing retained, clean history skips the broker round-trip.
	const revalidated = await authStorage.readRevalidatedDisabledHistory({
		signal,
		deadlineMs: deadline,
		requireSupported: true,
		skipRefreshWhenEmpty: !retained?.size,
	});
	const history = revalidated.history;
	// Stored history may predate the refresh when the post-refresh read failed;
	// matching it against refreshed identities could hide a newer sign-out that
	// read never returned. Retained in-memory notices still use the fresh pool.
	let storedHistoryAccounts: CredentialAccountIdentity[] = [];
	let activeAccounts: CredentialAccountIdentity[] = [];
	let liveApiKeys: Map<string, Set<number>> | undefined;
	if (revalidated.revalidated) {
		// A failed refresh cannot prove recovery from cached credentials.
		activeAccounts = revalidated.activeAccounts;
		if (revalidated.historyRechecked) storedHistoryAccounts = revalidated.activeAccounts;
		liveApiKeys = new Map();
		for (const { provider, credential, id } of authStorage.listStoredCredentials()) {
			if (credential.type !== "api_key") continue;
			const ids = liveApiKeys.get(provider);
			if (ids) ids.add(id);
			else liveApiKeys.set(provider, new Set([id]));
		}
	}
	if (history && retained && retainedAtStart) {
		const automaticIds = new Set<number>();
		for (const summary of history) {
			if (isAutomaticDisableCause(summary.cause)) automaticIds.add(summary.id);
		}
		for (const [id, notice] of retainedAtStart) {
			// A history query cannot disprove an event inserted or replaced while it ran.
			if (automaticIds.has(id) || retained.get(id) !== notice) continue;
			// An API-key sign-out is only ambiguous while a live key for that provider
			// exists: re-saving any sibling purges every API-key tombstone, so the
			// row's absence proves nothing and the sibling-aware check below must
			// decide. With no live key left there is nothing that could have purged
			// it, so history is authoritative — a provider logout or retention
			// expiry retires the notice here as it does for OAuth.
			// `liveApiKeys` is undefined when revalidation failed, which is not the
			// same as "no live key": an unknown pool cannot prove the tombstone's
			// absence is authoritative, so the notice stays. Same doctrine as the
			// refresh check above — a failed read never proves recovery.
			if (
				notice.event.credentialType === "api_key" &&
				(liveApiKeys === undefined || (liveApiKeys.get(notice.event.provider)?.size ?? 0) > 0)
			) {
				continue;
			}
			retained.delete(id);
		}
	}
	for (const summary of history ?? []) {
		if (isActionableCredentialDisable(summary, storedHistoryAccounts)) disabled.set(summary.id, summary);
	}
	if (retained) {
		// Read after the final await and preserve new/replaced events even when the
		// in-flight snapshot still contains the credential that was just disabled.
		for (const [id, notice] of retained) {
			const unchanged = retainedAtStart?.get(id) === notice;
			if (unchanged && liveApiKeys) {
				const event = notice.event;
				// An API key carries no identity, so only a key outside the set that
				// was live at teardown proves replacement. Without that set a
				// pre-existing sibling proves nothing — inferring recovery from it
				// would delete the warning for a key nobody replaced.
				const siblingsAtTeardown = notice.siblingApiKeyIds;
				const recovered =
					event.credentialType === "api_key"
						? siblingsAtTeardown !== undefined &&
							[...(liveApiKeys.get(event.provider) ?? [])].some(
								liveId => liveId !== id && !siblingsAtTeardown.has(liveId),
							)
						: !isActionableCredentialDisable(
								{
									...event,
									id,
									type: event.credentialType,
									cause: event.disabledCause,
									disabledAtMs: notice.disabledAtMs,
								},
								activeAccounts,
							);
				if (recovered) {
					disabled.delete(id);
					retained.delete(id);
					continue;
				}
			}
			if (!unchanged || !disabled.has(id)) disabled.set(id, notice);
		}
	}
	// Coalesce only the display projection, after raw-history authority and
	// racing retained events have settled. Keep all forensic/event state intact.
	const warnings = coalesceDisabledCredentialWarnings(
		[...disabled].map(([id, notice]) =>
			"event" in notice
				? {
						...notice.event,
						id,
						type: notice.event.credentialType,
						cause: notice.event.disabledCause,
						disabledAtMs: notice.disabledAtMs,
					}
				: notice,
		),
	).filter(summary => !announced(summary.id));
	// Newest disables first, with reverse insertion order breaking timestamp ties.
	// Format only the accounts that will be displayed.
	const notices = warnings
		.reverse()
		.sort((a, b) => (b.disabledAtMs ?? 0) - (a.disabledAtMs ?? 0))
		.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS)
		.map(summary => {
			const notice = disabled.get(summary.id)!;
			return "event" in notice
				? formatCredentialDisabledNotice(notice.event)
				: formatDisabledCredentialReplayNotice(notice, nowMs);
		});
	const hidden = warnings.length - notices.length;
	if (hidden > 0) notices.push(`… ${hidden} more signed-out ${pluralize("account", hidden)}; see omp usage.`);
	return notices;
}
