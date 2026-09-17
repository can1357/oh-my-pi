/**
 * Shared helpers for the `/usage reset` command (TUI selector + ACP): turn the
 * live per-account reset-credit status into selector rows, and map a redeem
 * outcome code to a human message.
 */
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget } from "../../session/auth-storage";

export const CODEX_PROVIDER_ID = "openai-codex";

import type { ResetUsageAccount } from "@oh-my-pi/pi-tui/overlays/reset-usage-selector";

/**
 * Map live per-account reset status to selector rows. Sorted with the active
 * account first, then most-credits, then label.
 */
export function toResetUsageAccounts(statuses: ResetCreditAccountStatus[]): ResetUsageAccount[] {
	return statuses
		.map(status => ({
			label: status.email ?? status.accountId ?? "account",
			availableCount: status.availableCount,
			target: {
				credentialId: status.credentialId,
				accountId: status.accountId,
				email: status.email,
			} satisfies ResetCreditTarget,
			active: status.active,
			error: status.error,
		}))
		.sort((a, b) => {
			if (a.active !== b.active) return a.active ? -1 : 1;
			if (a.availableCount !== b.availableCount) return b.availableCount - a.availableCount;
			return a.label.localeCompare(b.label);
		});
}

/** Human-facing summary of a redeem outcome for status lines and ACP output. */
export function describeRedeemOutcome(outcome: ResetCreditRedeemOutcome, label: string): string {
	switch (outcome.code) {
		case "reset":
			return `Reset applied for ${label} — your rate-limit window has been refreshed.`;
		case "already_redeemed":
			return `${label}: that reset was already redeemed.`;
		case "no_credit":
			return `${label}: no saved resets available to spend.`;
		case "credit_list_failed":
			return `${label}: couldn't load this account's saved resets (network/auth) — nothing was spent, try again.`;
		case "nothing_to_reset":
			return `${label}: nothing to reset right now — your limits aren't constrained, so no credit was spent.`;
		case "no_account":
			return `Could not find a stored Codex account matching "${label}".`;
		case "account_unavailable":
			return `${label}: could not authenticate this account — try /login.`;
		default:
			return `${label}: reset did not apply (${outcome.code}).`;
	}
}
