import type { UsageResetCreditDetail } from "@oh-my-pi/pi-ai";

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
}
