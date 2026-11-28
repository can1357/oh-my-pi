import type { UsageResetCredit, UsageResetCreditDetail } from "@oh-my-pi/pi-ai";

/** One account row with its redeemable rate-limit reset credits. */
export interface ResetUsageAccount {
	label: string;
	provider: string;
	providerLabel: string;
	/** Banked resets, including grants that cannot be spent right now. */
	availableCount: number;
	/** Resets the provider currently permits this account to spend. */
	redeemableCount: number;
	target: {
		credentialId: number;
		provider: string;
		creditId?: string;
		accountId?: string;
		email?: string;
		orgId?: string;
	};
	active: boolean;
	error?: string;
	unavailableReason?: string;
	expiresAt?: string;
	credit?: UsageResetCreditDetail;
	/** Every banked credit on the account, spendable now or not. */
	credits?: readonly UsageResetCredit[];
	/** One line per banked credit: id, title, what it clears when the provider reports it, usability, expiry. */
	creditLines?: readonly string[];
	/**
	 * Set on a row that stands for one reset of an account whose resets clear different
	 * limits, so the user picks the reset type: its id, title, what it clears and whether
	 * it is offered next. Only the offered, usable reset can be confirmed, and that row
	 * carries its id in `target.creditId`.
	 */
	creditLine?: string;
}
